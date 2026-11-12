/**
 * The LinkedIn photo queue: every LinkedIn person (slug) across all accounts, most-shared
 * first, paced so LinkedIn does not start refusing us. An admin starts it from
 * /admin/product/photos; it then continues itself, one route invocation at a time.
 *
 * There is no queue table. A slug is pending while it has no `linkedin_avatars` row (or only
 * a stale "found nothing" row); every slug the queue attempts ends with a row, unless nothing
 * could be asked, and then the run pauses with that slug still pending. So the candidate query
 * IS the queue.
 *
 * LinkedIn refuses unauthenticated profile fetches from datacenter IPs (Vercel's), usually on
 * the first request. A refusal therefore only turns LinkedIn off for a backoff window; the run
 * keeps going on Unavatar/Microlink within their daily allowance, and pauses only when those
 * are spent too.
 *
 * The run's state is one `cron_runs` row (job `avatars.linkedin-queue`). Its stats hold:
 *   total, found, missed: progress
 *   directOffUntil (ms), strikes, lastRefusal: the durable LinkedIn backoff and why it started
 *   resumeAt (ms): the run is paused until then (nothing left to ask)
 *   leaseUntil (ms): one tick at a time, whoever kicks it
 *   stopped: an admin stopped it
 */
import { createHash } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, cronRuns } from "@/db/schema";
import { AVATAR_RECHECK_DAYS } from "@/lib/avatar-backfill";
import {
  AvatarSourceRateLimitError,
  AvatarStorageError,
  fetchLinkedInPhoto,
  hasBlobStorage,
  isLinkedInProfilePhoto,
} from "@/lib/contact-avatar";
import { LINKEDIN_HOST_RE } from "@/lib/contact-avatar-sql";
import { internalFetch } from "@/lib/internal-auth";
import {
  fetchLinkedInOgImageDirect,
  isLinkedInDirectRateLimited,
  LinkedInDirectRateLimitError,
} from "@/lib/linkedin-scraper";
import { notTourExample } from "@/lib/onboarding-examples/sql";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { SHARED_FILL_RESERVE, avatarFillLeft, sharedAllowanceLeft } from "@/lib/shared-avatar-upkeep";
import {
  adoptPhotoIntoSharedPool,
  adoptSharedPhoto,
  getSharedAvatar,
  upsertSharedAvatar,
} from "@/lib/shared-avatars";

export const QUEUE_JOB = "avatars.linkedin-queue";
/** Gap between two LinkedIn profile requests: ~15 a minute. */
export const QUEUE_PACE_MS = 4_000;
/** Work per tick; the route's ceiling is 300 s. */
export const QUEUE_TICK_BUDGET_MS = 240_000;
const LEASE_MS = 300_000;
const BATCH = 60;
const BASE_PAUSE_MS = 30 * 60_000;
const MAX_PAUSE_MS = 6 * 60 * 60_000;
/** Shortest wait when a run has nothing it can ask (LinkedIn's own cooldown, not a strike). */
const MIN_PAUSE_MS = 10 * 60_000;

/** Pause after the `strikes`-th LinkedIn refusal in a row: 30 min, doubling, at most 6 h. */
export function pauseMsFor(strikes: number): number {
  return Math.min(MAX_PAUSE_MS, BASE_PAUSE_MS * 2 ** strikes);
}

/**
 * Slugs still to do. Stale photos are left out on purpose: they still display, and a miss on
 * one never marks it done, so the queue would loop on it.
 * ponytail: linear in contacts with a slug, per batch and per admin poll; keep a per-slug
 * worklist table if contacts grow past ~100k.
 */
function pendingFrom() {
  return sql`
    FROM contacts
   WHERE linkedin_slug IS NOT NULL
     AND linkedin_url ~* ${LINKEDIN_HOST_RE}
     AND ${notTourExample(contacts.source)}
     AND NOT EXISTS (
       SELECT 1 FROM linkedin_avatars la
        WHERE la.slug = contacts.linkedin_slug
          AND (la.blocked_at IS NOT NULL
               OR la.image_url IS NOT NULL
               OR la.resolved_at > now() - make_interval(days => ${AVATAR_RECHECK_DAYS})))`;
}

export async function countPendingSlugs(): Promise<number> {
  const db = await getDb();
  const r = await db.execute(sql`SELECT count(DISTINCT linkedin_slug)::int AS n ${pendingFrom()}`);
  return Number(rowsOf<{ n: number }>(r)[0]?.n ?? 0);
}

/** The next pending slugs, most-shared first, then by slug. */
export async function nextPendingSlugs(limit = BATCH): Promise<string[]> {
  const db = await getDb();
  const r = await db.execute(sql`
    SELECT linkedin_slug AS slug ${pendingFrom()}
     GROUP BY linkedin_slug
     ORDER BY count(*) DESC, linkedin_slug
     LIMIT ${limit}`);
  return rowsOf<{ slug: string }>(r).map((x) => x.slug);
}

type QueueStats = Record<string, number | boolean>;

/** Merge `patch` into the run's stats; returns the run's status (null: no such run). */
async function patchRun(runId: string, patch: QueueStats): Promise<string | null> {
  const db = await getDb();
  const r = await db.execute(sql`
    UPDATE cron_runs SET stats = stats || ${JSON.stringify(patch)}::jsonb
     WHERE id = ${runId} RETURNING status`);
  return rowsOf<{ status: string }>(r)[0]?.status ?? null;
}

async function closeRun(runId: string, status: "ok" | "failed", error?: string) {
  const db = await getDb();
  await db.execute(sql`
    UPDATE cron_runs
       SET status = ${status}, finished_at = now(), error = ${error ?? null},
           duration_ms = (extract(epoch from now() - started_at) * 1000)::int,
           stats = stats || '{"leaseUntil":0}'::jsonb
     WHERE id = ${runId} AND status = 'running'`);
}

/** Takes the run's lease if it is running, unleased and not paused. Returns its stats, or null. */
async function claimLease(runId: string, now: number): Promise<QueueStats | null> {
  const db = await getDb();
  const r = await db.execute(sql`
    UPDATE cron_runs SET stats = stats || ${JSON.stringify({ leaseUntil: now + LEASE_MS })}::jsonb
     WHERE id = ${runId} AND job = ${QUEUE_JOB} AND status = 'running'
       AND coalesce((stats->>'leaseUntil')::bigint, 0) < ${now}
       AND coalesce((stats->>'resumeAt')::bigint, 0) <= ${now}
     RETURNING stats`);
  return rowsOf<{ stats: QueueStats }>(r)[0]?.stats ?? null;
}

/** Whether the quota'd fallbacks (Unavatar, Microlink) may take one more lookup. */
async function claimFallback(): Promise<boolean> {
  const left = await Promise.all([sharedAllowanceLeft("unavatar"), sharedAllowanceLeft("microlink")]);
  if (Math.min(...left) <= SHARED_FILL_RESERVE) return false;
  try {
    // Shared with the hourly fill: also caps a paid Microlink key, which skips the allowance.
    await consumeBucket("avatarFill", "daily", RATE_LIMITS.avatarFill);
    return true;
  } catch (err) {
    if (isRateLimitedError(err)) return false;
    throw err;
  }
}

/**
 * Per-tick state, persisted on the run row after every person.
 *   directOffUntil: LinkedIn refused us; ask it again after this (ms).
 *   strikes: refusals in a row, for the backoff.
 *   lastRefusal: why (`LinkedInDirectRateLimitError.status`).
 *   fallbacks: whether Unavatar/Microlink still had room this tick.
 */
type TickState = { directOffUntil: number; strikes: number; lastRefusal: number; fallbacks: boolean };

/** "blocked": nothing could be asked (LinkedIn off and fallbacks spent); the slug is left pending. */
export type SlugOutcome = "found" | "missed" | "blocked";

/**
 * One slug. LinkedIn directly while it answers; a refusal turns it off for a backoff window
 * instead of stopping the run. Then (on a miss, or with LinkedIn off) Unavatar and Microlink
 * while they have room. A real answer from either writes a row; nothing asked writes nothing.
 */
async function resolveSlug(slug: string, st: TickState): Promise<SlugOutcome> {
  let askedLinkedIn = false;
  if (Date.now() >= st.directOffUntil && !isLinkedInDirectRateLimited()) {
    try {
      const direct = await fetchLinkedInOgImageDirect(slug);
      askedLinkedIn = true;
      st.strikes = 0;
      if (direct && isLinkedInProfilePhoto(direct) && (await adoptPhotoIntoSharedPool(slug, direct, "linkedin_direct"))) {
        return "found";
      }
    } catch (err) {
      if (!(err instanceof LinkedInDirectRateLimitError)) throw err;
      st.lastRefusal = err.status;
      st.directOffUntil = Date.now() + pauseMsFor(st.strikes);
      st.strikes += 1;
    }
  }
  if (st.fallbacks && (st.fallbacks = await claimFallback())) {
    try {
      const systemId = `system:avatar-queue:${createHash("sha256").update(slug).digest("hex").slice(0, 16)}`;
      const got = await fetchLinkedInPhoto(`https://www.linkedin.com/in/${slug}`, systemId, { sharedSlug: slug }, { skipDirect: true });
      if (got && (await adoptSharedPhoto(slug, await getSharedAvatar(slug), got.url, got.source))) return "found";
      await upsertSharedAvatar({ slug, imageUrl: null, source: "linkedin_direct" });
      return "missed";
    } catch (err) {
      if (!(err instanceof AvatarSourceRateLimitError)) throw err;
      st.fallbacks = false;
    }
  }
  if (!askedLinkedIn) return "blocked";
  // LinkedIn answered "no photo" and the fallbacks are spent: that answer stands for 30 days.
  await upsertSharedAvatar({ slug, imageUrl: null, source: "linkedin_direct" });
  return "missed";
}

export type TickResult = "not-claimed" | "paused" | "stopped" | "done" | "continue" | "failed";

/**
 * One tick of run `runId`: claim the lease, work through pending slugs with `paceMs` between
 * them until `budgetMs` runs out, then hand over to the next tick (`kick`).
 */
export async function runLinkedInPhotoQueueTick(
  runId: string,
  opts: { paceMs?: number; budgetMs?: number; kick?: (runId: string) => Promise<void> } = {}
): Promise<TickResult> {
  const paceMs = opts.paceMs ?? QUEUE_PACE_MS;
  const deadline = Date.now() + (opts.budgetMs ?? QUEUE_TICK_BUDGET_MS);
  const kick = opts.kick ?? kickLinkedInPhotoQueue;

  const claimed = await claimLease(runId, Date.now());
  if (!claimed) return "not-claimed";
  let found = Number(claimed.found ?? 0);
  let missed = Number(claimed.missed ?? 0);
  const st: TickState = {
    directOffUntil: Number(claimed.directOffUntil ?? 0),
    strikes: Number(claimed.strikes ?? 0),
    lastRefusal: Number(claimed.lastRefusal ?? 0),
    fallbacks: true,
  };
  const progress = () => ({ found, missed, strikes: st.strikes, directOffUntil: st.directOffUntil, lastRefusal: st.lastRefusal });

  try {
    while (Date.now() < deadline) {
      const slugs = await nextPendingSlugs();
      if (slugs.length === 0) {
        await patchRun(runId, progress());
        await closeRun(runId, "ok");
        return "done";
      }
      for (const slug of slugs) {
        if (Date.now() >= deadline) break;
        const outcome = await resolveSlug(slug, st);
        if (outcome === "blocked") {
          // LinkedIn is off and today's fallback lookups are spent: wait for the next LinkedIn
          // retry (at most 6 h), when the daily allowance may have reset too.
          const resumeAt = Math.max(st.directOffUntil, Date.now() + MIN_PAUSE_MS);
          await patchRun(runId, { ...progress(), resumeAt, leaseUntil: 0 });
          return "paused";
        }
        if (outcome === "found") found += 1;
        else missed += 1;
        // Progress for the admin panel, and the status read that lets Stop land within a slug.
        if ((await patchRun(runId, progress())) !== "running") return "stopped";
        if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
      }
    }
  } catch (err) {
    if (err instanceof AvatarStorageError) {
      await closeRun(runId, "failed", "Photo storage refused a write");
      reportError(err, { where: "job.linkedin-photo-queue" });
      return "failed";
    }
    // Anything else: free the lease, and the hourly backstop picks the run up again.
    await patchRun(runId, { ...progress(), leaseUntil: 0 }).catch(() => null);
    throw err;
  }
  await patchRun(runId, { leaseUntil: 0 });
  await kick(runId);
  return "continue";
}

export async function kickLinkedInPhotoQueue(runId: string): Promise<void> {
  try {
    await internalFetch("/api/avatars/linkedin-queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    });
  } catch (err) {
    reportError(err, { where: "job.linkedin-photo-queue.kick", level: "warning" });
  }
}

async function latestRun() {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(cronRuns)
    .where(eq(cronRuns.job, QUEUE_JOB))
    .orderBy(desc(cronRuns.startedAt))
    .limit(1);
  return row ?? null;
}

/** Starts a run, or resumes the running one now (clearing any pause). Returns its id. */
export async function startLinkedInPhotoQueue(
  kick: (runId: string) => Promise<void> = kickLinkedInPhotoQueue
): Promise<string> {
  const active = await latestRun();
  if (active?.status === "running") {
    // Resume now: also ask LinkedIn again straight away.
    await patchRun(active.id, { resumeAt: 0, directOffUntil: 0 });
    await kick(active.id);
    return active.id;
  }
  const db = await getDb();
  const total = await countPendingSlugs();
  const [row] = await db
    .insert(cronRuns)
    .values({
      job: QUEUE_JOB,
      trigger: "manual",
      status: "running",
      stats: { total, found: 0, missed: 0, strikes: 0, directOffUntil: 0, lastRefusal: 0, resumeAt: 0, leaseUntil: 0 },
    })
    .returning();
  await kick(row.id);
  return row.id;
}

export async function stopLinkedInPhotoQueue(): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE cron_runs
       SET status = 'partial', finished_at = now(),
           duration_ms = (extract(epoch from now() - started_at) * 1000)::int,
           stats = stats || '{"stopped":true,"leaseUntil":0}'::jsonb
     WHERE job = ${QUEUE_JOB} AND status = 'running'`);
}

/** Hourly backstop: a running queue whose pause ended, or whose chain was lost, gets kicked. */
export async function resumeLinkedInPhotoQueueIfDue(now = Date.now()): Promise<boolean> {
  const run = await latestRun();
  if (run?.status !== "running") return false;
  const s = run.stats ?? {};
  if (Number(s.leaseUntil ?? 0) >= now || Number(s.resumeAt ?? 0) > now) return false;
  await kickLinkedInPhotoQueue(run.id);
  return true;
}

export async function isLinkedInPhotoQueueRunning(): Promise<boolean> {
  return (await latestRun())?.status === "running";
}

/** "fallbacks": running, but LinkedIn is refusing us, so only Unavatar/Microlink are asked. */
export type LinkedInPhotoQueueState = "idle" | "running" | "fallbacks" | "paused" | "waiting" | "done" | "stopped" | "failed";

export type LinkedInPhotoQueueMetrics = {
  blobReady: boolean;
  pending: number;
  state: LinkedInPhotoQueueState;
  run: {
    startedAt: string;
    total: number;
    found: number;
    missed: number;
    resumeAt: number | null;
    /** LinkedIn is off until then (ms), and why: its HTTP status, or 1 for an authwall. */
    directOffUntil: number | null;
    lastRefusal: number | null;
    error: string | null;
  } | null;
  /** Fallback (Unavatar/Microlink) lookups the queue may still spend today. */
  fallbackLeftToday: number;
  /** People per hour over the run so far, pauses included, so the estimate stays honest. */
  perHour: number | null;
  /** Estimated ms to clear `pending` at `perHour`, and the moment that lands (epoch ms). */
  etaMs: number | null;
  finishAt: number | null;
};

export async function getLinkedInPhotoQueueMetrics(now = Date.now()): Promise<LinkedInPhotoQueueMetrics> {
  const [pending, run, unavatar, microlink, fill] = await Promise.all([
    countPendingSlugs(),
    latestRun(),
    sharedAllowanceLeft("unavatar"),
    sharedAllowanceLeft("microlink"),
    avatarFillLeft(),
  ]);
  const blobReady = hasBlobStorage();
  // The same rule as claimFallback: the shared reserve is kept for interactive lookups.
  const fallbackLeftToday = Math.max(0, Math.min(unavatar - SHARED_FILL_RESERVE, microlink - SHARED_FILL_RESERVE, fill));
  if (!run) return { blobReady, pending, state: "idle", run: null, fallbackLeftToday, perHour: null, etaMs: null, finishAt: null };

  const s = run.stats ?? {};
  const found = Number(s.found ?? 0);
  const missed = Number(s.missed ?? 0);
  const resumeAt = Number(s.resumeAt ?? 0);
  const directOffUntil = Number(s.directOffUntil ?? 0);
  const lastRefusal = Number(s.lastRefusal ?? 0);
  const state: LinkedInPhotoQueueState =
    run.status === "running"
      ? resumeAt > now
        ? "paused"
        : Number(s.leaseUntil ?? 0) >= now
          ? directOffUntil > now
            ? "fallbacks"
            : "running"
          : "waiting"
      : run.status === "ok"
        ? "done"
        : run.status === "failed"
          ? "failed"
          : "stopped";

  const elapsedMs = (run.finishedAt?.getTime() ?? now) - run.startedAt.getTime();
  const done = found + missed;
  const perHour = done > 0 && elapsedMs > 60_000 ? (done / elapsedMs) * 3_600_000 : null;
  const etaMs = perHour && pending > 0 && run.status === "running" ? (pending / perHour) * 3_600_000 : null;

  return {
    blobReady,
    pending,
    state,
    run: {
      startedAt: run.startedAt.toISOString(),
      total: Number(s.total ?? 0),
      found,
      missed,
      resumeAt: resumeAt > now ? resumeAt : null,
      directOffUntil: directOffUntil > now ? directOffUntil : null,
      lastRefusal: lastRefusal || null,
      error: run.error,
    },
    fallbackLeftToday,
    perHour,
    etaMs,
    finishAt: etaMs ? now + etaMs : null,
  };
}
