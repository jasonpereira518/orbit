import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { outreachProspects, outreachResearchAttempts, outreachResearchRuns } from "@/db/schema";
import { completeJson } from "@/lib/ai";
import { UserFacingError } from "@/lib/errors";
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

const RESEARCH_UNAVAILABLE = "Research isn’t available right now — try again later";
const RESEARCH_STOPPED = "Research stopped unexpectedly — try again";
/**
 * An attempt still queued/running this long after its last write, with no outstanding
 * `research.person` job left to run it, is abandoned rather than slow. Generous: a live attempt
 * is bounded to 45 s, and the only job-less window in the normal path — between the attempt
 * INSERT and its enqueue in `allocateResearch` — is milliseconds.
 */
const STUCK_ATTEMPT_FLOOR_MS = 10 * 60_000;

/** `instanceof` plus `name`, like `asActionResult`: a second module instance fails the prototype check. */
const isUserFacingError = (err: unknown): err is Error =>
  err instanceof UserFacingError || (err instanceof Error && err.name === "UserFacingError");

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

type AttemptRow = typeof outreachResearchAttempts.$inferSelect;
type SettledStatus = "succeeded" | "partial" | "failed";

/**
 * The one way an attempt is settled — by the attempt itself (`finish`), by its job's
 * final-attempt catch, or by the reaper — so all three move credits, the attempt and the
 * person identically.
 *
 * Credits first, the attempt row second, the person last: a crash between any two steps
 * leaves the attempt still ACTIVE, so the next settle (a retry, or the reaper) runs every
 * step again — and the credit steps are exactly-once on their own (`chargeAttempt` only moves
 * a `held` attempt, `releaseHold` only an `active` hold), so repeating them costs nothing.
 * The other order could close the attempt and then die before releasing its hold, stranding
 * the credit in `*_held` with nothing left that would ever look at it again.
 *
 * The attempt row moves only from an active status, so two settlers never both settle it;
 * only the one that did goes on to touch the person, and only while the person is still
 * queued/running and no OTHER attempt for them is active (a stale attempt reaped late must
 * not overwrite a newer attempt's state).
 */
async function settleAttempt(
  userId: string,
  attempt: Pick<AttemptRow, "id" | "prospectId" | "runId" | "holdId" | "creditState">,
  status: SettledStatus,
  detail: { providerCalls?: Record<string, unknown>; error: string | null },
  now: Date
): Promise<boolean> {
  const db = await getDb();
  if (attempt.creditState === "held" && status !== "failed") await chargeAttempt(userId, attempt.id, now);
  // A single-person hold (no run) is settled here; a run's hold is released when the run ends.
  if (!attempt.runId && attempt.holdId) await releaseHold(userId, attempt.holdId, now);
  const closed = await db
    .update(outreachResearchAttempts)
    .set({
      status,
      ...(detail.providerCalls ? { providerCalls: detail.providerCalls } : {}),
      error: detail.error,
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(outreachResearchAttempts.id, attempt.id),
        eq(outreachResearchAttempts.userId, userId),
        inArray(outreachResearchAttempts.status, ["queued", "running"])
      )
    )
    // Bare `.returning()` — see the note in `allocateResearch` above.
    .returning();
  if (closed.length === 0) return false;
  await db
    .update(outreachProspects)
    .set({ researchState: status === "succeeded" ? "done" : status, updatedAt: now })
    .where(
      and(
        eq(outreachProspects.id, attempt.prospectId),
        eq(outreachProspects.userId, userId),
        inArray(outreachProspects.researchState, ["queued", "running"]),
        sql`NOT EXISTS (
          SELECT 1 FROM outreach_research_attempts other
           WHERE other.user_id = ${userId}
             AND other.prospect_id = ${attempt.prospectId}::uuid
             AND other.id <> ${attempt.id}::uuid
             AND other.status IN ('queued', 'running')
        )`
      )
    );
  return true;
}

/** Settle a still-active attempt as failed, in Orbit's words, from outside the attempt itself. */
async function failActiveAttempt(userId: string, attemptId: string, now: Date): Promise<boolean> {
  const db = await getDb();
  const [attempt] = await db
    .select()
    .from(outreachResearchAttempts)
    .where(
      and(
        eq(outreachResearchAttempts.id, attemptId),
        eq(outreachResearchAttempts.userId, userId),
        inArray(outreachResearchAttempts.status, ["queued", "running"])
      )
    );
  if (!attempt) return false;
  return settleAttempt(userId, attempt, "failed", { error: RESEARCH_STOPPED }, now);
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

  const finish = async (status: SettledStatus) => {
    await settleAttempt(userId, attempt, status, { providerCalls: calls, error }, now());
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
    // `attempt.error` is shown to the person, so it holds Orbit's words only: a
    // UserFacingError was written to be read ("Add your Brave Search key…"); anything else is
    // a raw driver or provider message that could carry hosts, bodies or keys.
    error = isUserFacingError(err) ? err.message.slice(0, 300) : RESEARCH_UNAVAILABLE;
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
    try {
      const outcome = await runResearchAttempt(job.userId, attemptId, deps);
      return { status: "succeeded", result: { outcome } };
    } catch (err) {
      // Same shape as the discovery run's final-attempt catch. Only `finish()` settles an
      // attempt from inside, so a throw that escapes it on the job's LAST attempt would leave
      // the job failed and the attempt active forever — a single-person hold stuck in
      // `*_held`, the person stuck "researching". Settle it failed through the same path
      // `finish("failed")` takes; on any earlier attempt, let the worker retry it.
      if (job.attempts + 1 >= job.maxAttempts) {
        await failActiveAttempt(job.userId, attemptId, (deps.now ?? (() => new Date()))());
        return { status: "succeeded", result: { outcome: "failed" } };
      }
      throw err;
    }
  };
}

/**
 * The backstop for the attempts no handler is left to settle: a job whose last lease expired
 * (`failExhaustedJobs`), a worker killed between claiming and finishing, an enqueue that threw
 * after the attempt row landed. An attempt of this campaign still queued/running past
 * `STUCK_ATTEMPT_FLOOR_MS` with no outstanding `research.person` job for it (queued, running
 * or paused — a paused job resumes and runs it) is settled failed exactly as the final-attempt
 * catch would, releasing a single-person hold.
 *
 * Called from `getLatestRun`, beside the run reaper: the People page reads it on load and on
 * every poll while any row is queued/running — exactly while a stuck attempt is on screen —
 * and it keeps both reapers on one cadence without adding writes to `listPeople`.
 */
export async function reapStuckAttempts(userId: string, campaignId: string, now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const floor = new Date(now.getTime() - STUCK_ATTEMPT_FLOOR_MS);
  const stuck = await db
    .select()
    .from(outreachResearchAttempts)
    .where(
      and(
        eq(outreachResearchAttempts.userId, userId),
        eq(outreachResearchAttempts.campaignId, campaignId),
        inArray(outreachResearchAttempts.status, ["queued", "running"]),
        lt(outreachResearchAttempts.updatedAt, floor),
        // Literal `outreach_research_attempts.id`: a column interpolated into a raw template
        // can lose its table prefix, and `id` alone would bind to the job row.
        sql`NOT EXISTS (
          SELECT 1 FROM outreach_jobs j
           WHERE j.user_id = ${userId}
             AND j.kind = 'research.person'
             AND j.status IN ('queued', 'running', 'paused')
             AND j.payload->>'attemptId' = outreach_research_attempts.id::text
        )`
      )
    )
    .limit(50);
  let reaped = 0;
  for (const attempt of stuck) {
    if (await settleAttempt(userId, attempt, "failed", { error: RESEARCH_STOPPED }, now)) reaped++;
  }
  return reaped;
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
