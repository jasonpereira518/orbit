"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser, useSession, useReverification } from "@clerk/nextjs";
import type { SessionWithActivitiesResource } from "@clerk/nextjs/types";
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
  current: boolean;
};

/**
 * A union rather than `rows: Row[] | null` plus a boolean flag, so a failed fetch cannot be
 * confused with "there are zero other devices" — the two used to collapse onto the same
 * `rows.length === 0` branch, which rendered "No other devices are signed in" even when the
 * fetch itself had failed and we had no idea how many devices there really were.
 */
type ListState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; rows: Row[] };

const LOAD_FAILED_COPY = "Couldn’t load your devices — try again?";

/** "Chrome on macOS · Toronto, CA · active 2 hours ago", from whatever Clerk gives us. */
function describe(
  session: SessionWithActivitiesResource,
  currentSessionId: string | null
): Row {
  const a = session.latestActivity;
  const city = [a?.city, a?.country].filter(Boolean).join(", ");
  return {
    id: session.id,
    browser: a?.browserName ? `${a.browserName} ${a.browserVersion ?? ""}`.trim() : "Unknown browser",
    os: a?.deviceType ?? "Unknown device",
    place: city || "Location unknown",
    lastActive: session.lastActiveAt
      ? new Date(session.lastActiveAt).toLocaleString()
      : "Unknown",
    current: session.id === currentSessionId,
  };
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
 */
export function DevicesList() {
  const { isLoaded, user } = useUser();
  const { session: currentSession } = useSession();
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const sessions = await user.getSessions();
      const currentId = currentSession?.id ?? null;
      setState({ status: "ready", rows: sessions.map((s) => describe(s, currentId)) });
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, LOAD_FAILED_COPY)));
      setState({ status: "error" });
    }
  }, [user, currentSession]);

  useEffect(() => {
    if (isLoaded && user) void load();
  }, [isLoaded, user, load]);

  // Resolves to whether a session actually got revoked, so `signOutOne` never claims success
  // for a no-op — there being no signed-in user, or the session already having ended
  // elsewhere between the list load and the click.
  const revoke = useReverification(async (sessionId: string): Promise<boolean> => {
    if (!user) return false;
    const sessions = await user.getSessions();
    const target = sessions.find((s) => s.id === sessionId);
    if (!target) return false;
    await target.revoke();
    return true;
  });

  const signOutOne = async (sessionId: string) => {
    setBusy(sessionId);
    try {
      const revoked = await revoke(sessionId);
      if (revoked) {
        toast.success("Signed that device out");
      } else {
        toast.error(TOAST_COPY.saveFailed);
      }
      await load();
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setBusy(null);
    }
  };

  if (!isLoaded || state.status === "loading") {
    return <div className="h-24 animate-pulse rounded-lg bg-muted/40" aria-hidden />;
  }
  if (state.status === "error") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{LOAD_FAILED_COPY}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }
  const { rows } = state;
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No other devices are signed in.</p>;
  }

  return (
    <ul className="divide-y divide-border/60">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium text-ink">
              <span className="truncate">
                {row.browser} on {row.os}
              </span>
              {row.current && <Badge variant="secondary">This device</Badge>}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {row.place} · active {row.lastActive}
            </p>
          </div>
          {!row.current && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy === row.id}
              aria-label={`${busy === row.id ? "Signing out" : "Sign out"} ${row.browser} on ${row.os}`}
              onClick={() => void signOutOne(row.id)}
            >
              {busy === row.id ? "Signing out…" : "Sign out"}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
