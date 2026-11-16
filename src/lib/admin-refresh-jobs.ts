/**
 * The admin Refresh page's job list (`/admin/health/refresh`).
 *
 * Every entry wraps an engine that already runs on a schedule; nothing here does new work.
 * "All users" posts the same internal route the GitHub Actions scheduler does, with the
 * manual-trigger header so the `cron_runs` row says an operator started it. "One user" uses
 * the per-user kick each engine already has (the route answers at once and works the backlog
 * in `after()`), or the per-user function directly where there is no route.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { markCohortDirty } from "@/lib/closeness-materialize";
import { kickMonthlyUpkeep } from "@/lib/contact-monthly-upkeep";
import { kickNameSweep } from "@/lib/contact-name-sweep";
import { CRON_TRIGGER_HEADER, type CronJobName } from "@/lib/cron-runs";
import { kickEmbeddingBackfill } from "@/lib/embedding-backfill";
import { internalFetch } from "@/lib/internal-auth";
import { kickLinkedInTimelineBackfill } from "@/lib/linkedin-timeline-backfill";

export type RefreshJob = {
  key: string;
  label: string;
  description: string;
  /** The ledger entry whose last run the card shows; null for jobs with no scheduled run. */
  cronJob: CronJobName | null;
  /** Internal route for an all-users run, called the way the scheduler calls it. */
  allRoute: { path: string; method: "GET" | "POST" } | null;
  runOne: ((userId: string) => Promise<void>) | null;
};

export const REFRESH_JOBS: RefreshJob[] = [
  {
    key: "contact-upkeep",
    label: "Photos and names",
    description:
      "Re-checks missing, placeholder and stale photos, and repairs names saved as handles or email prefixes.",
    cronJob: "contacts.monthly-upkeep",
    allRoute: { path: "/api/contacts/monthly-upkeep", method: "POST" },
    runOne: (userId) => kickMonthlyUpkeep(userId),
  },
  {
    key: "names",
    label: "Names pass",
    description: "Runs the names engine again over contacts saved under a handle, email or username.",
    cronJob: "contacts.name-sweep",
    allRoute: { path: "/api/contacts/name-sweep", method: "POST" },
    runOne: (userId) => kickNameSweep(userId),
  },
  {
    key: "work-history",
    label: "Work history",
    description: "Researches current roles and past employers for contacts whose history is due.",
    cronJob: "work-history.sweep",
    allRoute: { path: "/api/work-history/sweep", method: "POST" },
    runOne: null,
  },
  {
    key: "search-index",
    label: "Search index",
    description: "Embeds contacts, meetings and note passages that have no search vector yet.",
    cronJob: null,
    allRoute: null,
    runOne: (userId) => kickEmbeddingBackfill(userId),
  },
  {
    key: "linkedin-timeline",
    label: "LinkedIn timeline",
    description: "Turns imported LinkedIn messages into timeline events.",
    cronJob: null,
    allRoute: null,
    runOne: (userId) => kickLinkedInTimelineBackfill(userId),
  },
  {
    key: "closeness",
    label: "Closeness scores",
    description: "Marks the account's scores stale; the next background pass rescores them.",
    cronJob: null,
    allRoute: null,
    runOne: (userId) => markCohortDirty(userId),
  },
  {
    key: "backstop",
    label: "Background backstop",
    description:
      "Resumes stalled imports and catches up search index, timeline, closeness and the shared photo pool for every account.",
    cronJob: "imports.process-stalled",
    allRoute: { path: "/api/imports/process-stalled", method: "GET" },
    runOne: null,
  },
  {
    key: "radar",
    label: "Radar",
    description: "Rebuilds Radar picks for accounts that have Radar on.",
    cronJob: "radar.run",
    allRoute: { path: "/api/radar/run", method: "POST" },
    runOne: null,
  },
  {
    key: "sync",
    label: "Connector and calendar sync",
    description: "Pulls new mail, contacts and calendar events from connected accounts that are due.",
    cronJob: "sync.run",
    allRoute: { path: "/api/sync/run", method: "POST" },
    runOne: null,
  },
];

export function findRefreshJob(key: string): RefreshJob | null {
  return REFRESH_JOBS.find((j) => j.key === key) ?? null;
}

/** Long enough for the route to finish (its own ceiling is 300s); callers run this in `after()`. */
const ALL_USERS_TIMEOUT_MS = 300_000;

/** Runs the job's scheduled route now, logged in `cron_runs` as `manual`. */
export async function runRefreshJobForAll(job: RefreshJob): Promise<void> {
  if (!job.allRoute) throw new Error(`${job.label} has no all-users run`);
  const res = await internalFetch(job.allRoute.path, {
    method: job.allRoute.method,
    headers: { [CRON_TRIGGER_HEADER]: "manual" },
    signal: AbortSignal.timeout(ALL_USERS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${job.allRoute.path} answered HTTP ${res.status}`);
}

/** Accepts a user id or an account email, so the operator can paste either. */
export async function resolveRefreshTarget(input: string): Promise<string | null> {
  const value = input.trim();
  if (!value) return null;
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: value.includes("@")
      ? sql`lower(${userSettings.email}) = ${value.toLowerCase()}`
      : eq(userSettings.userId, value),
    columns: { userId: true },
  });
  return row?.userId ?? null;
}
