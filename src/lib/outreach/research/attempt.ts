import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { outreachProspects, outreachResearchAttempts, outreachResearchRuns } from "@/db/schema";
import { completeJson } from "@/lib/ai";
import { OUTREACH_LIMITS } from "@/lib/outreach/config";
import { chargeAttempt, releaseHold } from "@/lib/outreach/credits/ledger";
import { addEvidence, attachIdentities, type EvidenceInput } from "@/lib/outreach/discovery/candidates";
import { canonicalLinkedinUrl, outreachIdentitiesFor } from "@/lib/outreach/identity";
import { enqueueJob } from "@/lib/outreach/jobs/queue";
import type { JobHandler } from "@/lib/outreach/jobs/worker";
import { resolveResearchProviders, type ProviderResolver } from "@/lib/outreach/providers/resolve";
import { isProviderError, type EnrichedPerson } from "@/lib/outreach/providers/types";
import { rankProspects } from "@/lib/outreach/ranking/apply";
import type { JsonCompleter, OutreachFundingSource } from "@/lib/outreach/types";

export type ResearchDeps = { resolveProviders?: ProviderResolver; complete?: JsonCompleter; now?: () => Date };

/**
 * Create one research attempt and queue it. For a run, the slot comes out of the run's
 * `research_budget` with one conditional UPDATE — which is what guarantees a run never
 * allocates more attempts than its credit hold covers (the ledger's invariant).
 */
export async function allocateResearch(
  userId: string,
  input: { campaignId: string; prospectId: string; runId: string | null; funding: OutreachFundingSource; holdId: string | null }
): Promise<string | null> {
  const db = await getDb();
  const now = new Date();
  if (input.runId) {
    const [slot] = await db
      .update(outreachResearchRuns)
      .set({ researchUsed: sql`${outreachResearchRuns.researchUsed} + 1`, updatedAt: now })
      .where(
        and(
          eq(outreachResearchRuns.id, input.runId),
          eq(outreachResearchRuns.userId, userId),
          sql`${outreachResearchRuns.researchUsed} < ${outreachResearchRuns.researchBudget}`
        )
      )
      // Bare `.returning()`, not `.returning({ id })` — an explicit field selector defeats
      // Drizzle's overload resolution after `.update()` against the union `Db` type here (same
      // trap noted in queue.ts, contact-identity.ts, action-items.ts and import-engine.ts). Only
      // existence is read, so the extra fields cost nothing.
      .returning();
    if (!slot) return null;
  }
  const [attempt] = await db
    .insert(outreachResearchAttempts)
    .values({
      userId,
      campaignId: input.campaignId,
      prospectId: input.prospectId,
      runId: input.runId,
      fundingSource: input.funding,
      creditState: input.holdId ? "held" : "none",
      holdId: input.holdId,
    })
    .returning();
  await db
    .update(outreachProspects)
    .set({ researchState: "queued", updatedAt: now })
    .where(and(eq(outreachProspects.id, input.prospectId), eq(outreachProspects.userId, userId)));
  await enqueueJob({
    userId,
    kind: "research.person",
    campaignId: input.campaignId,
    payload: { attemptId: attempt.id, ...(input.runId ? { runId: input.runId } : {}) },
    idempotencyKey: `research:${attempt.id}`,
  });
  return attempt.id;
}

function supportQueries(p: { fullName: string; company: string | null; headline: string | null }): string[] {
  const name = `"${p.fullName.replace(/"/g, "")}"`;
  const queries = [
    p.company ? `${name} "${p.company.replace(/"/g, "")}"` : null,
    p.headline ? `${name} ${p.headline.split(/\s+/).slice(0, 4).join(" ")}` : null,
  ].filter((q): q is string => Boolean(q));
  return queries.slice(0, OUTREACH_LIMITS.researchSupportQueries);
}

function employmentSummary(person: EnrichedPerson): string {
  return person.employment
    .slice(0, 5)
    .map((job) => `${job.title ?? "Role"} at ${job.organization ?? "?"}${job.current ? " (current)" : ""}`)
    .join("; ");
}

export async function runResearchAttempt(
  userId: string,
  attemptId: string,
  deps: ResearchDeps = {}
): Promise<"succeeded" | "partial" | "failed" | "skipped"> {
  const db = await getDb();
  const now = deps.now ?? (() => new Date());
  const [attempt] = await db
    .select()
    .from(outreachResearchAttempts)
    .where(and(eq(outreachResearchAttempts.id, attemptId), eq(outreachResearchAttempts.userId, userId)));
  if (!attempt || !["queued", "running"].includes(attempt.status)) return "skipped";

  await db
    .update(outreachResearchAttempts)
    .set({ status: "running", startedAt: attempt.startedAt ?? now(), updatedAt: now() })
    .where(and(eq(outreachResearchAttempts.id, attemptId), eq(outreachResearchAttempts.userId, userId)));
  await db
    .update(outreachProspects)
    .set({ researchState: "running", updatedAt: now() })
    .where(and(eq(outreachProspects.id, attempt.prospectId), eq(outreachProspects.userId, userId)));

  const [prospect] = await db
    .select()
    .from(outreachProspects)
    .where(and(eq(outreachProspects.id, attempt.prospectId), eq(outreachProspects.userId, userId)));

  const calls: Record<string, unknown> = {};
  let gotEnrichment = false;
  let supportAdded = 0;
  let providerTrouble = false;
  let error: string | null = null;

  const finish = async (status: "succeeded" | "partial" | "failed") => {
    if (attempt.creditState === "held" && status !== "failed") await chargeAttempt(userId, attemptId, now());
    // A single-person hold (no run) is settled here; a run's hold is released when the run ends.
    if (!attempt.runId && attempt.holdId) await releaseHold(userId, attempt.holdId, now());
    await db
      .update(outreachResearchAttempts)
      .set({ status, providerCalls: calls, error, finishedAt: now(), updatedAt: now() })
      .where(and(eq(outreachResearchAttempts.id, attemptId), eq(outreachResearchAttempts.userId, userId)));
    await db
      .update(outreachProspects)
      .set({ researchState: status === "succeeded" ? "done" : status, updatedAt: now() })
      .where(and(eq(outreachProspects.id, attempt.prospectId), eq(outreachProspects.userId, userId)));
    return status;
  };

  if (!prospect) {
    error = "Prospect no longer exists";
    return finish("failed");
  }

  let providers;
  try {
    providers = await (deps.resolveProviders ?? resolveResearchProviders)(userId, attempt.fundingSource);
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 300) : "Providers unavailable";
    return finish("failed");
  }
  const signal = AbortSignal.timeout(OUTREACH_LIMITS.researchAttemptTimeoutMs);

  if (providers.enrichment) {
    try {
      const person = await providers.enrichment.match(
        { linkedinUrl: prospect.linkedinUrl, fullName: prospect.fullName, organization: prospect.company },
        { signal }
      );
      calls.enrichment = person ? "matched" : "no_match";
      if (person) {
        gotEnrichment = true;
        const keepUserEmail = prospect.emailSource === "user" && prospect.email;
        await db
          .update(outreachProspects)
          .set({
            title: prospect.title ?? person.title,
            company: prospect.company ?? person.company,
            location: prospect.location ?? person.location,
            ...(keepUserEmail || !person.email
              ? {}
              : { email: person.email, emailStatus: person.emailStatus, emailSource: "apollo" as const }),
            updatedAt: now(),
          })
          .where(and(eq(outreachProspects.id, prospect.id), eq(outreachProspects.userId, userId)));
        const conflict = await attachIdentities(
          userId,
          attempt.campaignId,
          prospect.id,
          outreachIdentitiesFor({ email: keepUserEmail ? null : person.email, apolloId: person.apolloId })
        );
        if (conflict) {
          await db
            .update(outreachProspects)
            .set({ possibleDuplicateOf: conflict, duplicateReview: "pending" })
            .where(
              and(
                eq(outreachProspects.id, prospect.id),
                eq(outreachProspects.userId, userId),
                isNull(outreachProspects.possibleDuplicateOf)
              )
            );
        }
        const provider = providers.enrichment.name === "demo" ? "demo" : "apollo";
        await addEvidence(userId, attempt.campaignId, prospect.id, [
          {
            kind: "enrichment",
            provider,
            url: canonicalLinkedinUrl(person.linkedinUrl),
            title: [person.title, person.company].filter(Boolean).join(" at ") || person.fullName,
            snippet: employmentSummary(person) || null,
            facts: {
              title: person.title,
              company: person.company,
              location: person.location,
              emailStatus: person.emailStatus,
              employment: person.employment.slice(0, 5),
            },
            runId: attempt.runId,
          },
        ]);
      }
    } catch (err) {
      providerTrouble = true;
      calls.enrichment = isProviderError(err) ? `error:${err.kind}` : "error";
    }
  } else {
    calls.enrichment = "skipped";
  }

  const lastName = prospect.fullName.trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  const supportEvidence: EvidenceInput[] = [];
  for (const q of supportQueries(prospect)) {
    try {
      const page = await providers.search.search(q, { count: 10, offset: 0, signal });
      for (const result of page.results) {
        const text = `${result.title} ${result.description}`.toLowerCase();
        if (!lastName || !text.includes(lastName)) continue;
        if (canonicalLinkedinUrl(result.url) && canonicalLinkedinUrl(result.url) === prospect.linkedinUrl) continue;
        supportEvidence.push({
          kind: "web_page",
          provider: providers.search.name === "demo" ? "demo" : "brave",
          url: result.url,
          title: result.title,
          snippet: result.description,
          runId: attempt.runId,
        });
        if (supportEvidence.length >= 3 * OUTREACH_LIMITS.researchSupportQueries) break;
      }
    } catch (err) {
      providerTrouble = true;
      calls.search = isProviderError(err) ? `error:${err.kind}` : "error";
    }
  }
  supportAdded = await addEvidence(userId, attempt.campaignId, prospect.id, supportEvidence);
  calls.support = supportAdded;

  if (gotEnrichment || supportAdded > 0) {
    try {
      await rankProspects(userId, attempt.campaignId, [prospect.id], deps.complete ?? completeJson);
    } catch {
      calls.rerank = "error";
    }
  }

  if (!gotEnrichment && supportAdded === 0) {
    error = providerTrouble ? "Research providers were unavailable" : "Nothing more was found";
    return finish("failed");
  }
  return finish(providerTrouble ? "partial" : "succeeded");
}

export function createResearchPersonHandler(deps: ResearchDeps = {}): JobHandler {
  return async ({ job }) => {
    const attemptId = String(job.payload.attemptId ?? "");
    if (!attemptId) return { status: "failed", error: "Malformed research job" };
    const outcome = await runResearchAttempt(job.userId, attemptId, deps);
    return { status: "succeeded", result: { outcome } };
  };
}

/** Attempts still queued for a run are cancelled with it (Task 15). */
export async function cancelQueuedAttempts(userId: string, runId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .update(outreachResearchAttempts)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(outreachResearchAttempts.userId, userId),
        eq(outreachResearchAttempts.runId, runId),
        inArray(outreachResearchAttempts.status, ["queued"])
      )
    )
    // Bare `.returning()` — see the note in `allocateResearch` above.
    .returning();
  if (rows.length) {
    await db
      .update(outreachProspects)
      .set({ researchState: "none" })
      .where(and(eq(outreachProspects.userId, userId), inArray(outreachProspects.id, rows.map((r) => r.prospectId))));
  }
  return rows.length;
}
