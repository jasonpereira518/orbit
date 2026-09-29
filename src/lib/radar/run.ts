/**
 * One Radar run for one account: read the network, score it, replace the live list.
 *
 * Callers claim the account's lease first (`claimRadarLease`); the run releases it when it
 * finishes, whether it succeeded or not. Three callers, one code path:
 *
 *   - the nightly pass (`runRadarPass`, driven by `/api/radar/run`),
 *   - the page's first visit (`ensureRadarRun`, inline, bounded, no AI),
 *   - a stale page view (`maybeRefreshRadar`, in `after()`, no AI),
 *   - and the "Refresh now" button, through `src/actions/radar.ts`.
 *
 * `runRadarForUser` never throws. A failure is reported, recorded on the `radar_runs` row,
 * and retried sooner than a success would be.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, rowsOf, runAtomicWrite } from "@/db";
import { radarRuns, userSettings } from "@/db/schema";
import { goalRelevanceComponent } from "@/lib/closeness";
import { companyMatchKeys } from "@/lib/events/company-list-parse";
import { loadTargetKeys } from "@/lib/events/companies";
import { traced } from "@/lib/perf-trace";
import {
  NO_SUPPRESSION,
  RADAR_CAPS,
  pickWinner,
  rankPicks,
  scoreContactKinds,
  type RadarContact,
  type RadarPick,
  type RadarSuppression,
} from "@/lib/radar/score";
import { loadCandidates, produceInternalSignals, type RadarCandidateRow } from "@/lib/radar/signals/internal";
import {
  detectRadarOutcomes,
  loadModelTallies,
  loadLiveRecommendations,
  loadSuppressions,
  planRunResult,
  writeRunResult,
  type NewRecommendation,
} from "@/lib/radar/store";
import type { RadarModel, RadarRunTrigger, RadarSignal } from "@/lib/radar/types";
import { buildRadarModel } from "@/lib/radar/model";
import { RADAR_RERANK_TIMEOUT_MS, rerankPicks, rerankUnchanged } from "@/lib/radar/rerank";
import { applyAutopilot, loadRadarAutopilot } from "@/lib/radar/autopilot";
import { draftTodayForRun } from "@/lib/radar/drafts";
import { probeCompanyNews } from "@/lib/radar/signals/news";
import { explainTopForRun, openRadarAi } from "@/lib/radar/explain";
import { radarNoteKey } from "@/lib/radar/why-prompt";
import { reportError, reportUnlessQuiet } from "@/lib/report-error";
import { runSettledPool } from "@/lib/sync-scheduler";
import { deadlineAfter, deadlineReached } from "@/lib/time-budget";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";

const HOUR_MS = 3_600_000;

/** How long a claimed account stays claimed if its run dies without releasing it. */
export const RADAR_LEASE_MS = 10 * 60 * 1000;
/** The UTC hour the nightly pass aims every account at. `ops.yml` runs it at 04:17. */
export const RADAR_NIGHTLY_HOUR_UTC = 4;
/** A run never schedules the next one sooner than this, so a 02:00 page view skips 04:00. */
const MIN_GAP_MS = 6 * HOUR_MS;
/** A failed run retries after this, rather than waiting for the next night. */
const RETRY_AFTER_MS = 6 * HOUR_MS;
/** A page view older than this since the last run refreshes in the background. */
export const RADAR_STALE_MS = 24 * HOUR_MS;
/**
 * The most a run spends on AI, shared in order: the rerank (at most
 * `RADAR_RERANK_TIMEOUT_MS`), then Today's drafts, then the why-lines with whatever is left.
 */
export const RADAR_AI_BUDGET_MS = 25_000;
/**
 * The AI rerank's off switch. If `/admin/analytics/radar` shows cards it moved up are not
 * accepted more often than cards it moved down, it is noise: turn it off here.
 */
export const RADAR_RERANK_ENABLED = true;

export type RadarRunOptions = {
  trigger: RadarRunTrigger;
  now?: Date;
  /** Write the one-line AI "why" for Today's cards. Off for page-triggered runs. */
  ai?: boolean;
  /** Wall-clock budget for the parts that can be skipped (the AI lines). */
  budgetMs?: number;
};

export type RadarRunStats = {
  ok: boolean;
  candidates: number;
  signals: number;
  recommendations: number;
  inserted: number;
  updated: number;
  expired: number;
  aiNotes: number;
  skippedNoKey: boolean;
  /** Accepted cards that led to a real conversation since the last run. */
  outcomes: number;
  /** Cards the AI rerank moved, and whether it failed or reused a cached answer. */
  reranked: number;
  rerankFailed: boolean;
  rerankCached: boolean;
  /** Drafts written for Today's cards, and follow-ups autopilot scheduled. */
  drafts: number;
  autopilot: number;
  /** Headlines about someone's company that became signals this run. */
  news: number;
  durationMs: number;
};

/** The next nightly slot at least `MIN_GAP_MS` away. */
export function nextNightlyRunAt(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RADAR_NIGHTLY_HOUR_UTC, 0, 0));
  while (d.getTime() - now.getTime() < MIN_GAP_MS) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * Claim one account for a run. One statement: it succeeds only when no other run holds a
 * live lease, so a page view and the nightly pass cannot run one account twice.
 */
export async function claimRadarLease(userId: string, now: Date = new Date()): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(userSettings)
    .set({ radarLeaseUntil: new Date(now.getTime() + RADAR_LEASE_MS) })
    .where(
      and(
        eq(userSettings.userId, userId),
        or(isNull(userSettings.radarLeaseUntil), lt(userSettings.radarLeaseUntil, now))
      )
    )
    .returning();
  return rows.length > 0;
}

export type RadarState = {
  lastRunAt: Date | null;
  nextAt: Date | null;
  paused: boolean;
};

export async function loadRadarState(userId: string): Promise<RadarState | null> {
  const db = await getDb();
  const [row] = await db
    .select({
      lastRunAt: userSettings.radarLastRunAt,
      nextAt: userSettings.radarNextAt,
      paused: userSettings.radarPaused,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return row ? { lastRunAt: row.lastRunAt, nextAt: row.nextAt, paused: row.paused === 1 } : null;
}

function toRadarContact(row: RadarCandidateRow, targetKeys: Map<string, number>, goals: string[]): RadarContact {
  let targetPriority: 1 | 2 | 3 | null = null;
  for (const key of companyMatchKeys(row.company)) {
    const p = targetKeys.get(key);
    if (p !== undefined && (targetPriority === null || p < targetPriority)) targetPriority = Math.min(3, Math.max(1, p)) as 1 | 2 | 3;
  }
  return {
    id: row.id,
    company: row.company,
    tier: row.tier,
    priorityLevel: row.priorityLevel,
    relationshipScore: row.relationshipScore,
    statedCloseness: row.statedCloseness,
    firstInteractionAt: row.firstInteractionAt,
    lastInteractionAt: row.lastInteractionAt,
    nextFollowUpAt: row.nextFollowUpAt,
    constellationPin: row.constellationPin,
    cadenceDays: row.cadenceDays,
    cadencePhrase: row.cadencePhrase,
    targetPriority,
    goalFit: goals.length ? goalRelevanceComponent({ company: row.company, title: row.title, industry: row.industry }, goals) : 0,
    hasEvidence: row.hasEvidence,
  };
}

/** Score every candidate and keep the run's final list. Pure given its inputs. */
export function scoreCandidates(
  candidates: readonly RadarCandidateRow[],
  signals: readonly RadarSignal[],
  targetKeys: Map<string, number>,
  goals: string[],
  suppressions: Map<string, RadarSuppression>,
  now: Date,
  model: RadarModel | null = null
): NewRecommendation[] {
  return rankPicks(scorePicks(candidates, signals, targetKeys, goals, suppressions, now, model), RADAR_CAPS);
}

/** Every person's winning card, before the caps: what the rerank chooses its shortlist from. */
export function scorePicks(
  candidates: readonly RadarCandidateRow[],
  signals: readonly RadarSignal[],
  targetKeys: Map<string, number>,
  goals: string[],
  suppressions: Map<string, RadarSuppression>,
  now: Date,
  model: RadarModel | null = null
): NewRecommendation[] {
  const byContact = new Map<string, RadarSignal[]>();
  for (const s of signals) {
    const list = byContact.get(s.contactId);
    if (list) list.push(s);
    else byContact.set(s.contactId, [s]);
  }
  const picks: RadarPick[] = [];
  const rowById = new Map<string, RadarCandidateRow>();
  for (const row of candidates) {
    rowById.set(row.id, row);
    const contact = toRadarContact(row, targetKeys, goals);
    const kinds = scoreContactKinds(contact, byContact.get(row.id) ?? [], suppressions.get(row.id) ?? NO_SUPPRESSION, now, model);
    const pick = pickWinner(row.id, kinds, now);
    if (pick) picks.push(pick);
  }
  return picks.map((pick) => {
    const row = rowById.get(pick.contactId)!;
    const inputsHash = radarNoteKey({
      contactName: (row.preferredName ?? "").trim() || row.fullName,
      title: row.title,
      company: row.company,
      kind: pick.kind,
      reasons: pick.reasons,
      evidence: pick.evidence,
    });
    return { ...pick, inputsHash };
  });
}

/**
 * Run Radar for one account whose lease the caller holds. Never throws.
 */
export async function runRadarForUser(userId: string, opts: RadarRunOptions): Promise<RadarRunStats> {
  const now = opts.now ?? new Date();
  const startedMs = Date.now();
  const stats: RadarRunStats = {
    ok: false,
    candidates: 0,
    signals: 0,
    recommendations: 0,
    inserted: 0,
    updated: 0,
    expired: 0,
    aiNotes: 0,
    skippedNoKey: false,
    outcomes: 0,
    reranked: 0,
    rerankFailed: false,
    rerankCached: false,
    drafts: 0,
    autopilot: 0,
    news: 0,
    durationMs: 0,
  };
  const db = await getDb();
  let runId: string | null = null;
  let error: unknown = null;
  let learned: RadarModel | null = null;

  try {
    await traced(
      "radar.run",
      async () => {
        const [run] = await db.insert(radarRuns).values({ userId, trigger: opts.trigger, startedAt: now }).returning();
        runId = run!.id;

        const [signals, goals, targetKeys, live, outcomes, tallies] = await Promise.all([
          produceInternalSignals(userId, now),
          listActiveGoalTextsForUser(userId, { limit: 8 }),
          loadTargetKeys(userId),
          loadLiveRecommendations(userId),
          // Measurement, not ranking: which accepts turned into conversations. It never
          // blocks the list, so a failure here costs the stat, not the run.
          detectRadarOutcomes(userId, now).catch((err) => {
            reportUnlessQuiet(err, { where: "job.radar.outcomes", userId, level: "warning" });
            return 0;
          }),
          // What this account has taught Radar. A failure scores neutrally, never fails the run.
          loadModelTallies(userId, now).catch((err) => {
            reportUnlessQuiet(err, { where: "job.radar.model", userId, level: "warning" });
            return null;
          }),
        ]);
        stats.outcomes = outcomes;
        const model = tallies ? buildRadarModel(tallies, now) : null;
        learned = model;
        const [candidates, suppressions] = await Promise.all([
          loadCandidates(userId, signals.map((s) => s.contactId), now),
          loadSuppressions(userId, live, now),
        ]);

        // Headlines about the companies these people work at, from the global news tables.
        // One indexed read; a failure costs the run its news, never its list.
        const news = await probeCompanyNews(userId, candidates, now).catch((err) => {
          reportUnlessQuiet(err, { where: "job.radar.news", userId, level: "warning" });
          return [];
        });
        stats.news = news.length;
        const picks = scorePicks(candidates, [...signals, ...news], targetKeys, goals, suppressions, now, model);

        // AI, on the account's own key, in one shared budget. First the rerank, which may
        // nudge the shortlist before the caps choose the final list; then, once the list is
        // safely written, the why-lines. A missing key or a slow provider costs the run its
        // AI, never its list: every failure leaves the scorer's own order.
        const aiDeadline = deadlineAfter(Math.min(opts.budgetMs ?? RADAR_AI_BUDGET_MS, RADAR_AI_BUDGET_MS));
        const access = opts.ai ? await openRadarAi(userId) : null;
        if (opts.ai && !access) stats.skippedNoKey = true;

        let ranked: NewRecommendation[] = picks;
        if (access && RADAR_RERANK_ENABLED) {
          const profiles = new Map(candidates.map((c) => [c.id, { title: c.title, company: c.company, tier: c.tier }]));
          const result = await rerankPicks(userId, access, picks, { goals, profiles }, now, {
            timeoutMs: Math.min(RADAR_RERANK_TIMEOUT_MS, Math.max(1_000, aiDeadline - Date.now())),
          }).catch((err) => {
            reportUnlessQuiet(err, { where: "job.radar.rerank", userId, level: "warning" });
            return rerankUnchanged(picks, "failed");
          });
          ranked = result.picks;
          stats.reranked = result.adjusted;
          stats.rerankFailed = result.status === "failed";
          stats.rerankCached = result.status === "cached";
        }

        const next = rankPicks(ranked, RADAR_CAPS);
        const counts = planRunResult(live, next, now);
        await writeRunResult(userId, runId, next, now);

        // Autopilot, for the kinds this person opted into: schedules, never sends. Only on
        // the nightly pass and an explicit refresh, never while someone is opening the page.
        if (opts.trigger === "schedule" || opts.trigger === "manual") {
          const autopilot = await loadRadarAutopilot(userId).catch(() => ({}));
          stats.autopilot = await applyAutopilot(userId, autopilot, now);
        }

        // Drafts for Today's cards, then the why-lines with whatever budget is left.
        if (access && !deadlineReached(aiDeadline)) {
          stats.drafts = await draftTodayForRun(userId, access, { deadline: aiDeadline }).catch((err) => {
            reportUnlessQuiet(err, { where: "job.radar.draft", userId, level: "warning" });
            return 0;
          });
        }
        if (access && !deadlineReached(aiDeadline)) {
          stats.aiNotes = await explainTopForRun(userId, access, {
            budgetMs: Math.max(1_000, aiDeadline - Date.now()),
          }).catch((err) => {
            reportUnlessQuiet(err, { where: "job.radar.why", userId, level: "warning" });
            return 0;
          });
        }

        stats.candidates = candidates.length;
        stats.signals = signals.length;
        stats.recommendations = next.length;
        stats.inserted = counts.inserted;
        stats.updated = counts.updated;
        stats.expired = counts.expired;
        stats.ok = true;
      },
      { userId }
    );
  } catch (err) {
    error = err;
    reportError(err, { where: "job.radar.user", userId, level: "warning" });
  }

  stats.durationMs = Date.now() - startedMs;
  await finishRun(userId, runId, stats, error, now, learned).catch((err) =>
    reportError(err, { where: "job.radar.finish", userId, level: "warning" })
  );
  return stats;
}

async function finishRun(
  userId: string,
  runId: string | null,
  stats: RadarRunStats,
  error: unknown,
  now: Date,
  model: RadarModel | null
) {
  const db = await getDb();
  const { ok, ...counts } = stats;
  await runAtomicWrite(db, (tx) => {
    const statements = [];
    if (runId) {
      statements.push(
        tx
          .update(radarRuns)
          .set({
            status: ok ? "ok" : "failed",
            finishedAt: new Date(),
            durationMs: stats.durationMs,
            stats: counts,
            error: error ? String(error instanceof Error ? error.message : error).slice(0, 500) : null,
          })
          .where(eq(radarRuns.id, runId))
      );
    }
    statements.push(
      tx
        .update(userSettings)
        .set(
          ok
            ? {
                radarLastRunAt: now,
                radarNextAt: nextNightlyRunAt(now),
                radarLeaseUntil: null,
                // Saved for the admin view and the next reader; the run itself always
                // rebuilds from rows, so a stale copy here can never steer a ranking.
                ...(model ? { radarModel: model } : {}),
              }
            : { radarNextAt: new Date(now.getTime() + RETRY_AFTER_MS), radarLeaseUntil: null }
        )
        .where(eq(userSettings.userId, userId))
    );
    return statements;
  });
}

/**
 * The page's first visit: no run on record yet, so build one now, inline and bounded, so
 * the first thing a person sees is their list rather than an empty page. Status-agnostic on
 * purpose: an account whose first run found nothing still has a run, and is not rebuilt.
 */
export async function ensureRadarRun(userId: string, now: Date = new Date()): Promise<boolean> {
  const state = await loadRadarState(userId);
  if (!state || state.paused || state.lastRunAt) return false;
  if (!(await claimRadarLease(userId, now))) return false;
  const stats = await runRadarForUser(userId, { trigger: "first_visit", now, ai: false, budgetMs: 15_000 });
  return stats.ok;
}

/** A stale page view: rebuild in the background (callers wrap this in `after()`). */
export async function maybeRefreshRadar(userId: string, now: Date = new Date()): Promise<void> {
  const state = await loadRadarState(userId);
  if (!state || state.paused || !state.lastRunAt) return;
  if (now.getTime() - state.lastRunAt.getTime() < RADAR_STALE_MS) return;
  if (!(await claimRadarLease(userId, now))) return;
  await runRadarForUser(userId, { trigger: "page", now, ai: false, budgetMs: 20_000 });
}

/** Rows of `radar_runs` for one account, newest first. For the page stamp and the smoke. */
export async function countRadarRuns(userId: string): Promise<number> {
  const db = await getDb();
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM radar_runs WHERE user_id = ${userId}`)
  );
  return Number(row?.n ?? 0);
}

/* ------------------------------------------------------------------ the nightly pass ----- */

/** Under the route's 300 s ceiling, with room for the ledger write. */
export const RADAR_PASS_BUDGET_MS = 270_000;
/** Accounts claimed per pass. The route self-continues when a claim comes back full. */
export const RADAR_USERS_PER_PASS = 25;
/** Accounts run at once. Each is a different account's reads and, at most, six AI calls (the rerank and five why-lines). */
export const RADAR_CONCURRENCY = 4;
/** No account starts unless this much of the budget is left. */
export const RADAR_PER_USER_BUDGET_MS = 45_000;
/** Accounts nobody has used in this long are left alone; their first visit rebuilds. */
export const RADAR_ACTIVE_WITHIN_DAYS = 60;

/**
 * Claim accounts that are due, in one statement. While Radar is coming-soon, only accounts
 * that have opened it (`radar_last_run_at IS NOT NULL`) are eligible, so nobody's AI key is
 * spent on a page they cannot see. `last_active_at` is null for accounts that predate the
 * column; they are treated as inactive until their next visit, which builds inline.
 */
export async function claimRadarUsers(limit: number, now: Date, opts: { includeUnopened: boolean }): Promise<string[]> {
  const db = await getDb();
  const lease = new Date(now.getTime() + RADAR_LEASE_MS);
  const activeSince = new Date(now.getTime() - RADAR_ACTIVE_WITHIN_DAYS * 24 * HOUR_MS);
  const rows = rowsOf<{ user_id: string }>(
    await db.execute(sql`
      UPDATE user_settings SET radar_lease_until = ${lease}
       WHERE id IN (
         SELECT id FROM user_settings
          WHERE radar_paused = 0
            AND (radar_next_at IS NULL OR radar_next_at <= ${now})
            AND (radar_lease_until IS NULL OR radar_lease_until < ${now})
            AND last_active_at > ${activeSince}
            AND ${opts.includeUnopened ? sql`TRUE` : sql`radar_last_run_at IS NOT NULL`}
          ORDER BY radar_next_at NULLS FIRST, id
          LIMIT ${limit})
      RETURNING user_id
    `)
  );
  return rows.map((r) => r.user_id);
}

/** Give an account back without running it, due at `dueAt` so the continuation takes it. */
export async function releaseRadarLease(userId: string, dueAt: Date): Promise<void> {
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ radarLeaseUntil: null, radarNextAt: dueAt })
    .where(eq(userSettings.userId, userId));
}

export type RadarPassStats = {
  claimed: number;
  ran: number;
  failed: number;
  recommendations: number;
  aiNotes: number;
  budgetExhausted: boolean;
  claimFull: boolean;
};

/**
 * One nightly pass: claim due accounts, run each under a shared deadline, and report
 * whether more are waiting. A per-account failure is counted and never rethrown, because
 * `runSettledPool` would swallow it silently otherwise.
 */
export async function runRadarPass(opts: { now?: Date; budgetMs?: number; includeUnopened: boolean }): Promise<RadarPassStats> {
  const now = opts.now ?? new Date();
  const deadline = deadlineAfter(opts.budgetMs ?? RADAR_PASS_BUDGET_MS);
  const startCutoff = deadline - RADAR_PER_USER_BUDGET_MS;
  const stats: RadarPassStats = {
    claimed: 0,
    ran: 0,
    failed: 0,
    recommendations: 0,
    aiNotes: 0,
    budgetExhausted: false,
    claimFull: false,
  };
  const claimed = await claimRadarUsers(RADAR_USERS_PER_PASS, now, { includeUnopened: opts.includeUnopened });
  stats.claimed = claimed.length;
  stats.claimFull = claimed.length >= RADAR_USERS_PER_PASS;

  await runSettledPool(claimed, RADAR_CONCURRENCY, async (userId) => {
    if (deadlineReached(startCutoff)) {
      stats.budgetExhausted = true;
      await releaseRadarLease(userId, now).catch(() => undefined);
      return;
    }
    const result = await runRadarForUser(userId, {
      trigger: "schedule",
      now: opts.now,
      ai: true,
      budgetMs: RADAR_PER_USER_BUDGET_MS,
    });
    if (result.ok) stats.ran++;
    else stats.failed++;
    stats.recommendations += result.recommendations;
    stats.aiNotes += result.aiNotes;
  });
  return stats;
}
