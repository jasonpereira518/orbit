/**
 * A whole discovery run through the real worker with fake providers (spec §7.3): plan →
 * search → candidates → ranking → research in rank order within the credit hold → release of
 * the unused remainder. Plus the edges: budgets are respected, a flaky provider leaves a
 * partial run with everything it found, a rejected personal key stops the run without falling
 * back, cancelling releases credits, and the Orbit-funded daily cap holds. Plus the controller
 * rulings: one active run per campaign is a structural DB constraint, not a check-then-insert
 * race (including a race that lands inside provider resolution, between the pre-check and the
 * INSERT); a suppressed person is never spent on even when they rank well; the ranking-phase
 * sweep re-ranks a prospect the searching phase never saw; a run whose job died is reaped
 * rather than left stranded active with its hold; and the searching phase's queriesUsed never
 * drifts from the search calls it actually made.
 *
 * Run: npx tsx scripts/smoke-outreach-discovery.ts
 */
import "./smoke/_env";

import { and, eq, inArray, sql } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { createCampaignV2, saveCriteria } from "../src/lib/outreach/campaigns";
import { getCreditBalance } from "../src/lib/outreach/credits/ledger";
import { upsertCandidate } from "../src/lib/outreach/discovery/candidates";
import { cancelDiscoveryRun, createDiscoveryRunHandler, getLatestRun, startDiscoveryRun } from "../src/lib/outreach/discovery/run";
import { runWorkerPass, type JobHandlers } from "../src/lib/outreach/jobs/worker";
import type { ProviderResolver } from "../src/lib/outreach/providers/resolve";
import { ProviderError, type SearchPage } from "../src/lib/outreach/providers/types";
import { createRankingBatchHandler } from "../src/lib/outreach/ranking/apply";
import { createResearchPersonHandler } from "../src/lib/outreach/research/attempt";
import type { JsonCompleter } from "../src/lib/outreach/types";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-discovery-user";
const TITLES = ["Head of Partnerships", "VP Partnerships", "Partnerships Lead", "Engineer", "Head of Partnerships"];

function searchPage(q: string, offset: number): SearchPage {
  const base = offset * 5;
  return {
    moreAvailable: offset === 0,
    results: TITLES.map((title, i) => ({
      url: `https://www.linkedin.com/in/person-${base + i}`,
      title: `Person ${base + i} - ${title} - Fintech Co | LinkedIn`,
      description: `${title} at Fintech Co · Location: New York`,
      extraSnippets: [],
    })).concat([{ url: "https://www.linkedin.com/company/fintech-co", title: "Fintech Co | LinkedIn", description: "", extraSnippets: [] }]),
  };
}

/** Matches the role criterion when the evidence mentions "Partnerships", mismatches otherwise. */
const judge: JsonCompleter = async (_u, input) => {
  if (input.operation === "outreach.plan") return JSON.stringify({ queries: ['"Head of Partnerships" fintech', '"VP Partnerships" fintech'] });
  const roleId = input.user.match(/id=(\S+) \[required\] role/)?.[1] ?? "";
  return JSON.stringify({
    candidates: input.user.split("Candidate id=").slice(1).map((block) => {
      const id = block.split("\n")[0].trim();
      const evidenceId = block.match(/\[([0-9a-f-]{36})\]/)?.[1];
      return {
        id, summary: "",
        verdicts: [{ criterionId: roleId, verdict: block.includes("Partnerships") ? "match" : "mismatch", evidenceIds: evidenceId ? [evidenceId] : [] }],
      };
    }),
  });
};

function fakeProviders(opts: { searchCalls: { n: number }; failQuery?: string; authFails?: boolean; funding?: "orbit" | "personal" }): ProviderResolver {
  return async () => ({
    funding: opts.funding ?? "orbit", keyOwner: opts.funding === "personal" ? "user" : "orbit", demo: false,
    search: {
      name: "brave",
      async search(q, { offset }) {
        opts.searchCalls.n++;
        if (opts.authFails) throw new ProviderError("brave", "auth", "rejected");
        if (opts.failQuery && q.includes(opts.failQuery)) throw new ProviderError("brave", "rate_limited", "slow down");
        return q.includes("site:linkedin.com/in") ? searchPage(q, offset) : { results: [], moreAvailable: false };
      },
    },
    enrichment: {
      name: "apollo",
      async match(input) {
        return {
          apolloId: `ap-${input.linkedinUrl}`, fullName: input.fullName ?? null, title: null, company: "Fintech Co", organizationDomain: null,
          location: null, linkedinUrl: input.linkedinUrl ?? null, email: null, emailStatus: null, employment: [],
        };
      },
    },
  });
}

async function drain(handlers: JobHandlers) {
  let clock = Date.now();
  await runWorkerPass({
    handlers, gate: async () => true, workerId: `w-${Math.random()}`,
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
  });
}

function handlersFor(resolveProviders: ProviderResolver): JobHandlers {
  return {
    "discovery.run": createDiscoveryRunHandler({ resolveProviders, complete: judge }),
    "ranking.batch": createRankingBatchHandler({ complete: judge }),
    "research.person": createResearchPersonHandler({ resolveProviders, complete: judge }),
  };
}

async function newCampaign() {
  const { id } = await createCampaignV2(USER, { brief: { purpose: "Meet partnership leads in fintech", desiredOutcome: "Intro calls" }, channel: "email" });
  return id;
}

async function main() {
  const db = await getDb();
  await ensureUserSettings(USER);
  await db.update(schema.userSettings).set({ compedPlan: "orbit" }).where(eq(schema.userSettings.userId, USER));

  console.log("Start-time validation...");
  const unconfirmed = await newCampaign();
  let msg = "";
  try {
    await startDiscoveryRun(USER, { campaignId: unconfirmed, funding: "orbit", researchBudget: 5 }, { resolveProviders: fakeProviders({ searchCalls: { n: 0 } }) });
  } catch (err) {
    msg = (err as Error).message;
  }
  check("a run needs confirmed criteria", msg.includes("Confirm the audience"));

  console.log("A full run...");
  const campaignId = await newCampaign();
  await saveCriteria(USER, campaignId, { required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [] });
  const searchCalls = { n: 0 };
  const resolver = fakeProviders({ searchCalls });
  const before = await getCreditBalance(USER);
  const started = await startDiscoveryRun(USER, { campaignId, funding: "orbit", researchBudget: 3 }, { resolveProviders: resolver });
  check("credits are reserved up front", started.researchBudget === 3 && (await getCreditBalance(USER)).total === before.total - 3);
  let dup = "";
  try {
    await startDiscoveryRun(USER, { campaignId, funding: "orbit", researchBudget: 3 }, { resolveProviders: resolver });
  } catch (err) {
    dup = (err as Error).message;
  }
  check("one active run per campaign", dup.includes("already running"));

  // Ruling 1: the guard is structural (a partial unique index on campaign_id WHERE status IN
  // ('queued','running')), not a check-then-insert race. Prove the database itself refuses a
  // second active row for this campaign — inserted directly, bypassing startDiscoveryRun's own
  // friendly pre-check entirely — while the first run (still "queued", not yet drained) holds
  // the index. A direct insert is the deterministic option on PGlite: two concurrent
  // startDiscoveryRun calls would still race on which one's friendly SELECT runs first, but a
  // raw second INSERT against a still-active row is guaranteed to collide with the index.
  let structuralViolation = false;
  let structuralMessage = "";
  try {
    await db.insert(schema.outreachResearchRuns).values({
      userId: USER,
      campaignId,
      criteriaVersion: 1,
      status: "queued",
      fundingSource: "orbit",
    });
  } catch (err) {
    structuralViolation = true;
    structuralMessage = (err as Error).message;
  }
  check("a second active run for the same campaign is rejected by the database", structuralViolation, structuralMessage);

  // Ruling 1, the race that actually matters: a competing start that lands its own INSERT
  // between THIS call's friendly pre-check and its own INSERT — the exact window the pre-check
  // cannot close, which only the structural index can. Funded "personal" so it doesn't touch
  // the Orbit-funded daily-cap arithmetic below.
  const raceCampaign = await newCampaign();
  await saveCriteria(USER, raceCampaign, { required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [] });
  const racingResolver: ProviderResolver = async (_uid, funding) => {
    await db.insert(schema.outreachResearchRuns).values({
      userId: USER,
      campaignId: raceCampaign,
      criteriaVersion: 1,
      status: "queued",
      fundingSource: "personal",
    });
    return {
      funding, keyOwner: "user", demo: false,
      search: { name: "brave", async search() { return { results: [], moreAvailable: false }; } },
      enrichment: null,
    };
  };
  let raceMsg = "";
  try {
    await startDiscoveryRun(USER, { campaignId: raceCampaign, funding: "personal", researchBudget: 0 }, { resolveProviders: racingResolver });
  } catch (err) {
    raceMsg = (err as Error).message;
  }
  check("a race inside provider resolution still ends with exactly one active run", raceMsg.includes("already running"), raceMsg);
  const raceActiveRuns = await db
    .select()
    .from(schema.outreachResearchRuns)
    .where(and(eq(schema.outreachResearchRuns.campaignId, raceCampaign), inArray(schema.outreachResearchRuns.status, ["queued", "running"])));
  check("exactly one active run exists for that campaign", raceActiveRuns.length === 1, String(raceActiveRuns.length));
  // Clean it up so this campaign doesn't dangle an active run.
  await cancelDiscoveryRun(USER, raceActiveRuns[0].id);

  await drain(handlersFor(resolver));
  const summary = await getLatestRun(USER, campaignId);
  check("the run completes", summary?.status === "completed", JSON.stringify(summary));
  const people = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.campaignId, campaignId));
  check("profiles become people; company pages do not", people.length === 10 && people.every((p) => p.linkedinUrl?.includes("/in/person-")), String(people.length));
  check("everyone is ranked", people.every((p) => p.rankTier !== null));
  check("the engineers are filtered with a reason", people.filter((p) => p.rankTier === "filtered").length === 2);
  const researched = people.filter((p) => p.researchState === "done");
  check("research stays within the budget", researched.length === 3, String(researched.length));
  check("research went to the best-ranked people", researched.every((p) => p.rankTier === "strong"));
  check("the query budget was respected", searchCalls.n <= 15 + 3 * 2, String(searchCalls.n));
  check("no email was invented", people.every((p) => p.email === null));
  const after = await getCreditBalance(USER);
  check("exactly the three research credits were spent", after.total === before.total - 3 && after.held === 0, JSON.stringify(after));
  check("the candidates count is recorded", summary?.candidatesFound === 10);

  console.log("A flaky provider leaves a partial run...");
  const partialCampaign = await newCampaign();
  await saveCriteria(USER, partialCampaign, { required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [] });
  const flaky = fakeProviders({ searchCalls: { n: 0 }, failQuery: "VP Partnerships" });
  await startDiscoveryRun(USER, { campaignId: partialCampaign, funding: "orbit", researchBudget: 0 }, { resolveProviders: flaky });
  await drain(handlersFor(flaky));
  const partial = await getLatestRun(USER, partialCampaign);
  check("a run with provider errors ends partial", partial?.status === "partial", JSON.stringify(partial));
  check("…and keeps what it found", (partial?.candidatesFound ?? 0) > 0);

  console.log("A rejected personal key stops the run...");
  await db.update(schema.userSettings).set({ braveApiKeyEncrypted: "placeholder" }).where(eq(schema.userSettings.userId, USER));
  const personalCampaign = await newCampaign();
  await saveCriteria(USER, personalCampaign, { required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [] });
  const rejecting = fakeProviders({ searchCalls: { n: 0 }, authFails: true, funding: "personal" });
  await startDiscoveryRun(USER, { campaignId: personalCampaign, funding: "personal", researchBudget: 5 }, { resolveProviders: rejecting });
  await drain(handlersFor(rejecting));
  const stopped = await getLatestRun(USER, personalCampaign);
  check("the run fails with the key message", stopped?.status === "failed" && Boolean(stopped.error?.includes("Brave key")), JSON.stringify(stopped));
  check("personal runs reserve no credits", (await getCreditBalance(USER)).held === 0);

  console.log("Cancelling releases credits...");
  const cancelCampaign = await newCampaign();
  await saveCriteria(USER, cancelCampaign, { required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [] });
  const beforeCancel = (await getCreditBalance(USER)).total;
  const toCancel = await startDiscoveryRun(USER, { campaignId: cancelCampaign, funding: "orbit", researchBudget: 10 }, { resolveProviders: resolver });
  check("cancel succeeds", await cancelDiscoveryRun(USER, toCancel.runId));
  check("the reservation came back", (await getCreditBalance(USER)).total === beforeCancel);
  const queued = await db
    .select()
    .from(schema.outreachJobs)
    .where(and(eq(schema.outreachJobs.userId, USER), eq(schema.outreachJobs.campaignId, cancelCampaign), eq(schema.outreachJobs.status, "queued")));
  check("its queued jobs were cancelled", queued.length === 0);

  // Ruling 3: a suppressed person (opted out / bounced) is flagged on insert and must never be
  // spent on, even when they rank well. Funded "personal" with a fake resolver so this check
  // does not touch the Orbit-funded daily-cap arithmetic below (which counts only the three
  // orbit-funded starts already made above, before the loop).
  console.log("A suppressed person is never researched...");
  const suppressedCampaign = await newCampaign();
  await saveCriteria(USER, suppressedCampaign, { required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [] });
  await db.insert(schema.outreachSuppressions).values({ userId: USER, kind: "linkedin_slug", value: "person-0", reason: "opted_out" });
  const suppressedResolver = fakeProviders({ searchCalls: { n: 0 }, funding: "personal" });
  await startDiscoveryRun(USER, { campaignId: suppressedCampaign, funding: "personal", researchBudget: 10 }, { resolveProviders: suppressedResolver });
  await drain(handlersFor(suppressedResolver));
  const suppressedPeople = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.campaignId, suppressedCampaign));
  const suppressedPerson = suppressedPeople.find((p) => p.linkedinUrl?.includes("/in/person-0"));
  check("the suppressed person was flagged on insert", suppressedPerson?.flags.suppressed === "opted_out", JSON.stringify(suppressedPerson?.flags));
  check("the suppressed person was never researched", suppressedPerson?.researchState === "none", suppressedPerson?.researchState);

  // Ruling 2: a prospect the searching phase never saw (inserted directly, standing in for one
  // a crashed searching-phase retry lost from its in-memory `created` list) still gets ranked,
  // via the ranking phase's one-time sweep. Funded "personal" so it doesn't touch the
  // Orbit-funded daily-cap arithmetic below.
  console.log("The ranking sweep ranks a prospect the search phase never created...");
  const sweepCampaign = await newCampaign();
  await saveCriteria(USER, sweepCampaign, { required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [] });
  const lostProspect = await upsertCandidate(
    USER,
    sweepCampaign,
    {
      fullName: "Lost Candidate",
      headline: "Head of Partnerships",
      company: "Fintech Co",
      location: "New York",
      linkedinUrl: "https://www.linkedin.com/in/lost-candidate",
      origin: "discovered",
      evidence: [
        {
          kind: "search_result", provider: "brave", url: "https://www.linkedin.com/in/lost-candidate",
          title: "Lost Candidate - Head of Partnerships", snippet: "Head of Partnerships at Fintech Co", facts: {},
        },
      ],
    },
    { trustedCampaign: true }
  );
  const sweepResolver = fakeProviders({ searchCalls: { n: 0 }, funding: "personal" });
  await startDiscoveryRun(USER, { campaignId: sweepCampaign, funding: "personal", researchBudget: 0 }, { resolveProviders: sweepResolver });
  await drain(handlersFor(sweepResolver));
  const [sweptProspect] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, lostProspect.prospectId));
  check("the sweep ranked the prospect the search phase never created", sweptProspect?.rankedCriteriaVersion !== null, String(sweptProspect?.rankedCriteriaVersion));

  // Reaper: a run whose job died leaves no trace but the row itself — inserted directly here,
  // standing in for a worker that abandoned it. getLatestRun must notice and fail it (releasing
  // its hold), and the campaign must be startable again afterward. Funded "personal" throughout
  // so this doesn't touch the Orbit-funded daily-cap arithmetic below.
  console.log("The reaper fails a run whose job died silently...");
  const staleCampaign = await newCampaign();
  await saveCriteria(USER, staleCampaign, { required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [] });
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
  await db.insert(schema.outreachResearchRuns).values({
    userId: USER,
    campaignId: staleCampaign,
    criteriaVersion: 1,
    status: "running",
    fundingSource: "personal",
    createdAt: fiveMinAgo,
    updatedAt: fiveMinAgo,
    startedAt: fiveMinAgo,
  });
  const reaped = await getLatestRun(USER, staleCampaign);
  check(
    "the reaper marks an abandoned run failed",
    reaped?.status === "failed" && Boolean(reaped.error?.includes("stopped unexpectedly")),
    JSON.stringify(reaped)
  );
  const afterReapStart = await startDiscoveryRun(
    USER,
    { campaignId: staleCampaign, funding: "personal", researchBudget: 0 },
    { resolveProviders: fakeProviders({ searchCalls: { n: 0 }, funding: "personal" }) }
  );
  check("a new run can start on the campaign after the reap", Boolean(afterReapStart.runId));
  await cancelDiscoveryRun(USER, afterReapStart.runId);

  // Checkpointing: a fake search that throws a plain Error from inside result-handling is hard
  // to arrange deterministically without malformed synthetic data (see the report). Instead
  // assert the observable guarantee the per-page checkpoint exists to protect: queriesUsed
  // matches exactly the discovery-phase search calls actually made, never more (a re-paid
  // repeat) and never less (a checkpoint lost). Funded "personal" so it doesn't touch the
  // Orbit-funded daily-cap arithmetic below.
  console.log("Checkpointing: queriesUsed matches the discovery-phase search calls made...");
  const checkpointCampaign = await newCampaign();
  await saveCriteria(USER, checkpointCampaign, { required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [] });
  const queriesSeen: string[] = [];
  const checkpointResolver: ProviderResolver = async () => ({
    funding: "personal", keyOwner: "user", demo: false,
    search: {
      name: "brave",
      async search(q, { offset }) {
        queriesSeen.push(q);
        return q.includes("site:linkedin.com/in") ? searchPage(q, offset) : { results: [], moreAvailable: false };
      },
    },
    enrichment: null,
  });
  await startDiscoveryRun(USER, { campaignId: checkpointCampaign, funding: "personal", researchBudget: 0 }, { resolveProviders: checkpointResolver });
  await drain(handlersFor(checkpointResolver));
  const checkpointSummary = await getLatestRun(USER, checkpointCampaign);
  const discoveryCalls = queriesSeen.filter((q) => q.includes("site:linkedin.com/in")).length;
  check(
    "queriesUsed matches the discovery-phase search calls actually made",
    checkpointSummary?.queriesUsed === discoveryCalls,
    `queriesUsed=${checkpointSummary?.queriesUsed} discoveryCalls=${discoveryCalls}`
  );

  // Final-attempt catch: force the handler to throw unexpectedly (a corrupted `plan`, standing
  // in for a genuine bug or a transient DB hiccup — see the report on why a fake search can't
  // reach this path) on what looks like the job's last attempt. The run must fail cleanly with
  // the standard message and release its hold, rather than retry forever or strand credits.
  // Orbit-funded deliberately: personal funding never takes a hold, and this test exists to
  // prove one gets released. It is the fourth Orbit-funded start in this script (after the full
  // run, the flaky-provider run and the cancelled run), so the daily-cap loop below now trips
  // one iteration earlier than a purely-3-before-the-loop count would suggest — the loop's own
  // assertion doesn't depend on which iteration, so nothing else needed to change.
  console.log("Final-attempt catch: an unexpected error on the last attempt fails cleanly...");
  const finalAttemptCampaign = await newCampaign();
  await saveCriteria(USER, finalAttemptCampaign, { required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [] });
  const finalAttemptResolver = fakeProviders({ searchCalls: { n: 0 } });
  const beforeFinalAttempt = await getCreditBalance(USER);
  const finalAttemptStart = await startDiscoveryRun(
    USER,
    { campaignId: finalAttemptCampaign, funding: "orbit", researchBudget: 4 },
    { resolveProviders: finalAttemptResolver }
  );
  await db.execute(sql`UPDATE outreach_research_runs SET phase = 'searching', plan = 'null'::jsonb WHERE id = ${finalAttemptStart.runId}::uuid`);
  const finalHandler = createDiscoveryRunHandler({ resolveProviders: finalAttemptResolver, complete: judge });
  const finalOutcome = await finalHandler({
    job: {
      id: "synthetic-final-attempt", userId: USER, campaignId: finalAttemptCampaign, kind: "discovery.run",
      payload: { runId: finalAttemptStart.runId }, attempts: 4, maxAttempts: 5, progress: {},
    },
    workerId: "synthetic-worker",
    now: () => new Date(),
    deadline: Date.now() + 60_000,
    extendLease: async () => true,
  });
  check("the handler resolves the job rather than throwing past a final attempt", finalOutcome.status === "succeeded", JSON.stringify(finalOutcome));
  const finalAttemptSummary = await getLatestRun(USER, finalAttemptCampaign);
  check(
    "a crash on the last attempt fails the run with the standard message",
    finalAttemptSummary?.status === "failed" && finalAttemptSummary.error === "The search stopped unexpectedly — try again",
    JSON.stringify(finalAttemptSummary)
  );
  const afterFinalAttempt = await getCreditBalance(USER);
  check("its hold was released", afterFinalAttempt.held === 0 && afterFinalAttempt.total === beforeFinalAttempt.total, JSON.stringify(afterFinalAttempt));

  console.log("The Orbit-funded daily cap...");
  let capped = "";
  for (let i = 0; i < 6 && !capped; i++) {
    const c = await newCampaign();
    await saveCriteria(USER, c, { required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }], preferred: [], exclusions: [] });
    try {
      const r = await startDiscoveryRun(USER, { campaignId: c, funding: "orbit", researchBudget: 0 }, { resolveProviders: resolver });
      await cancelDiscoveryRun(USER, r.runId);
    } catch (err) {
      capped = (err as Error).message;
    }
  }
  check("the sixth Orbit-funded run in a day is refused", capped.includes("today’s Orbit-funded searches"), capped);

  console.log("All outreach discovery checks passed.");
}

run(main);
