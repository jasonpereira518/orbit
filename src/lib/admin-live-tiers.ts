/**
 * Live-polling constants and types. ZERO IMPORTS, on purpose.
 *
 * `src/components/admin/live.tsx` is a client component and needs the screen names and
 * the cadences. `admin-live.ts` — where the values are actually computed — imports
 * `@/db`, and a client component that reaches the database module fails the build with a
 * `node:fs` chunking error that names neither file. This has bitten this repo twice
 * already (`presence-window.ts` and `attribution-parse.ts` exist for the same reason).
 *
 * A `import type` would probably be erased and probably be fine. "Probably" is not worth
 * a build failure whose error message points at neither end of the problem.
 *
 * DO NOT RE-EXPORT THESE FROM `admin-live.ts`. A re-export would make the broken import
 * path compile again, and the next person would follow it.
 */

export type LiveScreen = "overview" | "health" | "funnel" | "billing" | "product";

export type LiveValues = Record<string, number | string | null>;

/** How often each screen's values are refetched. */
export const LIVE_TIERS = {
  /** Presence. Matches the heartbeat window, because a slower poll would show ghosts. */
  presence: 15_000,
  /** Counters: cheap integers off one indexed scan. */
  counters: 30_000,
  /** Aggregates: real work, and slow-moving enough that a minute of staleness is nothing. */
  aggregates: 300_000,
} as const;

export const SCREEN_TIER: Record<LiveScreen, number> = {
  overview: LIVE_TIERS.counters,
  health: LIVE_TIERS.counters,
  funnel: LIVE_TIERS.counters,
  billing: LIVE_TIERS.aggregates,
  product: LIVE_TIERS.aggregates,
};

export function isLiveScreen(value: string): value is LiveScreen {
  return ["overview", "health", "funnel", "billing", "product"].includes(value);
}
