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
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const sessions = await user.getSessions();
      const currentId = currentSession?.id ?? null;
      setRows(sessions.map((s) => describe(s, currentId)));
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, "Couldn’t load your devices — try again?")));
      setRows([]);
    }
  }, [user, currentSession]);

  useEffect(() => {
    if (isLoaded && user) void load();
  }, [isLoaded, user, load]);

  const revoke = useReverification(async (sessionId: string) => {
    if (!user) return;
    const sessions = await user.getSessions();
    const target = sessions.find((s) => s.id === sessionId);
    if (target) await target.revoke();
  });

  const signOutOne = async (sessionId: string) => {
    setBusy(sessionId);
    try {
      await revoke(sessionId);
      toast.success("Signed that device out");
      await load();
    } catch (err) {
      toast.error(clerkErrorMessage(err, friendlyError(err, TOAST_COPY.saveFailed)));
    } finally {
      setBusy(null);
    }
  };

  if (!isLoaded || rows === null) {
    return <div className="h-24 animate-pulse rounded-lg bg-muted/40" aria-hidden />;
  }
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
