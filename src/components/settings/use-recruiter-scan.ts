"use client";

/**
 * Owns the recruiter-inbox-scan flow shared by the Gmail and Outlook panels: kicking off a
 * scan, polling it every two seconds, mirroring it into the shared `background-jobs` store
 * so the global progress widget and notification panel pick it up, and surfacing the terminal
 * toast + `router.refresh()`. The account chrome around it (Connect, Disconnect, the OAuth
 * return) stays owned by `useGoogleConnection` / `useMicrosoftConnection`
 * (`use-provider-connection.ts`), which each panel composes beside this hook, unchanged.
 *
 * Written as one function with two call signatures (like `useGoogleConnection` /
 * `useMicrosoftConnection` are two wrappers over one `useConnection` implementation in
 * `use-provider-connection.ts`) so a caller passing the `"google"` literal gets back a
 * `GmailScanStatus`-typed `scan`, and `"microsoft"` gets `OutlookScanStatus` — neither
 * provider's status type is widened to the other at the call site. Internally there is a
 * single, unconditional set of hook calls; only the plain data each one reads from (which
 * server actions to call, which background-job id/kind/label to use) is picked by `provider`,
 * so the calls stay in the same order on every render regardless of which panel renders it —
 * a literal `if (provider === "google") return useX(); return useY();` would call a hook
 * conditionally, which the two real call sites here (each always passing the same literal
 * provider) would never actually reorder across renders, but the rules-of-hooks lint can't
 * prove that, so it's written to not need it.
 *
 * `start` and `cancel` return the promise their work runs in, rather than firing and
 * forgetting internally. Both panels already have their own `useTransition` for gating the
 * header link, the Connect/Reconnect button, the scan button and the disconnect dialog while
 * a scan is starting or cancelling — before the scan's own `running` state has had a chance
 * to flip true, since that only happens once the status re-read after the start call lands.
 * Wrapping this hook's `start()`/`cancel()` in that same transition (`start(() =>
 * scan.start())`) reproduces that pending window exactly as it worked before this was a
 * hook; folding it in here instead (e.g. as a `pending`/`busy` field) would have meant the
 * two panels' pre-existing transitions had nothing left to wrap, which is a bigger and
 * riskier change to two files that otherwise don't need to move at all this task.
 *
 * `reset` is the other addition beyond what Step 2 lists moving: each panel's
 * `DisconnectAccountDialog.onConfirm` ran `conn.disconnect(opts).then(() => setScan(null))`
 * to drop a finished/failed scan card once the account disconnects. `scan` now lives in this
 * hook instead of the panel, so that cleanup needs a way in; `reset()` is exactly that
 * `setScan(null)`, nothing more.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  cancelGmailRecruiterScan,
  getGmailScanStatus,
  startGmailRecruiterScan,
  type GmailScanStatus,
} from "@/actions/gmail";
import {
  cancelOutlookRecruiterScan,
  getOutlookScanStatus,
  startOutlookRecruiterScan,
  type OutlookScanStatus,
} from "@/actions/outlook";
import {
  finishBackgroundJob,
  startBackgroundJob,
  updateBackgroundJob,
} from "@/lib/background-jobs";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import type { ActionResult } from "@/lib/errors";

const POLL_INTERVAL_MS = 2000;

function isTerminal(status: string) {
  return ["completed", "failed", "cancelled"].includes(status);
}

type Scan = GmailScanStatus | OutlookScanStatus;

/**
 * Describes where the job actually is. Discovery has no meaningful denominator — the
 * mailbox size is unknown until the sweep ends — so it reports messages seen and the
 * progress bar stays indeterminate until classification starts. Returns "" once the scan
 * reaches a terminal state or there is no scan yet; both panels only ever render this label
 * inside `running && scan`, so that empty case is never actually shown.
 */
function computePhaseLabel(scan: Scan | null): string {
  if (!scan || isTerminal(scan.status)) return "";
  if (!scan.discoveryComplete) {
    return scan.messagesScanned > 0
      ? `Searching your mailbox — ${scan.messagesScanned.toLocaleString()} messages so far`
      : "Searching your mailbox…";
  }
  return `Reading ${scan.processed}/${scan.totalSenders ?? 0} conversations`;
}

export type RecruiterScanState<S> = {
  scan: S | null;
  running: boolean;
  phaseLabel: string;
  percent: number | null;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Sets `scan` back to null — see the doc comment above. Used after a successful
   *  disconnect. */
  reset: () => void;
};

type ScanConfig<S extends Scan> = {
  backgroundJobId: (importId: string) => string;
  backgroundJobKind: string;
  backgroundJobLabel: string;
  startScan: () => Promise<ActionResult<{ importId: string }>>;
  getScanStatus: (importId: string) => Promise<S | null>;
  cancelScan: (importId: string) => Promise<unknown>;
};

const GOOGLE_SCAN_CONFIG: ScanConfig<GmailScanStatus> = {
  backgroundJobId: (importId) => `gmail-scan-${importId}`,
  backgroundJobKind: "gmail-recruiter-scan",
  backgroundJobLabel: "Scanning Gmail for recruiters",
  startScan: startGmailRecruiterScan,
  getScanStatus: getGmailScanStatus,
  cancelScan: cancelGmailRecruiterScan,
};

const OUTLOOK_SCAN_CONFIG: ScanConfig<OutlookScanStatus> = {
  backgroundJobId: (importId) => `outlook-scan-${importId}`,
  backgroundJobKind: "outlook-recruiter-scan",
  backgroundJobLabel: "Scanning Outlook for recruiters",
  startScan: startOutlookRecruiterScan,
  getScanStatus: getOutlookScanStatus,
  cancelScan: cancelOutlookRecruiterScan,
};

export function useRecruiterScan(
  provider: "google",
  initialScan: GmailScanStatus | null
): RecruiterScanState<GmailScanStatus>;
export function useRecruiterScan(
  provider: "microsoft",
  initialScan: OutlookScanStatus | null
): RecruiterScanState<OutlookScanStatus>;
export function useRecruiterScan(
  provider: "google" | "microsoft",
  initialScan: Scan | null
): RecruiterScanState<GmailScanStatus> | RecruiterScanState<OutlookScanStatus> {
  const router = useRouter();
  const config: ScanConfig<Scan> =
    provider === "google"
      ? (GOOGLE_SCAN_CONFIG as ScanConfig<Scan>)
      : (OUTLOOK_SCAN_CONFIG as ScanConfig<Scan>);

  const [scan, setScan] = useState<Scan | null>(initialScan);
  const jobIdRef = useRef<string | null>(null);

  const running = scan != null && !isTerminal(scan.status);

  /**
   * Mirror server state into the shared job store so the global progress bar and its
   * completion toast work exactly as they do for LinkedIn/contacts imports. The job is owned
   * by the server, so this is presentation only — closing the tab does not stop the scan.
   */
  const mirror = useCallback(
    (next: Scan) => {
      const total = next.discoveryComplete ? (next.totalSenders ?? 0) : 0;
      const done = next.discoveryComplete ? next.processed : 0;

      if (!jobIdRef.current && !isTerminal(next.status)) {
        jobIdRef.current = startBackgroundJob({
          id: config.backgroundJobId(next.importId),
          kind: config.backgroundJobKind,
          label: config.backgroundJobLabel,
          startedAt: Date.now(),
          done,
          total,
        });
      } else if (jobIdRef.current && !isTerminal(next.status)) {
        updateBackgroundJob(jobIdRef.current, { done, total });
      } else if (jobIdRef.current && isTerminal(next.status)) {
        finishBackgroundJob(
          jobIdRef.current,
          next.status === "completed"
            ? {
                status: "completed",
                resultMessage: `${next.recruitersFound} recruiter${
                  next.recruitersFound === 1 ? "" : "s"
                } found`,
              }
            : {
                status: next.status === "cancelled" ? "cancelled" : "failed",
                error: next.errorMessage || undefined,
              }
        );
        jobIdRef.current = null;
      }
    },
    [config]
  );

  useEffect(() => {
    if (!running || !scan) return;
    let cancelled = false;

    const timer = setInterval(async () => {
      try {
        const next = await config.getScanStatus(scan.importId);
        if (cancelled || !next) return;
        setScan(next);
        mirror(next);
        if (isTerminal(next.status)) {
          if (next.status === "completed") {
            toast.success(
              next.recruitersFound > 0
                ? `Found ${next.recruitersFound} recruiter${next.recruitersFound === 1 ? "" : "s"}`
                : "No recruiters found in your mailbox"
            );
          } else if (next.status === "failed") {
            // The stored scan error can be a raw Gmail/Graph API body.
            toast.error(friendlyError(next.errorMessage, "The scan didn’t finish — try again?"));
          }
          router.refresh();
        }
      } catch {
        // Transient — the next tick retries.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running, scan, mirror, router, config]);

  const start = useCallback(async () => {
    try {
      const started = await config.startScan();
      if (!started.ok) {
        toast.error(started.error);
        return;
      }
      const { importId } = started.value;
      const next = await config.getScanStatus(importId);
      if (next) {
        setScan(next);
        mirror(next);
      }
      toast.success("Scan started — this can take a few minutes");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t start the scan — try again?"));
    }
  }, [config, mirror]);

  const cancel = useCallback(async () => {
    if (!scan) return;
    await config.cancelScan(scan.importId);
    toast.success("Scan stopped");
    const next = await config.getScanStatus(scan.importId);
    if (next) {
      setScan(next);
      mirror(next);
    }
  }, [scan, config, mirror]);

  const reset = useCallback(() => {
    setScan(null);
  }, []);

  const percent =
    scan && scan.discoveryComplete && scan.totalSenders
      ? Math.min(100, Math.round((scan.processed / scan.totalSenders) * 100))
      : null;

  return {
    scan,
    running,
    phaseLabel: computePhaseLabel(scan),
    percent,
    start,
    cancel,
    reset,
  } as RecruiterScanState<GmailScanStatus> | RecruiterScanState<OutlookScanStatus>;
}
