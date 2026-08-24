"use client";

import { createContext, useContext, useEffect, useState } from "react";

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
 * The provider owns exactly one interval no matter how many rows render, and pauses when
 * the tab is hidden — an admin console left open in a background tab should not poll all
 * afternoon.
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
  const [live, setLive] = useState<ReadonlySet<string>>(
    () => new Set(initialLive)
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const res = await fetch("/api/admin/presence", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { userIds?: string[] };
        if (cancelled || !Array.isArray(data.userIds)) return;
        setLive(new Set(data.userIds));
      } catch {
        // Keep the last known set rather than blanking every dot on one failed poll:
        // "briefly stale" reads far better than "everyone went offline at once".
      }
    };

    const start = () => {
      if (timer !== null) return;
      void poll();
      timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, []);

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
