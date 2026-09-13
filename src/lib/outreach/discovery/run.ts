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

  let researchBudget = 0;
  let holdId: string | null = null;
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

async function finishRun(userId: string, run: RunRow, status: OutreachRunStatus, error: string | null) {
  const db = await getDb();
  const now = new Date();
  await db
    .update(outreachResearchRuns)
    .set({ status, phase: "finishing", error, finishedAt: now, updatedAt: now })
    .where(and(eq(outreachResearchRuns.id, run.id), eq(outreachResearchRuns.userId, userId)));
  if (run.holdId) await releaseHold(userId, run.holdId, now);
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
  await cancelJobs(userId, { runId }, now);
  await cancelJobs(userId, { campaignId: run.campaignId, kinds: ["discovery.run"] }, now);
  await cancelQueuedAttempts(userId, runId);
  if (run.holdId) await releaseHold(userId, run.holdId, now);
  return true;
}

export async function getLatestRun(userId: string, campaignId: string): Promise<RunSummary | null> {
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
 * does as much as its deadline allows and yields; every step is idempotent, so a crashed
 * worker's replacement simply carries on from the stored phase and plan.
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
    const db = await getDb();
    if (run.status === "queued") {
      await db
        .update(outreachResearchRuns)
        .set({ status: "running", startedAt: now(), updatedAt: now() })
        .where(and(eq(outreachResearchRuns.id, run.id), eq(outreachResearchRuns.userId, userId)));
    }

    let providers;
    try {
      providers = await (deps.resolveProviders ?? resolveResearchProviders)(userId, run.fundingSource);
    } catch (err) {
      await finishRun(userId, run, "failed", err instanceof Error ? err.message : "Search isn’t available right now");
      return { status: "succeeded" };
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
      const plan: OutreachRunPlan = { ...run.plan, queries: run.plan.queries.map((q) => ({ ...q })) };
      const stats: OutreachRunStats = { ...run.stats, providerErrors: { ...(run.stats.providerErrors ?? {}) } };
      const history = await loadOutreachHistory(userId, campaign.id);
      let used = run.queriesUsed;
      const created: string[] = [];
      const evidenceProvider = providers.demo ? ("demo" as const) : ("brave" as const);

      outer: for (const entry of plan.queries) {
        if (entry.status !== "pending") continue;
        while (entry.pagesFetched < OUTREACH_LIMITS.maxPagesPerQuery) {
          if (used >= run.queryBudget || Date.now() >= deadline - 8_000) break outer;
          let page;
          try {
            page = await providers.search.search(entry.q, { count: OUTREACH_LIMITS.resultsPerQuery, offset: entry.pagesFetched });
          } catch (err) {
            if (isProviderError(err) && err.kind === "auth") {
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
            }
          }
          if (!page.moreAvailable) break;
        }
        if (entry.status === "pending") entry.status = "done";
      }

      for (let i = 0; i < created.length; i += OUTREACH_LIMITS.rankingBatchSize) {
        const chunk = created.slice(i, i + OUTREACH_LIMITS.rankingBatchSize);
        await enqueueJob({
          userId,
          kind: "ranking.batch",
          campaignId: campaign.id,
          payload: { campaignId: campaign.id, prospectIds: chunk, runId: run.id },
          idempotencyKey: `rank:${run.id}:${chunk[0]}`,
        });
      }
      const searchDone = used >= run.queryBudget || plan.queries.every((q) => q.status !== "pending");
      if (used >= run.queryBudget && plan.queries.some((q) => q.status === "pending")) {
        stats.stoppedReason = "query_budget";
      }
      await db
        .update(outreachResearchRuns)
        .set({
          plan,
          stats,
          queriesUsed: used,
          candidatesFound: run.candidatesFound + created.length,
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
  };
}
