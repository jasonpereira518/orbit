/**
 * Relationship health scoring, pinned to a fixed `now`. No network, no DB.
 * Run: npx tsx scripts/smoke-relationship-health.ts
 */
import { relationshipHealth, type HealthRow } from "../src/lib/relationship-health";

function check(label: string, condition: boolean, detail?: unknown) {
  if (!condition) throw new Error(`${label} failed${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok  ${label}`);
}

const NOW = new Date("2026-09-01T12:00:00Z");
const HOUR = 3_600_000;
const at = (daysAgo: number, hoursLater = 0) => new Date(NOW.getTime() - daysAgo * 24 * HOUR + hoursLater * HOUR);
const row = (d: Date, direction: HealthRow["direction"], source: string | null = "linkedin_messages"): HealthRow => ({
  at: d,
  direction,
  source,
});

check("no rows → null", relationshipHealth([], { now: NOW }) === null);

{
  const h = relationshipHealth([row(at(0), null, "google_calendar")], { now: NOW })!;
  check("meeting today → recency only, 100", h.current === 100 && h.components.reciprocity === null && h.components.latency === null, h);
}

{
  const h = relationshipHealth([row(at(30), null, "google_calendar")], { now: NOW })!;
  check("meeting 30d ago at default cadence → 50", h.current === 50, h.current);
}

{
  // Back-and-forth every 2 hours, ending on their reply two days ago.
  const rows: HealthRow[] = [];
  for (let i = 0; i < 6; i++) rows.push(row(at(2, i * 2), i % 2 === 0 ? "out" : "in"));
  const h = relationshipHealth(rows, { now: NOW })!;
  check("balanced fast exchange → high score", h.current >= 90, h.current);
  check("balanced fast exchange → reciprocity 1", h.components.reciprocity === 1, h.components);
  check("balanced fast exchange → 2h median reply", h.components.medianReplyHours === 2, h.components);
}

{
  const rows = [20, 15, 10, 5].map((d) => row(at(d), "out"));
  const h = relationshipHealth(rows, { now: NOW })!;
  check("one-sided outbound → reciprocity 0", h.components.reciprocity === 0, h.components);
  check("one-sided outbound → open message censors latency", h.components.medianReplyHours === 120, h.components);
  check("one-sided outbound → low score", h.current < 50, h.current);
}

{
  const meeting = [row(at(40), null, "google_calendar")];
  const quarterly = relationshipHealth(meeting, { now: NOW, cadenceDays: 90 })!;
  const monthly = relationshipHealth(meeting, { now: NOW })!;
  check("quarterly cadence is not penalized at day 40", quarterly.current > 70, quarterly.current);
  check("default cadence decays at day 40", monthly.current < 45, monthly.current);
}

{
  const rows = [row(at(3), "out", "whatsapp"), row(at(3, 1), "in", "whatsapp")];
  const h = relationshipHealth(rows, { now: NOW })!;
  check("chat sessions count toward reciprocity", h.components.reciprocity === 1, h.components);
  check("chat sessions never count as replies", h.components.latency === null, h.components);
}

{
  const h = relationshipHealth([row(at(100), "in"), row(at(100, 3), "out")], { now: NOW })!;
  check("26 weekly points", h.points.length === 26, h.points.length);
  check("points are integers in 0–100", h.points.every((p) => Number.isInteger(p) && p >= 0 && p <= 100), h.points);
  check("before the first touch draws at the floor", h.points[0] === 0, h.points);
  check("last point is current", h.points[25] === h.current, h);
  check("a single old exchange decays", h.current < Math.max(...h.points), h.points);
}

{
  const h = relationshipHealth([row(at(1), null, "google_calendar")], { now: NOW, cadenceDays: 1 })!;
  check("cadence clamps to a 14-day floor", h.components.recency > 0.9, h.components);
}

{
  const h = relationshipHealth([row(at(260), null, "google_calendar")], { now: NOW, cadenceDays: 14 })!;
  check("a scored point is never 0 (0 means no touch yet)", h.current === 1, h.current);
}

console.log("\nsmoke-relationship-health: all checks passed");
