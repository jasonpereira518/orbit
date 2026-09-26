"use client";

import { createContext, useContext, useMemo } from "react";
import { useLivePoll } from "@/components/admin/use-live-poll";

/**
 * Live presence for the roster, kept fresh by polling.
 *
 * WHY NOT `router.refresh()`. The obvious way to make a server-rendered table update is to
 * refresh the route on a timer, but that re-runs every query behind the page and replaces
 * the whole tree — which at a fifteen-second cadence means the filter bar flickers, the
 * scroll position fights the operator, and a `⋯` menu closes itself while being read. This
 * polls a `string[]` and repaints a dot.
 *
 * WHY NOT SSE OR A WEBSOCKET. Same information, considerably more infrastructure, on a
 * console with one user watching roughly a dozen accounts. If the roster ever renders
 * hundreds of live rows this is the thing to revisit; today a poll is the honest choice.
 *
 * The polling itself — one interval no matter how many rows render, paused while the tab
 * is hidden — lives in `use-live-poll.ts`, shared with the Overview and Health screens.
 */

const POLL_INTERVAL_MS = 15 * 1000;

const LiveContext = createContext<ReadonlySet<string>>(new Set());

export function PresenceProvider({
  initialLive,
  children,
}: {
  /** Server-rendered live set, so the first paint is already correct. */
  initialLive: string[];
  children: React.ReactNode;
}) {
  // Memoized: `useLivePoll` resyncs to `initial` whenever its identity changes, so an
  // inline object literal recreated on every poll-driven re-render would snap the live
  // set back to `initialLive` right after each successful poll updated it.
  const initial = useMemo(() => ({ userIds: initialLive }), [initialLive]);
  const polled = useLivePoll<{ userIds?: string[] }>(
    "/api/admin/presence",
    initial,
    POLL_INTERVAL_MS
  );
  const live = useMemo(
    () => new Set(Array.isArray(polled.userIds) ? polled.userIds : []),
    [polled]
  );

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

export function useIsLive(userId: string): boolean {
  return useContext(LiveContext).has(userId);
}

/**
 * How many of the given accounts are live.
 *
 * A client component rather than a server-rendered integer so the headline and the dots
 * below it are always computed from the same set — a count that says "3 active now" over a
 * table showing two green dots is worse than no count at all.
 *
 * Scoped to `userIds` (the current page) rather than the whole live set, because the number
 * has to agree with what is on screen.
 */
export function LiveCount({ userIds }: { userIds: string[] }) {
  const live = useContext(LiveContext);
  const n = userIds.filter((id) => live.has(id)).length;

  if (n === 0) return null;
  return <span className="text-primary"> · {n} active now</span>;
}

/**
 * The presence indicator for one account.
 *
 * Falls back to `children` — the relative "last seen" — when the user is not live, so the
 * column always says something useful rather than going blank between sessions.
 */
export function LiveDot({
  userId,
  children,
}: {
  userId: string;
  children?: React.ReactNode;
}) {
  const live = useIsLive(userId);

  if (!live) return <>{children}</>;

  return (
    <span
      className="inline-flex items-center gap-1.5 text-primary"
      title="Active now — heartbeat received in the last 90 seconds"
    >
      <span className="relative flex size-2">
        {/* Decorative only; `motion-safe` so it does not pulse for anyone who asked it not to. */}
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/70 motion-reduce:hidden" />
        <span className="relative inline-flex size-2 rounded-full bg-primary" />
      </span>
      Now
    </span>
  );
}
