/**
 * Everything Orbit runs on a clock, as one table, and the matcher that decides what is due.
 *
 * ONE outside schedule drives all of it: a tick every thirty minutes to `POST /api/cron/tick`
 * (`scripts/qstash-schedules.ts`), which starts each job below whose cron falls in its window.
 * 48 calls a day, so any free scheduler will do (QStash's free tier allows 1,000).
 *
 * WHY THIRTY MINUTES: the database is on Neon Free, 100 compute-hours a month, and Neon
 * suspends the compute after five idle minutes. Jobs spread across the hour (as GitHub's
 * schedule had them) keep it awake around the clock, about 180 compute-hours a month. Two
 * bursts an hour, everything at once, let it sleep in between: roughly 6 hours awake a
 * day, about 45 compute-hours, leaving the rest for people using the app. A faster tick
 * costs Neon hours; check the budget before shortening it.
 *
 * Crons are UTC and sit on the tick marks (:00 and :30), so a job runs at the minute it
 * lists. The hourly jobs are split between the two marks to halve each burst.
 */

export type JobSchedule = { id: string; cron: string; method: "GET" | "POST"; path: string };

export const TICK_MINUTES = 30;
export const TICK_PATH = "/api/cron/tick";

export const JOB_SCHEDULES: readonly JobSchedule[] = [
  // Every tick: the alerting path, the outbound drains, the credit emails, the syncs.
  { id: "ops-sweep", cron: "*/30 * * * *", method: "POST", path: "/api/ops/sweep" },
  { id: "webhooks-drain", cron: "*/30 * * * *", method: "POST", path: "/api/webhooks/outbound/drain" },
  { id: "connectors-outbox", cron: "*/30 * * * *", method: "POST", path: "/api/connectors/outbox/drain" },
  { id: "email-drain", cron: "*/30 * * * *", method: "POST", path: "/api/email/drain" },
  { id: "credit-notices", cron: "*/30 * * * *", method: "POST", path: "/api/credits/notices" },
  { id: "sync-run", cron: "*/30 * * * *", method: "POST", path: "/api/sync/run" },
  { id: "email-intel", cron: "*/30 * * * *", method: "POST", path: "/api/email-intel/sweep" },
  { id: "cloud-notes", cron: "*/30 * * * *", method: "POST", path: "/api/cloud-notes/run" },
  // Hourly, at :30.
  { id: "process-stalled", cron: "30 * * * *", method: "GET", path: "/api/imports/process-stalled" },
  // Radar's pass: each account is due at its own local 5am, and same-day alerts follow it.
  { id: "radar-run", cron: "30 * * * *", method: "POST", path: "/api/radar/run" },
  { id: "jobs-feed", cron: "30 * * * *", method: "POST", path: "/api/jobs/feed/sweep" },
  // Hourly, at :00.
  { id: "work-history", cron: "0 * * * *", method: "POST", path: "/api/work-history/sweep" },
  { id: "name-sweep", cron: "0 * * * *", method: "POST", path: "/api/contacts/name-sweep" },
  { id: "radar-web", cron: "0 * * * *", method: "POST", path: "/api/radar/web" },
  // Every hour of Sunday AND Monday UTC: the route sends only to people whose own Monday
  // 06:00–09:00 it is (Auckland's Monday morning is Sunday evening in UTC).
  { id: "radar-digest", cron: "0 * * * 0,1", method: "POST", path: "/api/radar/digest" },
  // Daily, weekly, monthly.
  { id: "ops-rollup", cron: "30 0 * * *", method: "POST", path: "/api/ops/rollup" },
  { id: "speech-usage", cron: "30 5 * * *", method: "POST", path: "/api/ops/speech-usage" },
  { id: "billing-reconcile", cron: "30 6 * * *", method: "POST", path: "/api/ops/billing-reconcile" },
  { id: "weekly-digest", cron: "0 14 * * 1", method: "POST", path: "/api/ops/weekly-digest" },
  { id: "contacts-upkeep", cron: "30 3 1 * *", method: "POST", path: "/api/contacts/monthly-upkeep" },
];

/** One cron field: `*`, `*\/n`, `a`, `a-b`, `a-b/n`, and comma lists of those. */
function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = 0;
      hi = Number.MAX_SAFE_INTEGER;
    } else if (range.includes("-")) {
      [lo, hi] = range.split("-").map(Number);
    } else {
      lo = Number(range);
      hi = stepText ? Number.MAX_SAFE_INTEGER : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false;
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** Whether a five-field cron fires at this UTC minute. Day-of-month and day-of-week OR together when both are set, as in cron. */
export function cronMatches(cron: string, at: Date): boolean {
  const [min, hour, dom, month, dow] = cron.trim().split(/\s+/);
  if (dow === undefined) return false;
  if (!fieldMatches(min, at.getUTCMinutes()) || !fieldMatches(hour, at.getUTCHours()) || !fieldMatches(month, at.getUTCMonth() + 1)) {
    return false;
  }
  const domOk = fieldMatches(dom, at.getUTCDate());
  const dowOk = fieldMatches(dow, at.getUTCDay());
  if (dom !== "*" && dow !== "*") return domOk || dowOk;
  return domOk && dowOk;
}

const MINUTE_MS = 60_000;
const TICK_MS = TICK_MINUTES * MINUTE_MS;

/**
 * The window a tick arriving at `now` stands for: the TICK_MINUTES ending at the nearest
 * tick mark. Rounding (not flooring) means a tick that lands a minute or two late, or
 * early, still covers exactly its own window, so jobs neither repeat nor go missing.
 */
export function tickWindow(now: Date): { from: Date; to: Date } {
  const to = Math.round(now.getTime() / TICK_MS) * TICK_MS;
  return { from: new Date(to - TICK_MS), to: new Date(to) };
}

/** The jobs whose cron fires at any minute in (from, to]. */
export function dueJobs(now: Date, table: readonly JobSchedule[] = JOB_SCHEDULES): JobSchedule[] {
  const { from, to } = tickWindow(now);
  return table.filter((job) => {
    for (let t = from.getTime() + MINUTE_MS; t <= to.getTime(); t += MINUTE_MS) {
      if (cronMatches(job.cron, new Date(t))) return true;
    }
    return false;
  });
}
