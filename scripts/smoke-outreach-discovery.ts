/**
 * A whole discovery run through the real worker with fake providers (spec §7.3): plan →
 * search → candidates → ranking → research in rank order within the credit hold → release of
 * the unused remainder. Plus the edges: budgets are respected, a flaky provider leaves a
 * partial run with everything it found, a rejected personal key stops the run without falling
 * back, cancelling releases credits, and the Orbit-funded daily cap holds. Plus two controller
 * rulings: one active run per campaign is a structural DB constraint, not a check-then-insert
 * race, and a suppressed person is never spent on even when they rank well.
 *
 * Run: npx tsx scripts/smoke-outreach-discovery.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { createCampaignV2, saveCriteria } from "../src/lib/outreach/campaigns";
import { getCreditBalance } from "../src/lib/outreach/credits/ledger";
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
