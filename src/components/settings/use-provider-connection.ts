"use client";

/**
 * One hook owns everything chrome around a Google or Microsoft connection: the status load,
 * the sign-in return, Connect, and Disconnect. A page renders from `status` — or, for a page
 * whose server already knows it, from its own prop — and never touches
 * `history.replaceState` or a `?google=`/`?outlook=` param itself.
 *
 * ## Why one owner
 *
 * Google's consent screen comes back with `?google=connected` (Gmail's own entry points get
 * `?gmail=` too — the callback sets both); Microsoft's comes back with `?outlook=connected`.
 * Whoever notices it has to toast the outcome, strip the param with `history.replaceState`,
 * and re-read the connection status — a Next router "restore" (which `replaceState` produces)
 * drops any server action still queued, including the status fetch this hook itself fired a
 * moment ago on mount, without ever settling it.
 *
 * If TWO components on the same page each watch that param and each strip it, they race:
 * whichever calls `history.replaceState` first wins, and the loser's own queued status
 * re-read is dropped by that restore, leaving it stuck. `src/components/settings/
 * integrations-gmail-tab.tsx`'s `awaitingStrip` gate exists only because of that race — it
 * defers `GmailTab`'s own load until the Google Contacts card, mounted beside it on the same
 * Settings page, has already stripped the params, so the panel below mounts with them already
 * gone. A later task deletes that gate; the fix is for a page to hand the whole job to one
 * hook instance instead of two components each half-owning it.
 *
 * ## `enabled: false`
 *
 * `GmailImportPanel` and `OutlookImportPanel` are handed `connection` as a prop by a server
 * page (`/recruiters`, or `GmailTab` in Settings) and never fetch it themselves. Passing
 * `enabled: false` skips the load — this hook's own `status`/`loading`/`failed` simply go
 * unused, and the caller renders from its prop instead. Connect, Disconnect and the OAuth
 * return still run: the OAuth return re-reads the status regardless, to name the address in
 * the "Switched to…" toast, and Disconnect's `router.refresh()` is what actually refreshes
 * the prop.
 *
 * ## Behaviour
 *
 * 1. **Load** — fetches the status on mount when `enabled !== false`. `loading` until the
 *    first settle; a rejection sets `failed` (cleared by `retry()`) instead of leaving the
 *    caller to guess why `status` never arrived.
 * 2. **OAuth return** — reads the provider's outcome param, toasts success or
 *    `describeOAuthReason(reason, provider, purpose)`, then strips it — along with `switched`,
 *    `reason`, `purpose`, and for Google the `gmail` twin — with `history.replaceState`.
 * 3. **Switched-account toast** — when `switched=1` rode along, the plain "connected" toast is
 *    skipped, and once the status re-read below resolves, "Switched to <email>" fires instead
 *    — so the address named is the one that is actually current, not the one it replaced.
 * 4. **Connect** — starts the provider's OAuth with the given purposes (default: that
 *    provider's `*_CONNECT_PURPOSES`) and navigates to the result; a failure toasts
 *    `TOAST_COPY.connectFailed`. `busy` covers the round trip.
 * 5. **Disconnect** — calls the provider's disconnect action, toasts the outcome, refreshes
 *    the server data (`router.refresh()`), and re-reads the status.
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  disconnectGmail,
  getGmailConnectionStatus,
  startGmailOAuth,
  type GmailConnectionStatus,
} from "@/actions/gmail";
import {
  disconnectOutlook,
  getOutlookConnectionStatus,
  startOutlookOAuth,
  type OutlookConnectionStatus,
} from "@/actions/outlook";
import { GOOGLE_CONNECT_PURPOSES, type GooglePurpose } from "@/lib/google-scopes";
import { MICROSOFT_CONNECT_PURPOSES, type MicrosoftPurpose } from "@/lib/microsoft-scopes";
import { describeOAuthReason, friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

type ConnectionBase<Status> = {
  status: Status | null;
  loading: boolean;
  failed: boolean;
  busy: boolean;
  retry: () => void;
  refresh: () => void;
  disconnect: (opts: { alsoDelete: boolean }) => void;
};

export type GoogleConnection = ConnectionBase<GmailConnectionStatus> & {
  kind: "google";
  connect: (purposes?: readonly GooglePurpose[]) => void;
};

export type MicrosoftConnection = ConnectionBase<OutlookConnectionStatus> & {
  kind: "microsoft";
  connect: (purposes?: readonly MicrosoftPurpose[]) => void;
};

/** The Google callback always sets `gmail` alongside `google`; Microsoft has no twin. */
const GOOGLE_EXTRA_STRIP_KEYS: readonly string[] = ["gmail"];
const MICROSOFT_EXTRA_STRIP_KEYS: readonly string[] = [];

function useConnection<Status extends { emailAddress: string | null }, Purpose extends string>({
  returnTo,
  enabled = true,
  oauthParam,
  extraStripKeys,
  label,
  deletedDataSuffix,
  defaultPurposes,
  getStatus,
  startOAuth,
  disconnectAction,
}: {
  returnTo: string;
  enabled?: boolean;
  oauthParam: string;
  extraStripKeys: readonly string[];
  label: string;
  /** Appended after `label` when a disconnect also deletes data. Outlook never does. */
  deletedDataSuffix?: string;
  defaultPurposes: readonly Purpose[];
  getStatus: () => Promise<Status>;
  startOAuth: (input: { purposes: readonly Purpose[]; returnTo?: string }) => Promise<{ url: string }>;
  disconnectAction: (opts: { alsoDelete?: boolean }) => Promise<unknown>;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [failed, setFailed] = useState(false);
  const [busy, startBusyTransition] = useTransition();

  const refreshStatus = useCallback(() => {
    return getStatus().then(
      (next) => {
        setStatus(next);
        setFailed(false);
        setLoading(false);
        return next;
      },
      (err) => {
        setFailed(true);
        setLoading(false);
        throw err;
      }
    );
  }, [getStatus]);

  const refresh = useCallback(() => {
    void refreshStatus().catch(() => {});
  }, [refreshStatus]);

  const retry = useCallback(() => {
    setFailed(false);
    setLoading(true);
    void refreshStatus().catch(() => {});
  }, [refreshStatus]);

  // 1. Load.
  useEffect(() => {
    if (!enabled) return;
    void refreshStatus().catch(() => {});
  }, [enabled, refreshStatus]);

  // 2. OAuth return, and 3. the switched-account toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get(oauthParam);
    if (outcome !== "connected" && outcome !== "error") return;

    const switched = params.get("switched") === "1";
    const reason = params.get("reason");
    const purpose = params.get("purpose");

    if (outcome === "connected") {
      // Named once the re-read below resolves, so the toast can say who — never both.
      if (!switched) toast.success(`${label} connected`);
      router.refresh();
    } else {
      const oauth = describeOAuthReason(reason, label, purpose);
      if (oauth.cancelled) toast.message(oauth.message);
      else toast.error(oauth.message);
    }

    params.delete(oauthParam);
    for (const key of extraStripKeys) params.delete(key);
    params.delete("reason");
    params.delete("purpose");
    params.delete("switched");
    const next = params.toString();
    // The current path, not a hardcoded one: every card this hook drives also lives in Settings.
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${next ? `?${next}` : ""}${window.location.hash}`
    );

    // Re-read the status: a Next router "restore" (which `replaceState` is) drops any server
    // action still queued — here, the status fetch this hook fired a moment ago on mount —
    // without settling it, which would leave the caller rendering nothing. It is also the
    // only way to learn the newly-connected address, for the "Switched to" toast above.
    refreshStatus()
      .then((fresh) => {
        if (outcome === "connected" && switched && fresh.emailAddress) {
          toast.success(`Switched to ${fresh.emailAddress}`);
        }
      })
      .catch(() => {});
  }, [router, refreshStatus, oauthParam, extraStripKeys, label]);

  // 4. Connect.
  const connect = useCallback(
    (purposes?: readonly Purpose[]) => {
      startBusyTransition(async () => {
        try {
          const { url } = await startOAuth({ purposes: purposes ?? defaultPurposes, returnTo });
          window.location.href = url;
        } catch (err) {
          toast.error(friendlyError(err, TOAST_COPY.connectFailed));
        }
      });
    },
    [startOAuth, defaultPurposes, returnTo]
  );

  // 5. Disconnect.
  const disconnect = useCallback(
    (opts: { alsoDelete: boolean }) => {
      startBusyTransition(async () => {
        await disconnectAction(opts);
        setStatus(null);
        toast.success(
          opts.alsoDelete && deletedDataSuffix
            ? `${label} disconnected and ${deletedDataSuffix}`
            : `${label} disconnected`
        );
        router.refresh();
        void refreshStatus().catch(() => {});
      });
    },
    [disconnectAction, deletedDataSuffix, label, router, refreshStatus]
  );

  return { status, loading, failed, busy, retry, refresh, connect, disconnect };
}

export function useGoogleConnection(opts: {
  returnTo: string;
  enabled?: boolean;
  /**
   * "Gmail" for the recruiter-scan panel: it shares its Settings page with the Google
   * Contacts card and has always worded its toasts and OAuth-error copy around mail rather
   * than the account. Defaults to "Google".
   */
  label?: "Google" | "Gmail";
}): GoogleConnection {
  const connection = useConnection<GmailConnectionStatus, GooglePurpose>({
    returnTo: opts.returnTo,
    enabled: opts.enabled,
    oauthParam: "google",
    extraStripKeys: GOOGLE_EXTRA_STRIP_KEYS,
    label: opts.label ?? "Google",
    deletedDataSuffix: "its recruiter data deleted",
    defaultPurposes: GOOGLE_CONNECT_PURPOSES,
    getStatus: getGmailConnectionStatus,
    startOAuth: startGmailOAuth,
    disconnectAction: disconnectGmail,
  });
  return { kind: "google", ...connection };
}

export function useMicrosoftConnection(opts: {
  returnTo: string;
  enabled?: boolean;
  /**
   * False for the Outlook Contacts card, whose disconnect toast has never named the
   * recruiter data an `alsoDelete` disconnect also removes — unlike every other provider
   * card, including the Outlook recruiter-scan panel, which does. Defaults to true.
   */
  deletesData?: boolean;
}): MicrosoftConnection {
  const connection = useConnection<OutlookConnectionStatus, MicrosoftPurpose>({
    returnTo: opts.returnTo,
    enabled: opts.enabled,
    oauthParam: "outlook",
    extraStripKeys: MICROSOFT_EXTRA_STRIP_KEYS,
    label: "Outlook",
    deletedDataSuffix: opts.deletesData === false ? undefined : "its recruiter data deleted",
    defaultPurposes: MICROSOFT_CONNECT_PURPOSES,
    getStatus: getOutlookConnectionStatus,
    startOAuth: startOutlookOAuth,
    disconnectAction: disconnectOutlook,
  });
  return { kind: "microsoft", ...connection };
}
