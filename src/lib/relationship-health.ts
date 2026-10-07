/**
 * Relationship health: is this relationship two-way and alive? DB-free.
 *
 * Closeness asks how important someone is; this asks how the exchange itself is going, from
 * three signals the interactions table already holds:
 *
 *   - recency     how long since the last touch, measured against the contact's own cadence
 *   - reciprocity whether both sides write (`direction` 'in' vs 'out')
 *   - latency     how fast replies come back, either way
 *
 * Derived on read from the rows, so the history behind the sparkline exists from day one and
 * any channel that writes `interactions` rows with a direction feeds it with no extra wiring
 * (chat imports included, once released).
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** How far back the reader loads rows: the sparkline span plus one signal window. */
export const HEALTH_LOOKBACK_DAYS = 270;
/** Trailing window for reciprocity and latency at each sample. */
const WINDOW_DAYS = 90;
/** A direction flip within this many days is a reply; past it, a new conversation. */
const REPLY_MAX_DAYS = 14;
/** An unanswered outbound counts against latency once it is older than this. */
const OPEN_GRACE_HOURS = 48;
/** Latency half-life: a 48h median reply scores 0.5. */
const LATENCY_HALF_LIFE_HOURS = 48;
const POINTS = 26;
const STEP_DAYS = 7;
const WEIGHTS = { recency: 0.4, reciprocity: 0.3, latency: 0.3 } as const;

/** Chat sessions end on whoever spoke last; the end of a session is not a reply. */
const SESSION_SOURCES = new Set(["whatsapp", "imessage"]);

export type HealthRow = {
  at: Date;
  direction: "in" | "out" | null;
  source: string | null;
};

export type HealthComponents = {
  recency: number;
  reciprocity: number | null;
  latency: number | null;
  daysSinceTouch: number;
  inbound: number;
  outbound: number;
  medianReplyHours: number | null;
};

export type RelationshipHealth = {
  /** Oldest first, one per week; the last is `current`. 0–100. */
  points: number[];
  current: number;
  components: HealthComponents;
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Rows must be sorted oldest first. Null when nothing at or before `t` exists. */
function scoreAt(rows: HealthRow[], t: number, halfLifeDays: number): HealthComponents | null {
  let last: HealthRow | null = null;
  const directed: HealthRow[] = [];
  for (const r of rows) {
    const at = r.at.getTime();
    if (at > t) break;
    last = r;
    if (r.direction && at > t - WINDOW_DAYS * DAY_MS) directed.push(r);
  }
  if (!last) return null;

  // ponytail: rows older than HEALTH_LOOKBACK_DAYS never load, so recency reads a long-quiet
  // contact as "no touch"; at that age the decay has already put it near zero.
  const daysSinceTouch = Math.max(0, (t - last.at.getTime()) / DAY_MS);
  const recency = 0.5 ** (daysSinceTouch / halfLifeDays);

  const inbound = directed.filter((r) => r.direction === "in").length;
  const outbound = directed.length - inbound;
  const reciprocity =
    inbound + outbound >= 2 ? Math.min(inbound, outbound) / Math.max(inbound, outbound) : null;

  const gaps: number[] = [];
  const replies = directed.filter((r) => !SESSION_SOURCES.has(r.source ?? ""));
  for (let i = 1; i < replies.length; i++) {
    if (replies[i].direction === replies[i - 1].direction) continue;
    const gap = replies[i].at.getTime() - replies[i - 1].at.getTime();
    if (gap <= REPLY_MAX_DAYS * DAY_MS) gaps.push(gap / HOUR_MS);
  }
  // Being left on read is the strongest latency signal there is: an outbound still open at
  // `t` counts as a reply that has taken (at least) this long.
  const tail = replies[replies.length - 1];
  if (tail?.direction === "out") {
    const open = (t - tail.at.getTime()) / HOUR_MS;
    if (open > OPEN_GRACE_HOURS) gaps.push(Math.min(open, REPLY_MAX_DAYS * 24));
  }
  const medianReplyHours = gaps.length ? median(gaps) : null;
  const latency = medianReplyHours == null ? null : 0.5 ** (medianReplyHours / LATENCY_HALF_LIFE_HOURS);

  return { recency, reciprocity, latency, daysSinceTouch, inbound, outbound, medianReplyHours };
}

function combine(c: HealthComponents): number {
  let sum = WEIGHTS.recency * c.recency;
  let weight = WEIGHTS.recency;
  if (c.reciprocity != null) {
    sum += WEIGHTS.reciprocity * c.reciprocity;
    weight += WEIGHTS.reciprocity;
  }
  if (c.latency != null) {
    sum += WEIGHTS.latency * c.latency;
    weight += WEIGHTS.latency;
  }
  // Floor of 1: 0 is reserved for "no touch yet", which the sparkline reads as such.
  return Math.max(1, Math.round((100 * sum) / weight));
}

/**
 * 26 weekly scores ending at `now`, or null when the contact has no touch in the window.
 * `cadenceDays` (the contact's keep-in-touch interval) sets the recency half-life, so a
 * quarterly friend is not "unhealthy" at day 40.
 */
export function relationshipHealth(
  rows: HealthRow[],
  opts: { now: Date; cadenceDays?: number | null }
): RelationshipHealth | null {
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  const now = opts.now.getTime();
  const halfLife = Math.min(120, Math.max(14, opts.cadenceDays ?? 30));
  const current = scoreAt(sorted, now, halfLife);
  if (!current) return null;

  const points: number[] = [];
  for (let i = POINTS - 1; i >= 0; i--) {
    const c = scoreAt(sorted, now - i * STEP_DAYS * DAY_MS, halfLife);
    // Before the first touch there is no relationship to score; draw it at the floor.
    points.push(c ? combine(c) : 0);
  }
  return { points, current: points[points.length - 1], components: current };
}
