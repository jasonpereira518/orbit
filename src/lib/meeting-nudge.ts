/**
 * When to offer to record a meeting, and what to say. Pure — no clock, storage or network —
 * so `scripts/smoke-meeting-nudge.ts` can drive it with a fake clock. The polling, the
 * dismissals and the desktop alert are `meeting-nudge-store.ts`.
 */
import type { MeetingCandidate } from "@/lib/meeting-calendar";

/** The offer appears this long before a meeting starts… */
export const NUDGE_LEAD_MS = 2 * 60_000;
/** …and stays until this long after, for the person who joins late. */
export const NUDGE_GRACE_MS = 10 * 60_000;

/** Identifies one occurrence: a recurring series reuses its id, the start time tells them apart. */
export function nudgeKey(c: Pick<MeetingCandidate, "id" | "startIso">): string {
  return `${c.id}@${c.startIso}`;
}

/**
 * The meeting to offer right now, if any: starting within the lead time or already started
 * within the grace period, not ended, not dismissed. The closest to its start wins.
 */
export function pickNudge(
  events: readonly MeetingCandidate[],
  nowMs: number,
  dismissed: ReadonlySet<string>
): MeetingCandidate | null {
  let best: MeetingCandidate | null = null;
  let bestDistance = Infinity;
  for (const c of events) {
    const start = Date.parse(c.startIso);
    if (Number.isNaN(start)) continue;
    const end = c.endIso ? Date.parse(c.endIso) : start;
    if (start - nowMs > NUDGE_LEAD_MS || nowMs - start > NUDGE_GRACE_MS) continue;
    if (end < nowMs) continue;
    if (dismissed.has(nudgeKey(c))) continue;
    const distance = Math.abs(start - nowMs);
    if (distance < bestDistance) {
      best = c;
      bestDistance = distance;
    }
  }
  return best;
}

/** "starts in 2 min", "starting now", "started 4 min ago". Whole minutes, rounded up on the way in. */
export function nudgeTiming(c: Pick<MeetingCandidate, "startIso">, nowMs: number): string {
  const delta = Date.parse(c.startIso) - nowMs;
  if (delta > 30_000) {
    const minutes = Math.ceil(delta / 60_000);
    return `starts in ${minutes} min`;
  }
  if (delta > -60_000) return "starting now";
  return `started ${Math.floor(-delta / 60_000)} min ago`;
}
