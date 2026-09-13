import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db";
import type { OutreachCriterionVerdict } from "@/db/schema";
import { outreachEvidence, outreachProspects } from "@/db/schema";
import { completeJson } from "@/lib/ai";
import { friendlyError } from "@/lib/errors";
import { getCampaignV2 } from "@/lib/outreach/campaigns";
import { OUTREACH_LIMITS } from "@/lib/outreach/config";
import { hasAnyCriteria, listCriteria } from "@/lib/outreach/criteria";
import type { JobHandler } from "@/lib/outreach/jobs/worker";
import { judgeCandidates, JudgeResponseError, type JudgeCandidate } from "@/lib/outreach/ranking/judge";
import { computeRank } from "@/lib/outreach/ranking/score";
import type { JsonCompleter } from "@/lib/outreach/types";

/**
 * How to handle a judge response that cannot be parsed (spec §7.4: "an invalid judge response
 * is retried once, then marked unknown across the board"). Default `"throw"` lets the error
 * propagate so a job handler retries with backoff; `"unknown"` is used once a job has already
 * been through one attempt, so the batch is never stranded unranked forever.
 */
export type RankProspectsOptions = { onUnreadable?: "throw" | "unknown" };

/** Judge a set of prospects against the campaign's CURRENT criteria and store the result. */
export async function rankProspects(
  userId: string,
  campaignId: string,
  prospectIds: string[],
  complete: JsonCompleter = completeJson,
  now: Date = new Date(),
  opts: RankProspectsOptions = {}
): Promise<{ ranked: number; criteriaVersion: number }> {
  const campaign = await getCampaignV2(userId, campaignId);
  if (!campaign || !hasAnyCriteria(campaign.criteria) || prospectIds.length === 0) {
    return { ranked: 0, criteriaVersion: campaign?.criteriaVersion ?? 0 };
  }
  const db = await getDb();
  const prospects = await db
    .select({ id: outreachProspects.id, fullName: outreachProspects.fullName })
    .from(outreachProspects)
    .where(
      and(
        eq(outreachProspects.userId, userId),
        eq(outreachProspects.campaignId, campaignId),
        inArray(outreachProspects.id, prospectIds)
      )
    );
  if (prospects.length === 0) return { ranked: 0, criteriaVersion: campaign.criteriaVersion };
  const evidence = await db
    .select({
      id: outreachEvidence.id,
      prospectId: outreachEvidence.prospectId,
      provider: outreachEvidence.provider,
      title: outreachEvidence.title,
      snippet: outreachEvidence.snippet,
      facts: outreachEvidence.facts,
    })
    .from(outreachEvidence)
    .where(and(eq(outreachEvidence.userId, userId), inArray(outreachEvidence.prospectId, prospects.map((p) => p.id))))
    .orderBy(desc(outreachEvidence.createdAt));

  const candidates: JudgeCandidate[] = prospects.map((p) => ({
    id: p.id,
    fullName: p.fullName,
    evidence: evidence
      .filter((e) => e.prospectId === p.id)
      .slice(0, OUTREACH_LIMITS.evidencePerCandidate)
      .map((e) => ({ id: e.id, provider: e.provider, title: e.title, snippet: e.snippet, facts: e.facts })),
  }));

  let judged: Awaited<ReturnType<typeof judgeCandidates>> | null = null;
  let unreadable = false;
  try {
    judged = await judgeCandidates(userId, campaign.criteria, candidates, complete);
  } catch (err) {
    if (err instanceof JudgeResponseError && opts.onUnreadable === "unknown") {
      unreadable = true;
    } else {
      throw err;
    }
  }

  const unknownVerdicts: OutreachCriterionVerdict[] = unreadable
    ? listCriteria(campaign.criteria).map(({ criterion }) => ({
        criterionId: criterion.id,
        verdict: "unknown",
        evidenceIds: [],
        note: "",
      }))
    : [];

  for (const prospect of prospects) {
    if (unreadable) {
      const rank = computeRank(campaign.criteria, unknownVerdicts);
      await db
        .update(outreachProspects)
        .set({
          rankScore: rank.score,
          rankTier: rank.tier,
          researchConfidence: rank.confidence,
          rankExplanation: {
            summary: "The ranking response couldn’t be read, so every criterion is unknown",
            filteredReason: rank.filteredReason,
            criteria: unknownVerdicts,
          },
          rankedCriteriaVersion: campaign.criteriaVersion,
          rankedAt: now,
          updatedAt: now,
        })
        .where(and(eq(outreachProspects.id, prospect.id), eq(outreachProspects.userId, userId)));
      continue;
    }
    const judgement = judged!.get(prospect.id);
    if (!judgement) continue;
    const rank = computeRank(campaign.criteria, judgement.verdicts);
    await db
      .update(outreachProspects)
      .set({
        rankScore: rank.score,
        rankTier: rank.tier,
        researchConfidence: rank.confidence,
        rankExplanation: { summary: judgement.summary, filteredReason: rank.filteredReason, criteria: judgement.verdicts },
        rankedCriteriaVersion: campaign.criteriaVersion,
        rankedAt: now,
        updatedAt: now,
      })
      .where(and(eq(outreachProspects.id, prospect.id), eq(outreachProspects.userId, userId)));
  }
  return { ranked: prospects.length, criteriaVersion: campaign.criteriaVersion };
}

export function createRankingBatchHandler(deps: { complete?: JsonCompleter } = {}): JobHandler {
  return async ({ job }) => {
    const payload = job.payload as { campaignId?: string; prospectIds?: string[] };
    if (!payload.campaignId || !Array.isArray(payload.prospectIds)) {
      return { status: "failed", error: "Malformed ranking job" };
    }
    try {
      const result = await rankProspects(
        job.userId,
        payload.campaignId,
        payload.prospectIds,
        deps.complete ?? completeJson,
        new Date(),
        { onUnreadable: job.attempts >= 1 ? "unknown" : "throw" }
      );
      return { status: "succeeded", result };
    } catch (err) {
      return { status: "retry", error: friendlyError(err, "Ranking didn’t finish"), backoffMs: 20_000 };
    }
  };
}

/**
 * Brings every prospect up to the campaign's current criteria version, a batch at a time, from
 * stored evidence only (spec §7.4 "Reranking"). Yields between batches.
 */
export function createRerankHandler(deps: { complete?: JsonCompleter } = {}): JobHandler {
  return async ({ job, deadline }) => {
    const campaignId = String(job.payload.campaignId ?? "");
    const campaign = await getCampaignV2(job.userId, campaignId);
    if (!campaign) return { status: "succeeded", result: { skipped: "campaign gone" } };
    const db = await getDb();
    while (Date.now() < deadline - 10_000) {
      const stale = await db
        .select({ id: outreachProspects.id })
        .from(outreachProspects)
        .where(
          and(
            eq(outreachProspects.userId, job.userId),
            eq(outreachProspects.campaignId, campaignId),
            or(
              isNull(outreachProspects.rankedCriteriaVersion),
              lt(outreachProspects.rankedCriteriaVersion, campaign.criteriaVersion)
            )
          )
        )
        .limit(OUTREACH_LIMITS.rankingBatchSize);
      if (stale.length === 0) return { status: "succeeded" };
      try {
        await rankProspects(
          job.userId,
          campaignId,
          stale.map((s) => s.id),
          deps.complete ?? completeJson,
          new Date(),
          { onUnreadable: job.attempts >= 1 ? "unknown" : "throw" }
        );
      } catch (err) {
        return { status: "retry", error: friendlyError(err, "Re-ranking didn’t finish"), backoffMs: 30_000 };
      }
    }
    return { status: "continue", runAfterMs: 0 };
  };
}
