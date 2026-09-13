/**
 * Ranking against stored evidence (spec §7.4). A batch writes score, tier, confidence and the
 * per-criterion explanation with the criteria version it reflects; confirming new criteria
 * reranks every prospect from stored evidence alone — the search and enrichment providers are
 * never called, so a rerank costs no credits. An unreadable judge response is retried once and
 * then, on the retry, falls back to an all-unknown ranking rather than leaving prospects
 * unranked forever (controller ruling on top of spec §7.4).
 *
 * Run: npx tsx scripts/smoke-outreach-rerank.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { createCampaignV2, saveCriteria } from "../src/lib/outreach/campaigns";
import { upsertCandidate } from "../src/lib/outreach/discovery/candidates";
import { enqueueJob } from "../src/lib/outreach/jobs/queue";
import { runWorkerPass } from "../src/lib/outreach/jobs/worker";
import { createRankingBatchHandler, createRerankHandler, rankProspects } from "../src/lib/outreach/ranking/apply";
import type { JsonCompleter } from "../src/lib/outreach/types";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-rerank-user";

/** A judge that matches the role criterion whenever the evidence mentions "Partnerships". */
function fakeJudge(calls: { n: number }): JsonCompleter {
  return async (_userId, input) => {
    calls.n++;
    const roleId = input.user.match(/id=(\S+) \[required\] role/)?.[1] ?? "";
    const exclusionId = input.user.match(/id=(\S+) \[exclusions\]/)?.[1];
    const blocks = input.user.split("Candidate id=").slice(1);
    return JSON.stringify({
      candidates: blocks.map((block) => {
        const id = block.split("\n")[0].trim();
        const evidenceId = block.match(/\[([0-9a-f-]{36})\]/)?.[1];
        const verdicts = [
          { criterionId: roleId, verdict: block.includes("Partnerships") ? "match" : "mismatch", evidenceIds: evidenceId ? [evidenceId] : [] },
        ];
        if (exclusionId && block.includes("JPMorgan")) verdicts.push({ criterionId: exclusionId, verdict: "match", evidenceIds: evidenceId ? [evidenceId] : [] });
        return { id, summary: "judged", verdicts };
      }),
    });
  };
}

async function main() {
  const db = await getDb();
  await ensureUserSettings(USER);
  const { id: campaignId } = await createCampaignV2(USER, {
    brief: { purpose: "Meet partnership leads in fintech", desiredOutcome: "Intro calls" }, channel: "email",
  });
  await saveCriteria(USER, campaignId, {
    required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [],
  });

  const people = [
    ["Jane Doe", "jane-doe", "Jane Doe - Head of Partnerships - Ramp"],
    ["Sam Lee", "sam-lee", "Sam Lee - Head of Partnerships - JPMorgan"],
    ["Ola Obi", "ola-obi", "Ola Obi - Software Engineer - Ramp"],
  ] as const;
  const ids: string[] = [];
  for (const [name, slug, title] of people) {
    const r = await upsertCandidate(USER, campaignId, {
      fullName: name, linkedinUrl: `https://www.linkedin.com/in/${slug}`, origin: "discovered",
      evidence: [{ kind: "search_result", provider: "brave", url: `https://www.linkedin.com/in/${slug}`, title, snippet: title }],
    });
    ids.push(r.prospectId);
  }

  const calls = { n: 0 };
  const first = await rankProspects(USER, campaignId, ids, fakeJudge(calls));
  check("a batch ranks every prospect in one judge call", first.ranked === 3 && calls.n === 1);
  const [jane] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, ids[0]));
  check("a matching person is strong", jane.rankTier === "strong" && jane.researchConfidence === "high", JSON.stringify(jane));
  check("the explanation is stored per criterion", jane.rankExplanation?.criteria.length === 1 && jane.rankExplanation.criteria[0].verdict === "match");
  check("the ranking records its criteria version", jane.rankedCriteriaVersion === 1);
  const [ola] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, ids[2]));
  check("a cited mismatch filters, with its reason", ola.rankTier === "filtered" && Boolean(ola.rankExplanation?.filteredReason));

  console.log("Rerank after new criteria...");
  const confirmed = await saveCriteria(USER, campaignId, {
    required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }],
    preferred: [],
    exclusions: [{ kind: "organization", label: "Big banks", values: ["JPMorgan"] }],
  });
  check("the rerank was queued", confirmed.rerankQueued && confirmed.criteriaVersion === 2);

  let providerCalls = 0;
  const handlers = {
    "ranking.rerank": createRerankHandler({ complete: fakeJudge(calls) }),
    "ranking.batch": createRankingBatchHandler({ complete: fakeJudge(calls) }),
    "discovery.run": async () => {
      providerCalls++;
      return { status: "succeeded" as const };
    },
  };
  await runWorkerPass({ handlers, gate: async () => true, workerId: "rr" });
  const after = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.campaignId, campaignId));
  check("every prospect now reflects version 2", after.every((p) => p.rankedCriteriaVersion === 2), JSON.stringify(after.map((p) => p.rankedCriteriaVersion)));
  const sam = after.find((p) => p.id === ids[1])!;
  check("the new exclusion filters the bank employee", sam.rankTier === "filtered" && Boolean(sam.rankExplanation?.filteredReason?.includes("Big banks")));
  check("no search or enrichment happened", providerCalls === 0);

  console.log("A failing judge retries instead of losing the batch...");
  // The pglite smoke tier shares one database across the whole suite, and smoke-outreach-jobs
  // leaves its own `ranking.batch` rows behind — so this reads back by the id `enqueueJob`
  // just returned, not by kind alone, to avoid picking up an unrelated leftover row.
  const retryBatch = await enqueueJob({ userId: USER, kind: "ranking.batch", campaignId, payload: { campaignId, prospectIds: ids } });
  await runWorkerPass({
    handlers: { "ranking.batch": createRankingBatchHandler({ complete: async () => "garbage" }) },
    gate: async () => true,
    workerId: "rb",
  });
  const [batch] = await db.select().from(schema.outreachJobs).where(eq(schema.outreachJobs.id, retryBatch.id));
  check("an unreadable judge response is retried", batch.status === "queued" && batch.attempts === 1 && Boolean(batch.lastError));

  console.log("...then falls back to an all-unknown ranking on the retry, so nobody is stranded...");
  await db.update(schema.outreachJobs).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(schema.outreachJobs.id, batch.id));
  await runWorkerPass({
    handlers: { "ranking.batch": createRankingBatchHandler({ complete: async () => "garbage" }) },
    gate: async () => true,
    workerId: "rb2",
  });
  const [batchRetried] = await db.select().from(schema.outreachJobs).where(eq(schema.outreachJobs.id, batch.id));
  check("the retry succeeds with an all-unknown ranking rather than failing", batchRetried.status === "succeeded", JSON.stringify(batchRetried));
  const fallenBack = await db.select().from(schema.outreachProspects).where(inArray(schema.outreachProspects.id, ids));
  check(
    "every prospect reflects the current criteria version",
    fallenBack.every((p) => p.rankedCriteriaVersion === 2),
    JSON.stringify(fallenBack.map((p) => p.rankedCriteriaVersion))
  );
  check(
    "every prospect's explanation is all-unknown",
    fallenBack.every((p) => (p.rankExplanation?.criteria.length ?? 0) > 0 && p.rankExplanation!.criteria.every((c) => c.verdict === "unknown")),
    JSON.stringify(fallenBack.map((p) => p.rankExplanation))
  );
  check(
    "nobody is left ranked strong on unreadable evidence",
    fallenBack.every((p) => p.rankTier !== "strong"),
    JSON.stringify(fallenBack.map((p) => p.rankTier))
  );

  console.log("A non-parse error still retries, even on a later attempt...");
  const boom = await enqueueJob({ userId: USER, kind: "ranking.batch", campaignId, payload: { campaignId, prospectIds: ids } });
  const [boomRow] = await db.select().from(schema.outreachJobs).where(eq(schema.outreachJobs.id, boom.id));
  const boomHandler = createRankingBatchHandler({
    complete: async () => {
      throw new Error("boom");
    },
  });
  const boomOutcome = await boomHandler({
    job: { ...boomRow, attempts: 1 },
    workerId: "synthetic",
    now: () => new Date(),
    deadline: Date.now() + 60_000,
    extendLease: async () => true,
  });
  check("a non-parse error retries regardless of attempt count", boomOutcome.status === "retry", JSON.stringify(boomOutcome));

  console.log("All outreach rerank checks passed.");
}

run(main);
