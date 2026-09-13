import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { outreachCampaigns, outreachProspects, outreachResearchRuns } from "@/db/schema";
import { completeJson } from "@/lib/ai";
import { UserFacingError } from "@/lib/errors";
import { getCampaignV2, laterStep } from "@/lib/outreach/campaigns";
import { OUTREACH_LIMITS } from "@/lib/outreach/config";
import { releaseHold, reserveCredits } from "@/lib/outreach/credits/ledger";
import { hasAnyCriteria } from "@/lib/outreach/criteria";
import { loadOutreachHistory, upsertCandidate } from "@/lib/outreach/discovery/candidates";
import { planQueries } from "@/lib/outreach/discovery/query-plan";
import { parseLinkedinResult, stripHtml } from "@/lib/outreach/discovery/serp";
import { cancelJobs, countOutstandingJobs, enqueueJob } from "@/lib/outreach/jobs/queue";
import type { JobHandler, JobOutcome } from "@/lib/outreach/jobs/worker";
import { resolveResearchProviders, type ProviderResolver } from "@/lib/outreach/providers/resolve";
import { isProviderError } from "@/lib/outreach/providers/types";
import { compareRank } from "@/lib/outreach/ranking/score";
import { allocateResearch, cancelQueuedAttempts } from "@/lib/outreach/research/attempt";
import type {
  JsonCompleter,
  OutreachFundingSource,
  OutreachRunPhase,
  OutreachRunPlan,
  OutreachRunStats,
  OutreachRunStatus,
} from "@/lib/outreach/types";
import { consumeBucket, isRateLimitedError, RATE_LIMITS } from "@/lib/rate-limit";

export type DiscoveryDeps = { resolveProviders?: ProviderResolver; complete?: JsonCompleter };

export type RunSummary = {
  id: string;
  status: OutreachRunStatus;
  phase: OutreachRunPhase;
  fundingSource: OutreachFundingSource;
  candidatesFound: number;
  queriesUsed: number;
  queryBudget: number;
  researchUsed: number;
  researchBudget: number;
  error: string | null;
  demo: boolean;
  startedAt: string | null;
  finishedAt: string | null;
};

type RunRow = typeof outreachResearchRuns.$inferSelect;
const ACTIVE: OutreachRunStatus[] = ["queued", "running"];
const STOPPED_UNEXPECTEDLY = "The search stopped unexpectedly — try again";
/** A run this old with no outstanding `discovery.run` job for it has no worker left that could
 *  finish it. The floor is generous enough that a run between its INSERT and its enqueue —
 *  milliseconds in the normal path — is never mistaken for one. */
const STALE_RUN_FLOOR_MS = 2 * 60_000;

function toSummary(run: RunRow): RunSummary {
  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
    fundingSource: run.fundingSource,
    candidatesFound: run.candidatesFound,
    queriesUsed: run.queriesUsed,
    queryBudget: run.queryBudget,
    researchUsed: run.researchUsed,
    researchBudget: run.researchBudget,
    error: run.error,
    demo: Boolean(run.stats?.demo),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export async function startDiscoveryRun(
  userId: string,
  input: { campaignId: string; funding: OutreachFundingSource; researchBudget: number },
  deps: DiscoveryDeps = {}
): Promise<{ runId: string; researchBudget: number; demo: boolean }> {
  const campaign = await getCampaignV2(userId, input.campaignId);
  if (!campaign) throw new UserFacingError("That campaign isn’t available");
  if (!campaign.criteriaConfirmedAt || !hasAnyCriteria(campaign.criteria)) {
    throw new UserFacingError("Confirm the audience before finding people");
  }
  const db = await getDb();
  // A run whose job died leaves the campaign structurally blocked (ruling 1's index) with its
  // credits still held. Clear it before the pre-check gets a chance to see it as active.
  await reapStaleRun(userId, campaign.id);

  // Friendly pre-check: catches the common case with a clear message. The real guard is the
  // structural partial unique index on (campaign_id) WHERE status IN ('queued','running') —
  // see the .onConflictDoNothing() below — which is what makes this race-proof.
  const [active] = await db
    .select({ id: outreachResearchRuns.id })
    .from(outreachResearchRuns)
    .where(
      and(
        eq(outreachResearchRuns.userId, userId),
        eq(outreachResearchRuns.campaignId, campaign.id),
        inArray(outreachResearchRuns.status, ACTIVE)
      )
    )
    .limit(1);
  if (active) throw new UserFacingError("A search is already running for this campaign");

  // Resolve first: a funding source that cannot work must not cost a daily search.
  const providers = await (deps.resolveProviders ?? resolveResearchProviders)(userId, input.funding);
  if (input.funding === "orbit") {
    try {
      await consumeBucket("outreach.orbit-search", userId, RATE_LIMITS.outreachOrbitSearch);
    } catch (err) {
      if (isRateLimitedError(err)) {
        throw new UserFacingError("You’ve used today’s Orbit-funded searches — try again tomorrow or use your own keys");
      }
      throw err;
    }
  }

  const budget = Math.max(0, Math.min(OUTREACH_LIMITS.maxResearchBudget, Math.floor(input.researchBudget || 0)));
  const [runRow] = await db
    .insert(outreachResearchRuns)
    .values({
      userId,
      campaignId: campaign.id,
      criteriaVersion: campaign.criteriaVersion,
      fundingSource: input.funding,
      queryBudget: OUTREACH_LIMITS.braveQueriesPerRun,
      stats: { demo: providers.demo },
    })
    .onConflictDoNothing()
    // Bare `.returning()`, not `.returning({ col })` — an explicit field selector defeats
    // Drizzle's overload resolution after `.onConflictDoNothing()` against the union `Db`
    // type (same trap noted in contact-identity.ts, action-items.ts and import-engine.ts).
    .returning();
  if (!runRow) throw new UserFacingError("A search is already running for this campaign");

  // Everything past this point can fail (a hiccup in credits, the campaign update, or the
  // enqueue) with the run row already committed. Left alone that strands it ACTIVE — blocking
  // the campaign via ruling 1's index — and, once a hold is taken, strands its credits too. On
  // any throw here, cancel the run and release whatever hold it already took, then rethrow so
  // the caller still sees the original failure.
  let researchBudget = 0;
  let holdId: string | null = null;
  try {
    if (budget > 0 && providers.enrichment) {
      if (input.funding === "orbit") {
        const hold = await reserveCredits(userId, { want: budget, min: 1, runId: runRow.id, idempotencyKey: `reserve:run:${runRow.id}` });
        researchBudget = hold?.amount ?? 0;
        holdId = hold?.holdId ?? null;
      } else {
        researchBudget = budget;
      }
    }
    await db
      .update(outreachResearchRuns)
      .set({ researchBudget, holdId, updatedAt: new Date() })
      .where(and(eq(outreachResearchRuns.id, runRow.id), eq(outreachResearchRuns.userId, userId)));
    await db
      .update(outreachCampaigns)
      .set({ setupStep: laterStep(campaign.setupStep, "people"), updatedAt: new Date() })
      .where(and(eq(outreachCampaigns.id, campaign.id), eq(outreachCampaigns.userId, userId)));
    await enqueueJob({
      userId,
      kind: "discovery.run",
      campaignId: campaign.id,
      payload: { runId: runRow.id },
      idempotencyKey: `discovery:${runRow.id}`,
      maxAttempts: 8,
    });
  } catch (err) {
    const now = new Date();
    await db
      .update(outreachResearchRuns)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(
        and(eq(outreachResearchRuns.id, runRow.id), eq(outreachResearchRuns.userId, userId), inArray(outreachResearchRuns.status, ACTIVE))
      );
    if (holdId) await releaseHold(userId, holdId, now);
    throw err;
  }
  return { runId: runRow.id, researchBudget, demo: providers.demo };
}

async function loadRun(userId: string, runId: string): Promise<RunRow | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(outreachResearchRuns)
    .where(and(eq(outreachResearchRuns.id, runId), eq(outreachResearchRuns.userId, userId)));
  return row ?? null;
}

/** Finishes a run only if it was still ACTIVE — so a race against another finisher (the
 *  reaper, a cancel, a second worker with a stale lease) releases the hold exactly once. */
async function finishRun(userId: string, run: RunRow, status: OutreachRunStatus, error: string | null) {
  const db = await getDb();
  const now = new Date();
  const updated = await db
    .update(outreachResearchRuns)
    .set({ status, phase: "finishing", error, finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(outreachResearchRuns.id, run.id),
        eq(outreachResearchRuns.userId, userId),
        inArray(outreachResearchRuns.status, ACTIVE)
      )
    )
    // Bare `.returning()` — only `.length` is read, and an explicit field selector defeats
    // Drizzle's overload resolution here (same trap noted throughout this file).
    .returning();
  if (updated.length > 0 && run.holdId) await releaseHold(userId, run.holdId, now);
}

/**
 * A run whose job died without a retry left to save it — the worker abandoned its lease and
 * `outreach_jobs` gave up, or the process crashed hard enough that even `failExhaustedJobs`
 * never ran — is stuck ACTIVE: holding its credit hold and, via ruling 1's structural index,
 * blocking the campaign from starting another. Reap it once nothing is left that could still
 * finish it: an active run past `STALE_RUN_FLOOR_MS` with no outstanding `discovery.run` job
 * for it is abandoned, not merely between steps.
 */
async function reapStaleRun(userId: string, campaignId: string): Promise<void> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(outreachResearchRuns)
    .where(
      and(
        eq(outreachResearchRuns.userId, userId),
        eq(outreachResearchRuns.campaignId, campaignId),
        inArray(outreachResearchRuns.status, ACTIVE)
      )
    )
    .orderBy(desc(outreachResearchRuns.createdAt))
    .limit(1);
  if (!row) return;
  if (Date.now() - row.createdAt.getTime() < STALE_RUN_FLOOR_MS) return;
  const outstanding = await countOutstandingJobs(userId, { campaignId, kind: "discovery.run", runId: row.id });
  if (outstanding > 0) return;
  await finishRun(userId, row, "failed", STOPPED_UNEXPECTEDLY);
}

export async function cancelDiscoveryRun(userId: string, runId: string): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  const [run] = await db
    .update(outreachResearchRuns)
    .set({ status: "cancelled", finishedAt: now, updatedAt: now })
    .where(
      and(eq(outreachResearchRuns.id, runId), eq(outreachResearchRuns.userId, userId), inArray(outreachResearchRuns.status, ACTIVE))
    )
    .returning();
  if (!run) return false;
  // One filter, by runId: it already reaches every job this run created (discovery.run itself
  // included — its payload carries the same runId). A second cancel scoped to campaign+kind
  // instead of runId would run after this run's slot is freed and could cancel a NEW run's
  // discovery.run job on the same campaign.
  await cancelJobs(userId, { runId }, now);
  await cancelQueuedAttempts(userId, runId);
  if (run.holdId) await releaseHold(userId, run.holdId, now);
  return true;
}

export async function getLatestRun(userId: string, campaignId: string): Promise<RunSummary | null> {
  await reapStaleRun(userId, campaignId);
  const db = await getDb();
  const [row] = await db
    .select()
    .from(outreachResearchRuns)
    .where(and(eq(outreachResearchRuns.userId, userId), eq(outreachResearchRuns.campaignId, campaignId)))
    .orderBy(desc(outreachResearchRuns.createdAt))
    .limit(1);
  return row ? toSummary(row) : null;
}

const cont = (runAfterMs: number): JobOutcome => ({ status: "continue", runAfterMs });

/**
 * One discovery run as a resumable state machine over `phase` (spec §7.3). Each invocation
 * does as much as its deadline allows and yields. Phase transitions themselves are idempotent
 * (a crashed worker's replacement resumes from the stored phase and plan), but that alone
 * doesn't make every step free to repeat: the searching phase checkpoints `plan`, `stats`,
 * `queriesUsed` and `candidatesFound` after every successful provider call, so a crash mid-run
 * re-pays for at most the one page in flight, never the whole invocation's worth. An error that
 * still escapes all of that is caught below: it retries like any other job until the job's last
 * attempt, at which point the run is failed outright rather than left stranded active.
 */
export function createDiscoveryRunHandler(deps: DiscoveryDeps = {}): JobHandler {
  return async ({ job, deadline, now }) => {
    const userId = job.userId;
    const run = await loadRun(userId, String(job.payload.runId ?? ""));
    if (!run || !ACTIVE.includes(run.status)) return { status: "succeeded", result: { skipped: true } };
    const campaign = await getCampaignV2(userId, run.campaignId);
    if (!campaign) {
      await finishRun(userId, run, "failed", "The campaign was deleted");
      return { status: "succeeded" };
    }

    try {
      const db = await getDb();
      if (run.status === "queued") {
        await db
          .update(outreachResearchRuns)
          .set({ status: "running", startedAt: now(), updatedAt: now() })
          .where(
            and(
              eq(outreachResearchRuns.id, run.id),
              eq(outreachResearchRuns.userId, userId),
              eq(outreachResearchRuns.status, "queued")
            )
          );
      }
      const complete = deps.complete ?? completeJson;

      if (run.phase === "planning") {
        const { queries, source } = await planQueries(userId, campaign.brief, campaign.criteria, OUTREACH_LIMITS.maxPlannedQueries, complete);
        if (queries.length === 0) {
          await finishRun(userId, run, "failed", "Add a role, organization or place to the audience so there is something to search for");
          return { status: "succeeded" };
        }
        const plan: OutreachRunPlan = { source, queries: queries.map((q) => ({ q: q.q, status: "pending", pagesFetched: 0, results: 0 })) };
        await db
          .update(outreachResearchRuns)
          .set({ plan, phase: "searching", updatedAt: now() })
          .where(and(eq(outreachResearchRuns.id, run.id), eq(outreachResearchRuns.userId, userId)));
        return cont(0);
      }

      if (run.phase === "searching") {
        // Providers are resolved here and only here: planning uses the AI completer, and
        // ranking/researching need no providers at all.
        let providers: Awaited<ReturnType<ProviderResolver>>;
        try {
          providers = await (deps.resolveProviders ?? resolveResearchProviders)(userId, run.fundingSource);
        } catch (err) {
          await finishRun(
            userId,
            run,
            "failed",
            err instanceof UserFacingError ? err.message : "Search isn’t available right now — try again later"
          );
          return { status: "succeeded" };
        }

        const plan: OutreachRunPlan = { ...run.plan, queries: run.plan.queries.map((q) => ({ ...q })) };
        const stats: OutreachRunStats = { ...run.stats, providerErrors: { ...(run.stats.providerErrors ?? {}) } };
        const history = await loadOutreachHistory(userId, campaign.id);
        let used = run.queriesUsed;
        const created: string[] = [];
        const evidenceProvider = providers.demo ? ("demo" as const) : ("brave" as const);

        const enqueueRankingBatches = async (prospectIds: string[]) => {
          for (let i = 0; i < prospectIds.length; i += OUTREACH_LIMITS.rankingBatchSize) {
            const chunk = prospectIds.slice(i, i + OUTREACH_LIMITS.rankingBatchSize);
            await enqueueJob({
              userId,
              kind: "ranking.batch",
              campaignId: campaign.id,
              payload: { campaignId: campaign.id, prospectIds: chunk, runId: run.id },
              idempotencyKey: `rank:${run.id}:${chunk[0]}`,
            });
          }
        };

        outer: for (const entry of plan.queries) {
          if (entry.status !== "pending") continue;
          while (entry.pagesFetched < OUTREACH_LIMITS.maxPagesPerQuery) {
            if (used >= run.queryBudget || Date.now() >= deadline - 8_000) break outer;
            let page;
            try {
              page = await providers.search.search(entry.q, { count: OUTREACH_LIMITS.resultsPerQuery, offset: entry.pagesFetched });
            } catch (err) {
              if (isProviderError(err) && err.kind === "auth") {
                // What this invocation already found still gets ranked — the ruling-2 sweep
                // exists for crash losses, not for candidates we know about right now.
                await enqueueRankingBatches(created);
                await finishRun(
                  userId,
                  { ...run, plan, stats },
                  "failed",
                  run.fundingSource === "personal"
                    ? "Your Brave key was rejected — check it in Settings"
                    : "People search isn’t available right now — try again later"
                );
                return { status: "succeeded" };
              }
              const kind = isProviderError(err) ? err.kind : "error";
              stats.providerErrors![kind] = (stats.providerErrors![kind] ?? 0) + 1;
              entry.status = "error";
              entry.error = kind;
              continue outer;
            }
            used++;
            entry.pagesFetched++;
            stats.searchCalls = (stats.searchCalls ?? 0) + 1;
            let pageCreated = 0;
            for (const result of page.results) {
              const candidate = parseLinkedinResult(result);
              if (!candidate) {
                stats.unparsedResults = (stats.unparsedResults ?? 0) + 1;
                continue;
              }
              stats.parsedCandidates = (stats.parsedCandidates ?? 0) + 1;
              const upserted = await upsertCandidate(
                userId,
                campaign.id,
                {
                  fullName: candidate.fullName,
                  headline: candidate.headline,
                  company: candidate.company,
                  location: candidate.location,
                  linkedinUrl: candidate.linkedinUrl,
                  origin: providers.demo ? "demo" : "discovered",
                  evidence: [
                    {
                      kind: "search_result",
                      provider: evidenceProvider,
                      url: result.url,
                      title: stripHtml(result.title),
                      snippet: candidate.snippet,
                      facts: { headline: candidate.headline, company: candidate.company, location: candidate.location },
                      runId: run.id,
                    },
                  ],
                },
                { history, trustedCampaign: true }
              );
              if (upserted.created) {
                created.push(upserted.prospectId);
                entry.results++;
                pageCreated++;
              }
            }
            const queryExhausted = !page.moreAvailable || entry.pagesFetched >= OUTREACH_LIMITS.maxPagesPerQuery;
            if (queryExhausted && entry.status === "pending") entry.status = "done";

            // Checkpoint after every successful call: a crash from here on re-pays for at most
            // this one page, never the ones already reflected in `queriesUsed`. `candidatesFound`
            // is a SQL increment of just this page's creations, not a snapshot read-modify-write
            // — safe even if a later write in this same invocation races another reader.
            await db
              .update(outreachResearchRuns)
              .set({
                plan,
                stats,
                queriesUsed: used,
                candidatesFound: sql`${outreachResearchRuns.candidatesFound} + ${pageCreated}`,
                updatedAt: now(),
              })
              .where(and(eq(outreachResearchRuns.id, run.id), eq(outreachResearchRuns.userId, userId)));

            if (queryExhausted) break;
          }
        }

        // The ruling-2 sweep covers anything this list loses to a crash, so this enqueue only
        // needs to cover the common, uninterrupted case.
        await enqueueRankingBatches(created);
        const searchDone = used >= run.queryBudget || plan.queries.every((q) => q.status !== "pending");
        if (used >= run.queryBudget && plan.queries.some((q) => q.status === "pending")) {
          stats.stoppedReason = "query_budget";
        }
        // `candidatesFound` is deliberately absent here — the per-page checkpoints above already
        // hold it current; re-deriving it from the stale `run.candidatesFound` snapshot would be
        // exactly the read-modify-write this phase no longer does.
        await db
          .update(outreachResearchRuns)
          .set({
            plan,
            stats,
            queriesUsed: used,
            phase: searchDone ? "ranking" : "searching",
            updatedAt: now(),
          })
          .where(and(eq(outreachResearchRuns.id, run.id), eq(outreachResearchRuns.userId, userId)));
        return cont(searchDone ? 2_000 : 0);
      }

      if (run.phase === "ranking") {
        if ((await countOutstandingJobs(userId, { campaignId: campaign.id, kind: "ranking.batch", runId: run.id })) > 0) {
          return cont(2_000);
        }

        // Ruling 2: the searching phase tracks newly created prospects only in memory. If the
        // handler throws mid-search, the retry sees those prospects as already existing (the
        // identity unique index short-circuits the insert) and never ranks them. Once every
        // ranking.batch job from this run has finished, sweep once for anyone still unranked —
        // this run's or an earlier crashed one's — before spending any research credits on them.
        if (!run.stats.rankSweep) {
          const unranked = await db
            .select({ id: outreachProspects.id })
            .from(outreachProspects)
            .where(
              and(
                eq(outreachProspects.userId, userId),
                eq(outreachProspects.campaignId, campaign.id),
                isNull(outreachProspects.rankedCriteriaVersion),
                ne(outreachProspects.status, "excluded")
              )
            )
            .orderBy(outreachProspects.id);
          if (unranked.length > 0) {
            for (let i = 0; i < unranked.length; i += OUTREACH_LIMITS.rankingBatchSize) {
              const chunk = unranked.slice(i, i + OUTREACH_LIMITS.rankingBatchSize).map((p) => p.id);
              await enqueueJob({
                userId,
                kind: "ranking.batch",
                campaignId: campaign.id,
                payload: { campaignId: campaign.id, prospectIds: chunk, runId: run.id },
                idempotencyKey: `rank:${run.id}:sweep:${chunk[0]}`,
              });
            }
            await db
              .update(outreachResearchRuns)
              .set({ stats: { ...run.stats, rankSweep: true }, updatedAt: now() })
              .where(and(eq(outreachResearchRuns.id, run.id), eq(outreachResearchRuns.userId, userId)));
            return cont(2_000);
          }
          await db
            .update(outreachResearchRuns)
            .set({ stats: { ...run.stats, rankSweep: true }, updatedAt: now() })
            .where(and(eq(outreachResearchRuns.id, run.id), eq(outreachResearchRuns.userId, userId)));
        }

        const remaining = run.researchBudget - run.researchUsed;
        if (remaining > 0) {
          const pool = await db
            .select({
              id: outreachProspects.id,
              rankTier: outreachProspects.rankTier,
              rankScore: outreachProspects.rankScore,
              researchConfidence: outreachProspects.researchConfidence,
            })
            .from(outreachProspects)
            .where(
              and(
                eq(outreachProspects.userId, userId),
                eq(outreachProspects.campaignId, campaign.id),
                eq(outreachProspects.researchState, "none"),
                ne(outreachProspects.status, "excluded"),
                or(isNull(outreachProspects.rankTier), ne(outreachProspects.rankTier, "filtered")),
                // Ruling 3: never spend a research credit on someone opted out / bounced.
                sql`(${outreachProspects.flags} ->> 'suppressed') IS NULL`
              )
            );
          const ordered = pool.filter((p) => p.rankTier !== null).sort(compareRank).slice(0, remaining);
          for (const prospect of ordered) {
            const attemptId = await allocateResearch(userId, {
              campaignId: campaign.id,
              prospectId: prospect.id,
              runId: run.id,
              funding: run.fundingSource,
              holdId: run.holdId,
            });
            if (!attemptId) break;
          }
        }
        await db
          .update(outreachResearchRuns)
          .set({ phase: "researching", updatedAt: now() })
          .where(and(eq(outreachResearchRuns.id, run.id), eq(outreachResearchRuns.userId, userId)));
        return cont(2_000);
      }

      if (run.phase === "researching") {
        if ((await countOutstandingJobs(userId, { campaignId: campaign.id, kind: "research.person", runId: run.id })) > 0) {
          return cont(3_000);
        }
      }

      const troubled =
        Object.keys(run.stats.providerErrors ?? {}).length > 0 ||
        run.plan.queries.some((q) => q.status === "error") ||
        Boolean(run.stats.stoppedReason);
      await finishRun(userId, run, troubled ? "partial" : "completed", null);
      return { status: "succeeded" };
    } catch (err) {
      // Anything that escapes the checkpointed, locally-handled paths above is unexpected. Let
      // the worker retry it like any other job failure — but on the last attempt, fail the run
      // outright rather than leave it stranded ACTIVE (blocking the campaign) with its hold
      // never released.
      if (job.attempts + 1 >= job.maxAttempts) {
        await finishRun(userId, run, "failed", STOPPED_UNEXPECTEDLY);
        return { status: "succeeded" };
      }
      throw err;
    }
  };
}
