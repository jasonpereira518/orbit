/**
 * Radar's rhythm (docs/superpowers/specs/2026-11-10-radar-analyst-design.md): a weekly plan
 * that stays put, and a small Today strip for things that expire.
 *
 *   - The first run of a person's local week builds the plan ("weekly"). The scheduled one
 *     lands Monday about 5am local; an account with no plan yet this week gets one on any run.
 *   - Every later run that week is a light "daily" pass. It never reshuffles the plan. It adds
 *     moments to the Today strip (capped per plan) and retires cards whose person has no
 *     reason left.
 *
 * Pure: the run reads, these decide, `writeRunResult` writes.
 */
import { isoWeekOf, localClock } from "@/lib/radar/digest";
import { rankPicks, type RadarPick } from "@/lib/radar/score";
import { leadReason, recommendationKey, type RecommendationBucket, type RecommendationKind } from "@/lib/radar/types";

export type RadarRunMode = "weekly" | "daily";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A run never schedules the next one sooner than this, so a 02:00 page view skips 05:00. */
const MIN_GAP_MS = 6 * HOUR_MS;

/** The next 5:00 AM in `tz`, at least `MIN_GAP_MS` away. */
export function nextLocal5am(now: Date, tz: string = "UTC"): Date {
  const { hour, ymd } = localClock(now, tz);
  const [y, m, d] = ymd.split("-").map(Number);
  const targetDay = new Date(Date.UTC(y!, m! - 1, d! + (hour < 4 ? 0 : 1)));
  const ymdTarget = targetDay.toISOString().slice(0, 10);
  const guess = new Date(`${ymdTarget}T05:00:00Z`);
  const check = localClock(guess, tz);
  let hourDiff = 5 - check.hour;
  if (hourDiff > 12) hourDiff -= 24;
  if (hourDiff < -12) hourDiff += 24;
  let target = new Date(guess.getTime() + hourDiff * HOUR_MS);
  while (target.getTime() - now.getTime() < MIN_GAP_MS) {
    target = new Date(target.getTime() + DAY_MS);
  }
  return target;
}

/** Weekly unless a weekly build already ran in this person's current local week. */
export function radarRunMode(lastWeeklyAt: Date | null, now: Date, tz: string): RadarRunMode {
  if (!lastWeeklyAt) return "weekly";
  return isoWeekOf(localClock(lastWeeklyAt, tz).ymd) === isoWeekOf(localClock(now, tz).ymd) ? "daily" : "weekly";
}

/** The next scheduled run: tomorrow at 5am local, or next Monday's when the daily pass is off. */
export function nextRadarRunAt(now: Date, tz: string, dailyEnabled: boolean): Date {
  let next = nextLocal5am(now, tz);
  if (dailyEnabled) return next;
  for (let i = 0; i < 7 && localClock(next, tz).weekday !== 1; i++) next = nextLocal5am(new Date(next.getTime() + HOUR_MS), tz);
  return next;
}

/** Due within two days: a meeting or event, a due date. */
const DATED_MOMENTS: ReadonlySet<string> = new Set(["upcoming_meeting", "event_upcoming", "email_prep", "opportunity_due"]);
/** Fresh for two days after Orbit learns it: news about them that goes stale. */
const FRESH_MOMENTS: ReadonlySet<string> = new Set(["job_change", "job_change_left", "social_post", "public_mention", "email_followup", "email_job", "email_process", "email_news", "email_event"]);
/** A moment for as long as it lasts: someone is waiting on the person. */
const OWED_MOMENTS: ReadonlySet<string> = new Set(["inbound_unanswered", "open_thread", "opportunity_overdue"]);
const MOMENT_WINDOW_MS = 2 * DAY_MS;

/**
 * Whether a card belongs on the Today strip: its lead reason expires soon. Read from the
 * lead's own evidence date (evidence is lead-first), so it never needs the run's signals.
 */
export function isMoment(pick: Pick<RadarPick, "reasons" | "evidence">, now: Date): boolean {
  const lead = leadReason(pick.reasons);
  if (!lead) return false;
  if (OWED_MOMENTS.has(lead.code)) return true;
  const evidence = pick.evidence.find((e) => e.code === lead.code) ?? pick.evidence[0];
  const at = evidence?.at ? new Date(evidence.at).getTime() : NaN;
  if (Number.isNaN(at)) return false;
  if (DATED_MOMENTS.has(lead.code)) return at - now.getTime() <= MOMENT_WINDOW_MS && at >= now.getTime() - DAY_MS;
  if (FRESH_MOMENTS.has(lead.code)) return now.getTime() - at <= MOMENT_WINDOW_MS;
  return false;
}

const bucketOf = (pick: Pick<RadarPick, "reasons" | "evidence">, now: Date): RecommendationBucket => (isMoment(pick, now) ? "today" : "soon");

type Limits = { planSize: number; todayMax: number };

/**
 * The week's list: the plan (best `planSize`, at most half of any one kind), plus moments that
 * did not make the plan, up to the Today strip's room. Moments in the plan count against it.
 */
export function composeWeek<T extends RadarPick>(ranked: readonly T[], limits: Limits, now: Date): T[] {
  const tagged = ranked.map((p) => ({ ...p, bucket: bucketOf(p, now) }));
  const plan = rankPicks(tagged, { pending: limits.planSize, perKind: Math.max(1, Math.floor(limits.planSize / 2)) });
  const inPlan = new Set(plan.map((p) => p.contactId));
  const room = Math.max(0, limits.todayMax - plan.filter((p) => p.bucket === "today").length);
  const extra = rankPicks(
    tagged.filter((p) => p.bucket === "today" && !inPlan.has(p.contactId)),
    { pending: room, perKind: room }
  );
  return [...plan, ...extra];
}

export type LiveCard = { contactId: string; kind: RecommendationKind; bucket: RecommendationBucket | null; status: string };

export type DayResult<T> = {
  /** New Today cards, for people with no live card. */
  insert: T[];
  /** Live cards (`contactId:kind`) whose reason is now a moment: they move to Today. */
  promote: string[];
  /** People who still have a reason. A pending card for anyone else is retired. */
  keepContacts: Set<string>;
};

/**
 * One daily pass over a live plan. The plan's rows are left as they are; only the Today strip
 * changes, and only a person with no reason left loses their card.
 */
export function composeDay<T extends RadarPick>(ranked: readonly T[], live: readonly LiveCard[], limits: Pick<Limits, "todayMax">, now: Date): DayResult<T> {
  const liveByKey = new Map(live.map((c) => [recommendationKey(c.contactId, c.kind), c]));
  const liveContacts = new Set(live.map((c) => c.contactId));
  const keepContacts = new Set(ranked.map((p) => p.contactId));
  const moments = ranked.filter((p) => isMoment(p, now)).map((p) => ({ ...p, bucket: "today" as const }));

  const promote = moments
    .map((p) => recommendationKey(p.contactId, p.kind))
    .filter((key) => {
      const card = liveByKey.get(key);
      return card !== undefined && card.status === "pending" && card.bucket !== "today";
    });
  const onToday = live.filter((c) => c.bucket === "today" && c.status === "pending" && keepContacts.has(c.contactId)).length + promote.length;
  const room = Math.max(0, limits.todayMax - onToday);
  const insert = rankPicks(
    moments.filter((p) => !liveContacts.has(p.contactId)),
    { pending: room, perKind: room }
  );
  return { insert, promote, keepContacts };
}
