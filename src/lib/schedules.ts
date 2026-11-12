/**
 * Everything Orbit runs on a clock, as one table, and the matcher that decides what is due.
 *
 * ONE outside schedule drives all of it: a tick every five minutes to `POST /api/cron/tick`
 * (`scripts/qstash-schedules.ts`). The tick works out which jobs below fall inside its
 * five-minute window and starts each one. That is 288 calls a day, inside QStash's free
 * tier (1,000 a day) and within reach of any free cron service, where a schedule per job
 * would be about 1,100 calls a day and need a paid plan.
 *
 * Crons are UTC. A minute that is not a multiple of five (":17") runs at the tick that closes
 * its window (":20"), so a job may start up to four minutes after its listed minute. Each
 * job's own minute still keeps it apart from the others.
 */

export type JobSchedule = { id: string; cron: string; method: "GET" | "POST"; path: string };

export const TICK_MINUTES = 5;
export const TICK_PATH = "/api/cron/tick";

export const JOB_SCHEDULES: readonly JobSchedule[] = [
  // Every ten minutes: the alerting path, the outbound drains, the credit emails.
  { id: "ops-sweep", cron: "*/10 * * * *", method: "POST", path: "/api/ops/sweep" },
  { id: "webhooks-drain", cron: "*/10 * * * *", method: "POST", path: "/api/webhooks/outbound/drain" },
  { id: "connectors-outbox", cron: "*/10 * * * *", method: "POST", path: "/api/connectors/outbox/drain" },
  { id: "email-drain", cron: "*/10 * * * *", method: "POST", path: "/api/email/drain" },
  { id: "credit-notices", cron: "*/10 * * * *", method: "POST", path: "/api/credits/notices" },
  { id: "sync-run", cron: "*/15 * * * *", method: "POST", path: "/api/sync/run" },
  // Every quarter-hour on its own minutes: email insights reads mail metadata, apart from the sync.
  { id: "email-intel", cron: "5,20,35,50 * * * *", method: "POST", path: "/api/email-intel/sweep" },
  { id: "cloud-notes", cron: "29,59 * * * *", method: "POST", path: "/api/cloud-notes/run" },
  // Hourly, each on its own minute so no two long jobs are in flight together.
  { id: "process-stalled", cron: "7 * * * *", method: "GET", path: "/api/imports/process-stalled" },
  // Radar's pass: each account is due at its own local 5am, and same-day alerts follow it.
  { id: "radar-run", cron: "17 * * * *", method: "POST", path: "/api/radar/run" },
  { id: "jobs-feed", cron: "23 * * * *", method: "POST", path: "/api/jobs/feed/sweep" },
  { id: "work-history", cron: "37 * * * *", method: "POST", path: "/api/work-history/sweep" },
  { id: "name-sweep", cron: "43 * * * *", method: "POST", path: "/api/contacts/name-sweep" },
  { id: "radar-web", cron: "53 * * * *", method: "POST", path: "/api/radar/web" },
  // Every hour of Sunday AND Monday UTC: the route sends only to people whose own Monday
  // 06:00–09:00 it is (Auckland's Monday morning is Sunday evening in UTC).
  { id: "radar-digest", cron: "13 * * * 0,1", method: "POST", path: "/api/radar/digest" },
  // Daily, weekly, monthly.
  { id: "ops-rollup", cron: "31 0 * * *", method: "POST", path: "/api/ops/rollup" },
  { id: "speech-usage", cron: "41 5 * * *", method: "POST", path: "/api/ops/speech-usage" },
  { id: "billing-reconcile", cron: "23 6 * * *", method: "POST", path: "/api/ops/billing-reconcile" },
  { id: "weekly-digest", cron: "47 13 * * 1", method: "POST", path: "/api/ops/weekly-digest" },
  { id: "contacts-upkeep", cron: "19 3 1 * *", method: "POST", path: "/api/contacts/monthly-upkeep" },
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
 * The window a tick arriving at `now` stands for: the five minutes ending at the nearest
 * five-minute mark. Rounding (not flooring) means a tick that lands a minute or two late, or
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
