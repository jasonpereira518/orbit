/**
 * One research attempt = one credit (spec §7.5). Success or partial charges once; total failure
 * charges nothing; re-running the same attempt never charges again. Emails come only from the
 * enrichment provider, never overwrite one the user typed, and carry their verification status.
 *
 * Run: npx tsx scripts/smoke-outreach-research.ts
 */
import "./smoke/_env";

import { and, eq, sql } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { UserFacingError } from "../src/lib/errors";
import { createCampaignV2, saveCriteria } from "../src/lib/outreach/campaigns";
import { getCreditBalance, reserveCredits } from "../src/lib/outreach/credits/ledger";
import { upsertCandidate } from "../src/lib/outreach/discovery/candidates";
import { getLatestRun } from "../src/lib/outreach/discovery/run";
import type { ProviderResolver, ResearchProviders } from "../src/lib/outreach/providers/resolve";
import { ProviderError, type EnrichedPerson } from "../src/lib/outreach/providers/types";
import { allocateResearch, createResearchPersonHandler, runResearchAttempt } from "../src/lib/outreach/research/attempt";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-research-user";
const person = (overrides: Partial<EnrichedPerson> = {}): EnrichedPerson => ({
  apolloId: "ap_1", fullName: "Jane Doe", title: "Head of Partnerships", company: "Ramp", organizationDomain: "ramp.com",
  location: "New York", linkedinUrl: "https://www.linkedin.com/in/jane-doe", email: "jane@ramp.com", emailStatus: "verified",
  employment: [], ...overrides,
});

function providers(opts: { enrich: () => Promise<EnrichedPerson | null>; searchResults?: number; searchFails?: boolean }): ProviderResolver {
  return async (): Promise<ResearchProviders> => ({
    funding: "orbit", keyOwner: "orbit", demo: false,
    enrichment: { name: "apollo", match: opts.enrich },
    search: {
      name: "brave",
      async search() {
        if (opts.searchFails) throw new ProviderError("brave", "unavailable", "down");
        return {
          moreAvailable: false,
          results: Array.from({ length: opts.searchResults ?? 0 }, (_, i) => ({
            url: `https://news.example/${i}`, title: `Jane Doe speaks at Money20/20 (${i})`, description: "Doe on partnerships", extraSnippets: [],
          })),
        };
      },
    },
  });
}
const judge = async () => JSON.stringify({ candidates: [] });

async function main() {
  const db = await getDb();
  await ensureUserSettings(USER);
  await db.update(schema.userSettings).set({ compedPlan: "orbit" }).where(eq(schema.userSettings.userId, USER));
  const { id: campaignId } = await createCampaignV2(USER, {
    brief: { purpose: "Meet partnership leads in fintech", desiredOutcome: "Intro calls" }, channel: "email",
  });
  await saveCriteria(USER, campaignId, { required: [{ kind: "role", label: "Partnerships", values: ["Partnerships"] }], preferred: [], exclusions: [] });
  const make = async (slug: string, extra: Partial<typeof schema.outreachProspects.$inferInsert> = {}) => {
    const r = await upsertCandidate(USER, campaignId, {
      fullName: "Jane Doe", company: "Ramp", linkedinUrl: `https://www.linkedin.com/in/${slug}`, origin: "discovered",
      evidence: [{ kind: "search_result", provider: "brave", url: `https://www.linkedin.com/in/${slug}`, title: `Jane Doe - ${slug}`, snippet: "x" }],
    });
    if (Object.keys(extra).length) await db.update(schema.outreachProspects).set(extra).where(eq(schema.outreachProspects.id, r.prospectId));
    return r.prospectId;
  };
  const start = await getCreditBalance(USER);

  console.log("Success charges exactly once...");
  const p1 = await make("jane-doe");
  const hold1 = await reserveCredits(USER, { want: 1, idempotencyKey: "one" });
  const a1 = (await allocateResearch(USER, { campaignId, prospectId: p1, runId: null, funding: "orbit", holdId: hold1!.holdId }))!;
  let judged = 0;
  const outcome = await runResearchAttempt(USER, a1, {
    resolveProviders: providers({ enrich: async () => person(), searchResults: 2 }),
    complete: async () => {
      judged++;
      return judge();
    },
  });
  check("research succeeds", outcome === "succeeded");
  const [jane] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, p1));
  check("the email and its status come from enrichment", jane.email === "jane@ramp.com" && jane.emailStatus === "verified" && jane.emailSource === "apollo");
  check("the prospect is marked researched", jane.researchState === "done");
  const ev = await db.select().from(schema.outreachEvidence).where(eq(schema.outreachEvidence.prospectId, p1));
  check("enrichment and supporting sources become evidence",
    ev.some((e) => e.kind === "enrichment") && ev.filter((e) => e.kind === "web_page").length === 2, JSON.stringify(ev.map((e) => e.kind)));
  check("the person was re-ranked with the new evidence", judged === 1);
  check("one credit was spent", (await getCreditBalance(USER)).total === start.total - 1);
  check("re-running the attempt does nothing", (await runResearchAttempt(USER, a1, { resolveProviders: providers({ enrich: async () => person() }), complete: judge })) === "skipped");
  check("…and charges nothing more", (await getCreditBalance(USER)).total === start.total - 1);

  console.log("Emails are never invented or overwritten...");
  const p2 = await make("jane-doe-2", { email: "jane.personal@proton.me", emailSource: "user" });
  const hold2 = await reserveCredits(USER, { want: 1, idempotencyKey: "two" });
  const a2 = (await allocateResearch(USER, { campaignId, prospectId: p2, runId: null, funding: "orbit", holdId: hold2!.holdId }))!;
  await runResearchAttempt(USER, a2, { resolveProviders: providers({ enrich: async () => person({ apolloId: "ap_2", email: "other@ramp.com" }) }), complete: judge });
  const [typed] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, p2));
  check("an email the user entered is kept", typed.email === "jane.personal@proton.me" && typed.emailSource === "user");
  const p3 = await make("jane-doe-3");
  const hold3 = await reserveCredits(USER, { want: 1, idempotencyKey: "three" });
  const a3 = (await allocateResearch(USER, { campaignId, prospectId: p3, runId: null, funding: "orbit", holdId: hold3!.holdId }))!;
  await runResearchAttempt(USER, a3, { resolveProviders: providers({ enrich: async () => person({ apolloId: "ap_3", email: null, emailStatus: null }) }), complete: judge });
  const [noEmail] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, p3));
  check("no email from the provider means no email", noEmail.email === null && noEmail.emailStatus === null);

  console.log("Partial and failed attempts...");
  const beforePartial = (await getCreditBalance(USER)).total;
  const p4 = await make("jane-doe-4");
  const hold4 = await reserveCredits(USER, { want: 1, idempotencyKey: "four" });
  const a4 = (await allocateResearch(USER, { campaignId, prospectId: p4, runId: null, funding: "orbit", holdId: hold4!.holdId }))!;
  const partial = await runResearchAttempt(USER, a4, {
    resolveProviders: providers({ enrich: async () => { throw new ProviderError("apollo", "unavailable", "down"); }, searchResults: 1 }),
    complete: judge,
  });
  check("an enrichment outage with supporting sources is partial", partial === "partial");
  check("a partial attempt is charged", (await getCreditBalance(USER)).total === beforePartial - 1);

  const beforeFail = (await getCreditBalance(USER)).total;
  const p5 = await make("jane-doe-5");
  const hold5 = await reserveCredits(USER, { want: 1, idempotencyKey: "five" });
  const a5 = (await allocateResearch(USER, { campaignId, prospectId: p5, runId: null, funding: "orbit", holdId: hold5!.holdId }))!;
  const failed = await runResearchAttempt(USER, a5, { resolveProviders: providers({ enrich: async () => null, searchFails: true }), complete: judge });
  check("nothing found anywhere is a failure", failed === "failed");
  check("a failed attempt costs nothing and its hold is released", (await getCreditBalance(USER)).total === beforeFail);

  console.log("Personal funding and run budgets...");
  const p6 = await make("jane-doe-6");
  const a6 = (await allocateResearch(USER, { campaignId, prospectId: p6, runId: null, funding: "personal", holdId: null }))!;
  const beforePersonal = (await getCreditBalance(USER)).total;
  await runResearchAttempt(USER, a6, { resolveProviders: providers({ enrich: async () => person({ apolloId: "ap_6", email: "six@ramp.com" }) }), complete: judge });
  check("personal research never touches credits", (await getCreditBalance(USER)).total === beforePersonal);
  const [attempt6] = await db.select().from(schema.outreachResearchAttempts).where(eq(schema.outreachResearchAttempts.id, a6));
  check("…and records no credit state", attempt6.creditState === "none");

  const [runRow] = await db
    .insert(schema.outreachResearchRuns)
    .values({ userId: USER, campaignId, criteriaVersion: 1, fundingSource: "personal", researchBudget: 1 })
    .returning();
  const p7 = await make("jane-doe-7");
  const p8 = await make("jane-doe-8");
  check("the first allocation fits the run budget", Boolean(await allocateResearch(USER, { campaignId, prospectId: p7, runId: runRow.id, funding: "personal", holdId: null })));
  check("the second exceeds it and is refused", (await allocateResearch(USER, { campaignId, prospectId: p8, runId: runRow.id, funding: "personal", holdId: null })) === null);
  const jobs = await db.select().from(schema.outreachJobs).where(and(eq(schema.outreachJobs.userId, USER), eq(schema.outreachJobs.kind, "research.person")));
  check("each allocation queued exactly one job", jobs.length === 7, String(jobs.length));

  // After the job count above, so the attempts these checks allocate don't disturb it.
  console.log("An attempt stores Orbit’s words, never a raw error...");
  const attemptError = async (slug: string, err: Error) => {
    const p = await make(slug);
    const a = (await allocateResearch(USER, { campaignId, prospectId: p, runId: null, funding: "personal", holdId: null }))!;
    const outcome = await runResearchAttempt(USER, a, { resolveProviders: async () => { throw err; }, complete: judge });
    const [row] = await db.select().from(schema.outreachResearchAttempts).where(eq(schema.outreachResearchAttempts.id, a));
    return { outcome, error: row.error };
  };
  const raw = await attemptError("jane-doe-raw", new Error("connect ECONNREFUSED 10.0.0.7:5432 — upstream said {\"key\":\"ap_live_123\"}"));
  check("an unexpected resolver error fails the attempt", raw.outcome === "failed");
  check("…and stores fixed copy, not the raw message", raw.error === "Research isn’t available right now — try again later", String(raw.error));
  const worded = await attemptError("jane-doe-worded", new UserFacingError("Add your Brave Search key in Settings to search with your own keys"));
  check("a UserFacingError keeps its own words", worded.error === "Add your Brave Search key in Settings to search with your own keys", String(worded.error));

  // Only `finish()` used to settle an attempt, so a job that died — thrown through its last
  // attempt, or its last lease expired — left a single-person hold in monthly_held forever
  // and the person "queued"/"running" for good.
  console.log("A research job that dies on its last attempt still settles the attempt...");
  /** A single-person Orbit-funded attempt, claimed the way researchOnePerson claims one. */
  const heldAttempt = async (slug: string) => {
    const p = await make(slug);
    const hold = await reserveCredits(USER, { want: 1, idempotencyKey: `held:${slug}` });
    await db.update(schema.outreachProspects).set({ researchState: "queued" }).where(eq(schema.outreachProspects.id, p));
    const a = (await allocateResearch(USER, { campaignId, prospectId: p, runId: null, funding: "orbit", holdId: hold!.holdId }))!;
    const [job] = await db
      .select()
      .from(schema.outreachJobs)
      .where(and(eq(schema.outreachJobs.userId, USER), sql`${schema.outreachJobs.payload}->>'attemptId' = ${a}`));
    return { prospectId: p, attemptId: a, holdId: hold!.holdId, job };
  };
  const jobFor = (job: typeof schema.outreachJobs.$inferSelect, attempts: number) => ({
    id: job.id, userId: USER, campaignId, kind: job.kind, payload: job.payload, attempts, maxAttempts: job.maxAttempts, progress: {},
  });
  const ctx = (job: ReturnType<typeof jobFor>) => ({
    job, workerId: "smoke-research-worker", now: () => new Date(), deadline: Date.now() + 60_000, extendLease: async () => true,
  });
  // A resolver that hands back nothing makes `providers.enrichment` throw a TypeError outside
  // every provider try/catch — an escape as unplanned as the bugs the catch exists for.
  const crashing = createResearchPersonHandler({ resolveProviders: async () => null as unknown as ResearchProviders, complete: judge });

  const beforeDeath = await getCreditBalance(USER);
  const dying = await heldAttempt("jane-doe-dying");
  check("the attempt holds one credit", (await getCreditBalance(USER)).held === beforeDeath.held + 1);
  let rethrown = false;
  try {
    await crashing(ctx(jobFor(dying.job, 0)));
  } catch {
    rethrown = true;
  }
  check("a throw with attempts left is rethrown for the worker to retry", rethrown);
  const lastOutcome = await crashing(ctx(jobFor(dying.job, dying.job.maxAttempts - 1)));
  check("a throw on the last attempt settles the job instead of escaping", lastOutcome.status === "succeeded", JSON.stringify(lastOutcome));
  const [deadAttempt] = await db.select().from(schema.outreachResearchAttempts).where(eq(schema.outreachResearchAttempts.id, dying.attemptId));
  check("…the attempt is failed, in Orbit’s words", deadAttempt.status === "failed" && deadAttempt.error === "Research stopped unexpectedly — try again", JSON.stringify(deadAttempt));
  const afterDeath = await getCreditBalance(USER);
  check("…its hold is released, so the balance is whole again", afterDeath.held === beforeDeath.held && afterDeath.total === beforeDeath.total, JSON.stringify(afterDeath));
  const [deadPerson] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, dying.prospectId));
  check("…and the person reads as failed, not stuck", deadPerson.researchState === "failed", deadPerson.researchState);

  console.log("An attempt with no job left to finish it is reaped...");
  const staleAt = new Date(Date.now() - 15 * 60_000);
  const beforeReap = await getCreditBalance(USER);
  // Its job is gone (a lease that expired on its last attempt, a worker killed mid-flight).
  const orphan = await heldAttempt("jane-doe-orphan");
  await db.update(schema.outreachJobs).set({ status: "failed", finishedAt: staleAt }).where(eq(schema.outreachJobs.id, orphan.job.id));
  // Its job is still queued — a worker will get to it, so it is not abandoned.
  const waiting = await heldAttempt("jane-doe-waiting");
  // No job either, but too recent to call abandoned.
  const recent = await heldAttempt("jane-doe-recent");
  await db.update(schema.outreachJobs).set({ status: "failed" }).where(eq(schema.outreachJobs.id, recent.job.id));
  for (const a of [orphan, waiting]) {
    await db
      .update(schema.outreachResearchAttempts)
      .set({ status: "running", startedAt: staleAt, updatedAt: staleAt })
      .where(eq(schema.outreachResearchAttempts.id, a.attemptId));
    await db.update(schema.outreachProspects).set({ researchState: "running" }).where(eq(schema.outreachProspects.id, a.prospectId));
  }
  check("three holds are out", (await getCreditBalance(USER)).held === beforeReap.held + 3);
  await getLatestRun(USER, campaignId);
  const attemptRow = async (id: string) => (await db.select().from(schema.outreachResearchAttempts).where(eq(schema.outreachResearchAttempts.id, id)))[0];
  const personRow = async (id: string) => (await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, id)))[0];
  const reaped = await attemptRow(orphan.attemptId);
  check("the orphaned attempt is failed", reaped.status === "failed" && reaped.error === "Research stopped unexpectedly — try again", JSON.stringify(reaped));
  check("…its person reads as failed", (await personRow(orphan.prospectId)).researchState === "failed");
  check("…and only its hold came back", (await getCreditBalance(USER)).held === beforeReap.held + 2);
  check("an attempt whose job is still queued is left alone", (await attemptRow(waiting.attemptId)).status === "running");
  check("…as is one too recent to call abandoned", (await attemptRow(recent.attemptId)).status === "queued");

  console.log("All outreach research checks passed.");
}

run(main);
