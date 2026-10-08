/**
 * When the "record this meeting?" offer shows: from two minutes before a meeting starts until
 * ten minutes after, never for one already over or dismissed, the closest start first.
 * Pure — a fake clock, no storage, no network.
 * Run: npx tsx scripts/smoke-meeting-nudge.ts
 */
import type { MeetingCandidate } from "../src/lib/meeting-calendar";
import { NUDGE_GRACE_MS, NUDGE_LEAD_MS, nudgeKey, nudgeTiming, pickNudge } from "../src/lib/meeting-nudge";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NOW = Date.parse("2026-10-08T18:00:00.000Z");
const min = (n: number) => n * 60_000;

function meeting(id: string, startMin: number, lengthMin = 30): MeetingCandidate {
  return {
    id,
    title: id,
    startIso: new Date(NOW + min(startMin)).toISOString(),
    endIso: new Date(NOW + min(startMin + lengthMin)).toISOString(),
    attendees: [{ name: "Priya Raman", email: "priya@acme.io" }],
  };
}
const none = new Set<string>();

// ── The window ────────────────────────────────────────────────────────────────────────
check("far in the future: not yet", pickNudge([meeting("later", 10)], NOW, none) === null);
check("exactly the lead time: shows", pickNudge([meeting("soon", NUDGE_LEAD_MS / 60_000)], NOW, none)?.id === "soon");
check("a second past the lead time: not yet", pickNudge([{ ...meeting("x", 2), startIso: new Date(NOW + NUDGE_LEAD_MS + 1_000).toISOString() }], NOW, none) === null);
check("starting now: shows", pickNudge([meeting("now", 0)], NOW, none)?.id === "now");
check("five minutes late: still shows", pickNudge([meeting("late", -5)], NOW, none)?.id === "late");
check("past the grace period: gone", pickNudge([meeting("old", -(NUDGE_GRACE_MS / 60_000) - 1, 60)], NOW, none) === null);
check("already over: gone", pickNudge([meeting("done", -3, 2)], NOW, none) === null);

// ── Dismissal and choice ──────────────────────────────────────────────────────────────
{
  const a = meeting("a", 1);
  check("dismissed: gone", pickNudge([a], NOW, new Set([nudgeKey(a)])) === null);
  const monday = meeting("standup", 1);
  const nextWeek = { ...monday, startIso: new Date(NOW + 7 * 86_400_000 + min(1)).toISOString() };
  check(
    "a recurring series dismissed once is only dismissed for that occurrence",
    nudgeKey(monday) !== nudgeKey(nextWeek)
  );
  check("two meetings: the one closest to its start wins", pickNudge([meeting("a", 2), meeting("b", 0), meeting("c", -4)], NOW, none)?.id === "b");
  check("the dismissed one is skipped in favour of the next", pickNudge([meeting("b", 0), meeting("c", 1)], NOW, new Set([nudgeKey(meeting("b", 0))]))?.id === "c");
  check("nothing on the calendar", pickNudge([], NOW, none) === null);
  check("a bad date is ignored, not thrown on", pickNudge([{ ...meeting("bad", 0), startIso: "nonsense" }], NOW, none) === null);
}

// ── The wording ───────────────────────────────────────────────────────────────────────
check("two minutes out", nudgeTiming(meeting("t", 2), NOW) === "starts in 2 min");
check("rounds a partial minute up", nudgeTiming({ startIso: new Date(NOW + 90_000).toISOString() }, NOW) === "starts in 2 min");
check("a minute out", nudgeTiming(meeting("t", 1), NOW) === "starts in 1 min");
check("within half a minute: now", nudgeTiming({ startIso: new Date(NOW + 20_000).toISOString() }, NOW) === "starting now");
check("just started: now", nudgeTiming({ startIso: new Date(NOW - 30_000).toISOString() }, NOW) === "starting now");
check("late joiner", nudgeTiming(meeting("t", -4), NOW) === "started 4 min ago");

console.log("\nsmoke-meeting-nudge: all checks passed");
