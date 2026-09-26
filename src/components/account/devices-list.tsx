"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useClerk, useUser, useSession, useReverification } from "@clerk/nextjs";
import { isReverificationCancelledError } from "@clerk/nextjs/errors";
import type { SessionWithActivitiesResource } from "@clerk/nextjs/types";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { clerkErrorMessage } from "@/lib/clerk-errors";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";

type Row = {
  id: string;
  browser: string;
  os: string;
  place: string;
  lastActive: string;
};

/**
 * A union rather than `rows: Row[] | null` plus a boolean flag, so a failed fetch cannot be
 * confused with "there are zero other devices" — the two used to collapse onto the same
 * `rows.length === 0` branch, which rendered "No other devices are signed in" even when the
 * fetch itself had failed and we had no idea how many devices there really were.
 *
 * It holds Clerk's own resources, not display rows: `revoke()` lives on the resource, so
 * keeping them means signing a device out never re-fetches the whole list to find the one
 * session it is about to end (which it did twice whenever reverification retried the call).
 * The display rows are derived at render instead.
 */
type ListState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; sessions: SessionWithActivitiesResource[] };

const LOAD_FAILED_COPY = "Couldn’t load your devices — try again?";

/** `busy` sentinel for the batch control, which is not keyed by a session id. */
const ALL_OTHERS = "all-others";

/** "Chrome on macOS · Toronto, CA · active 2 hours ago", from whatever Clerk gives us. */
function describe(session: SessionWithActivitiesResource): Row {
  const a = session.latestActivity;
  const city = [a?.city, a?.country].filter(Boolean).join(", ");
  return {
    id: session.id,
    browser: a?.browserName ? `${a.browserName} ${a.browserVersion ?? ""}`.trim() : "Unknown browser",
    os: a?.deviceType ?? "Unknown device",
    place: city || "Location unknown",
    // The repo's convention for "when was this last touched" — see api-settings.tsx and
    // calendar-feed-settings.tsx. A locale timestamp was both harder to read and a lie
    // against this function's own promise above. Client-only list, so no hydration hazard.
    lastActive: session.lastActiveAt
      ? formatDistanceToNow(new Date(session.lastActiveAt), { addSuffix: true })
      : "at an unknown time",
  };
}

/** Truthful count for the batch sign-out, singular included. */
function signedOutCopy(count: number) {
  return count === 1 ? "Signed out 1 other device" : `Signed out ${count} other devices`;
}

/**
 * Every session on the account, and a way to end the ones that are not this one.
 *
 * Revoking is reverification-wrapped: Clerk decides whether to ask "confirm it's you"
 * first, shows its own prompt, and then retries the call.
 *
 * The installed `@clerk/nextjs` (7.5.20) has no `user.lastActiveSessionId` — `UserResource`
 * in `@clerk/shared/dist/types/user.d.mts` carries no such field. `useSession()` is the
 * current-session handle instead (`session.id`, from `SessionResource` in
 * `@clerk/shared/dist/types/session.d.mts`).
 *
 * Both `useUser()` and `useSession()` read `clerk.__internal_lastEmittedResources` through
 * `useSyncExternalStore` (`@clerk/shared/dist/react/index.mjs`, `useUserBase`), so their
 * return values are a NEW identity on every Clerk emission — a token refresh, a window
 * focus, any resource reload. Nothing here may therefore depend on those objects: the load
 * effect keys on the user's *id* and reaches the live resource through `useClerk()`, whose
 * value is the Clerk instance itself and is stable for the life of the provider. Keying on
 * the resources instead re-fetched the session list on every emission, and — since that
 * response can carry Clerk's piggybacked `client` payload, which triggers an emission — it
 * could feed itself.
 */
export function DevicesList() {
  const clerk = useClerk();
  const { isLoaded: userLoaded, user } = useUser();
  const { isLoaded: sessionLoaded, session: currentSession } = useSession();
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Belt and braces against two loads in flight at once (a double-click on "Try again",
  // or a retry landing while the mount load is still open). A ref, not state: it must be
  // readable and writable without waiting for a render.
  const loading = useRef(false);

  const userId = user?.id ?? null;

  const load = useCallback(async () => {
    const live = clerk.user;
    if (!live || loading.current) return;
    loading.current = true;
    try {
      const sessions = await live.getSessions();
      setState({ status: "ready", sessions });
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, LOAD_FAILED_COPY)));
      setState({ status: "error" });
    } finally {
      loading.current = false;
    }
  }, [clerk]);

  useEffect(() => {
    if (userId) void load();
  }, [userId, load]);

  const retry = async () => {
    setRetrying(true);
    try {
      await load();
    } finally {
      setRetrying(false);
    }
  };

  /**
   * One wrapper, reused by the row buttons and by "Sign out everywhere else". Clerk decides
   * whether the session is fresh enough; if it is not, it shows its own "confirm it's you"
   * prompt and then re-runs this callback. Operating on the cached resource keeps that
   * retry from costing another `GET /me/sessions`.
   */
  const revokeSession = useReverification((session: SessionWithActivitiesResource) =>
    session.revoke()
  );

  /**
   * `useReverification` rejects when the person *dismisses* Clerk's prompt, and that
   * rejection is a `ClerkRuntimeError` with no `errors[]` — so `clerkErrorMessage` cannot
   * recognise it and falls back to "that didn’t save", telling someone who deliberately
   * backed out that something went wrong. Deciding not to continue is not a failure: say
   * nothing. `isReverificationCancelledError` is the supported check
   * (`@clerk/nextjs/errors` → `@clerk/shared/error`). Phases 2–3 wrap about ten more
   * sensitive calls; every one of them needs this line.
   */
  const cancelled = (err: unknown) => isReverificationCancelledError(err);

  const signOutOne = async (session: SessionWithActivitiesResource) => {
    setBusy(session.id);
    try {
      await revokeSession(session);
      toast.success("Signed that device out");
    } catch (err) {
      if (cancelled(err)) return;
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setBusy(null);
      await load();
    }
  };

  /**
   * The spec's "Sign out everywhere else": every session but this one, ended.
   *
   * Sequential rather than `Promise.allSettled`, because the reverification wrapper needs
   * the rejection to reach it — a settled batch swallows it and Clerk's prompt never
   * appears. The first call is the one that prompts; the rest reuse the elevated session.
   * `signedOut` therefore counts what actually went, so the toast can say how many rather
   * than implying all of them did.
   */
  const signOutOthers = async (others: SessionWithActivitiesResource[]) => {
    setBusy(ALL_OTHERS);
    let signedOut = 0;
    try {
      for (const session of others) {
        await revokeSession(session);
        signedOut += 1;
      }
      toast.success(signedOutCopy(signedOut));
    } catch (err) {
      // Backed out part-way: whatever already went is still gone, so say so rather than
      // nothing. Nothing gone and nothing to report.
      if (cancelled(err)) {
        if (signedOut > 0) toast.success(signedOutCopy(signedOut));
        return;
      }
      // One error line, not an error plus a count: the reload below is what tells the
      // truth about which devices are left.
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setBusy(null);
      await load();
    }
  };

  if (!userLoaded || !sessionLoaded || state.status === "loading") {
    return <div className="h-24 animate-pulse rounded-lg bg-muted/40" aria-hidden />;
  }
  if (state.status === "error") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{LOAD_FAILED_COPY}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={() => void retry()}
        >
          {retrying ? "Trying…" : "Try again"}
        </Button>
      </div>
    );
  }

  const { sessions } = state;
  if (sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">No devices are signed in.</p>;
  }

  /**
   * Which session is this one, decided at render from the live `useSession()` value rather
   * than frozen into state when the list loaded. While it is unknown — Clerk loaded but no
   * active session — NO row is treated as another device: the badge is absent and so is
   * every button, rather than the whole list (this device included) sprouting a "Sign out"
   * that the design specifically prevents.
   */
  const currentId = currentSession?.id ?? null;
  const others = currentId ? sessions.filter((s) => s.id !== currentId) : [];

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border/60">
        {sessions.map((session) => {
          const row = describe(session);
          const isCurrent = currentId !== null && session.id === currentId;
          const canSignOut = currentId !== null && !isCurrent;
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium text-ink">
                  <span className="truncate">
                    {row.browser} on {row.os}
                  </span>
                  {isCurrent && <Badge variant="secondary">This device</Badge>}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.place} · active {row.lastActive}
                </p>
              </div>
              {canSignOut && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  aria-label={`${busy === row.id ? "Signing out" : "Sign out"} ${row.browser} on ${row.os}`}
                  onClick={() => void signOutOne(session)}
                >
                  {busy === row.id ? "Signing out…" : "Sign out"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {currentId !== null &&
        (others.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void signOutOthers(others)}
            >
              {busy === ALL_OTHERS ? "Signing out…" : "Sign out everywhere else"}
            </Button>
            <p className="text-xs text-muted-foreground">
              This device stays signed in. No undo — the others sign in again.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No other devices are signed in.</p>
        ))}
    </div>
  );
}
