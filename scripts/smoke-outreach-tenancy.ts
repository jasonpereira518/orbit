/**
 * Every stage-1 entry point, called by the wrong user with the right user's ids (spec §12).
 * Server actions resolve the user from the session and pass it here, so this is the layer that
 * must refuse. A single missing user_id filter shows up as another person's data — or another
 * person's credits — moving.
 *
 * Every check below does two things: it asserts the intruder's call throws / returns empty /
 * reports 0 changed, AND (where there is a row that could have moved) it re-reads that row from
 * the owner's side to confirm nothing happened. A check that only did the first half would also
 * pass if the tenancy guard were deleted and some *other* condition happened to reject the call
 * first — see the "single research" and "starting a run" checks below for the two places that
 * risk is real (a second, unrelated guard — a missing Brave key, or the campaign-wide
 * one-active-run index — would also throw), and how each is closed by asserting on the specific
 * error message rather than just "it threw".
 *
 * Run: npx tsx scripts/smoke-outreach-tenancy.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { createCampaignV2, getCampaignV2, saveCriteria, suggestCriteria, updateCampaignBrief } from "../src/lib/outreach/campaigns";
import { chargeAttempt, getCreditBalance, releaseHold, reserveCredits } from "../src/lib/outreach/credits/ledger";
import { upsertCandidate } from "../src/lib/outreach/discovery/candidates";
import { cancelDiscoveryRun, getLatestRun, startDiscoveryRun } from "../src/lib/outreach/discovery/run";
import { excludePeople, listPeople, researchOnePerson, resolveDuplicate, restorePeople, selectPeople } from "../src/lib/outreach/people";
import { rankProspects } from "../src/lib/outreach/ranking/apply";
import { allocateResearch, runResearchAttempt } from "../src/lib/outreach/research/attempt";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function refuses(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const OWNER = "smoke-tenancy-owner";
const INTRUDER = "smoke-tenancy-intruder";

async function main() {
  const db = await getDb();
  for (const id of [OWNER, INTRUDER]) {
    await ensureUserSettings(id);
    await db.update(schema.userSettings).set({ compedPlan: "orbit" }).where(eq(schema.userSettings.userId, id));
  }
  const { id: campaignId } = await createCampaignV2(OWNER, {
    brief: { purpose: "Meet partnership leads in fintech", desiredOutcome: "Intro calls" }, channel: "email",
  });
  await saveCriteria(OWNER, campaignId, { required: [{ kind: "role", label: "Partnerships", values: ["Partnerships"] }], preferred: [], exclusions: [] });
  const { prospectId } = await upsertCandidate(OWNER, campaignId, {
    fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe", origin: "discovered",
    evidence: [{ kind: "search_result", provider: "brave", url: "https://www.linkedin.com/in/jane-doe", title: "Jane Doe - Partnerships", snippet: "x" }],
  });
  // A second prospect, used only for the exclude/restore round trip below, so `restorePeople`
  // has an actually-excluded row to fail to restore — Jane never leaves "suggested", so a
  // restore attempt against her would return changed:0 for a reason that has nothing to do with
  // tenancy (restorePeople only ever touches status='excluded' rows).
  const { prospectId: excludedId } = await upsertCandidate(OWNER, campaignId, {
    fullName: "Ed Excluded", linkedinUrl: "https://www.linkedin.com/in/ed-excluded", origin: "discovered", evidence: [],
  });
  await excludePeople(OWNER, campaignId, [excludedId], "owner excluded this one");

  const hold = await reserveCredits(OWNER, { want: 2, idempotencyKey: "tenancy" });
  const attemptId = (await allocateResearch(OWNER, { campaignId, prospectId, runId: null, funding: "orbit", holdId: hold!.holdId }))!;
  const [runRow] = await db
    .insert(schema.outreachResearchRuns)
    .values({ userId: OWNER, campaignId, criteriaVersion: 1, fundingSource: "personal", status: "running" })
    .returning();
  const ownerBalance = await getCreditBalance(OWNER);

  const reread = async () => (await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, prospectId)))[0];

  check("campaign read", (await getCampaignV2(INTRUDER, campaignId)) === null);

  check("brief update", await refuses(() => updateCampaignBrief(INTRUDER, campaignId, { brief: { purpose: "Hijacked purpose text", desiredOutcome: "x y z" } })));
  check("…the owner's brief is untouched", (await getCampaignV2(OWNER, campaignId))!.brief.purpose === "Meet partnership leads in fintech");

  check("criteria confirm", await refuses(() => saveCriteria(INTRUDER, campaignId, { required: [{ kind: "role", label: "X", values: ["X"] }], preferred: [], exclusions: [] })));
  const ownerCriteriaAfter = (await getCampaignV2(OWNER, campaignId))!;
  check(
    "…the owner's criteria are untouched",
    ownerCriteriaAfter.criteriaVersion === 1 && ownerCriteriaAfter.criteria.required[0]?.label === "Partnerships"
  );

  check("criteria suggestion", await refuses(() => suggestCriteria(INTRUDER, campaignId, async () => "{}")));

  check("candidate insert into someone else's campaign", await refuses(() =>
    upsertCandidate(INTRUDER, campaignId, { fullName: "Mallory", origin: "manual", evidence: [] })));
  const mallory = await db
    .select()
    .from(schema.outreachProspects)
    .where(and(eq(schema.outreachProspects.campaignId, campaignId), eq(schema.outreachProspects.fullName, "Mallory")));
  check("…no row was written for the attempted insert", mallory.length === 0);

  check("people listing", (await listPeople(INTRUDER, campaignId)).total === 0);

  check("selection", (await selectPeople(INTRUDER, campaignId, { scope: "ids", ids: [prospectId], selected: true })).changed === 0);
  check("selection by filter", (await selectPeople(INTRUDER, campaignId, { scope: "filter", filter: {}, exceptIds: [], selected: true })).changed === 0);
  check("…the owner's selection status is untouched", (await reread()).status === "suggested");

  check("exclusion", (await excludePeople(INTRUDER, campaignId, [prospectId], null)).changed === 0);
  check("…the owner's row was not excluded", (await reread()).status === "suggested");

  check("restore", (await restorePeople(INTRUDER, campaignId, [excludedId])).changed === 0);
  const excludedRow = (await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, excludedId)))[0];
  check("…the owner's excluded row stayed excluded", excludedRow.status === "excluded");

  await resolveDuplicate(INTRUDER, prospectId, "merged");
  const jane = await reread();
  check("duplicate resolution", jane.status !== "excluded");

  const beforeResearch = await reread();
  let researchErr: Error | null = null;
  try {
    await researchOnePerson(INTRUDER, prospectId, "orbit");
  } catch (err) {
    researchErr = err instanceof Error ? err : new Error(String(err));
  }
  // researchOnePerson's prospect lookup is scoped by id + userId and runs BEFORE any provider
  // resolution, so asserting the specific message (not just "it threw") rules out the call
  // instead being rejected downstream for an unrelated, environment-dependent reason (no Brave
  // key configured) — which would also throw and make a bare refuses() check pass vacuously.
  check(
    "single research",
    researchErr !== null && researchErr.message.includes("isn’t in your campaign"),
    researchErr?.message
  );
  check("…the owner's research state is untouched", (await reread()).researchState === beforeResearch.researchState);

  let startRunErr: Error | null = null;
  try {
    await startDiscoveryRun(INTRUDER, { campaignId, funding: "orbit", researchBudget: 1 });
  } catch (err) {
    startRunErr = err instanceof Error ? err : new Error(String(err));
  }
  // The fixture already gave this campaign an OWNER-created run in status 'running', and
  // outreach_research_runs_one_active_uidx (the one-active-run guard) is scoped by campaign_id
  // alone, not by user — so a bare refuses() check here would also pass if startDiscoveryRun's
  // ownership scoping (getCampaignV2 inside it) were deleted: the call would still throw "A
  // search is already running for this campaign" from that campaign-wide guard. Assert the
  // ownership-specific message instead, the same way the researchOnePerson check does above.
  check(
    "starting a run",
    startRunErr !== null && startRunErr.message.includes("That campaign isn’t available"),
    startRunErr?.message
  );
  const intruderRuns = await db
    .select()
    .from(schema.outreachResearchRuns)
    .where(and(eq(schema.outreachResearchRuns.campaignId, campaignId), eq(schema.outreachResearchRuns.userId, INTRUDER)));
  check("…no run row was created for the intruder", intruderRuns.length === 0);

  check("cancelling a run", !(await cancelDiscoveryRun(INTRUDER, runRow.id)));
  const runAfterCancelAttempt = (await db.select().from(schema.outreachResearchRuns).where(eq(schema.outreachResearchRuns.id, runRow.id)))[0];
  check("…the owner's run is still running", runAfterCancelAttempt.status === "running");

  check("reading the latest run", (await getLatestRun(INTRUDER, campaignId)) === null);

  check("ranking", (await rankProspects(INTRUDER, campaignId, [prospectId], async () => "{}")).ranked === 0);
  check("…the owner's prospect is still unranked", (await reread()).rankTier === null);

  const attemptBefore = (await db.select().from(schema.outreachResearchAttempts).where(eq(schema.outreachResearchAttempts.id, attemptId)))[0];
  check("running someone else's research attempt", (await runResearchAttempt(INTRUDER, attemptId)) === "skipped");
  const attemptAfterRun = (await db.select().from(schema.outreachResearchAttempts).where(eq(schema.outreachResearchAttempts.id, attemptId)))[0];
  check("…the attempt's status is untouched", attemptAfterRun.status === attemptBefore.status);

  check("charging someone else's attempt", !(await chargeAttempt(INTRUDER, attemptId)));
  const attemptAfterCharge = (await db.select().from(schema.outreachResearchAttempts).where(eq(schema.outreachResearchAttempts.id, attemptId)))[0];
  check("…the attempt's credit state is still held", attemptAfterCharge.creditState === "held");

  check("releasing someone else's hold", (await releaseHold(INTRUDER, hold!.holdId)) === 0);
  const holdAfter = (await db.select().from(schema.researchCreditHolds).where(eq(schema.researchCreditHolds.id, hold!.holdId)))[0];
  check("…the hold is still active", holdAfter.status === "active");

  check("the owner's credits did not move", (await getCreditBalance(OWNER)).total === ownerBalance.total);

  console.log("All outreach tenancy checks passed.");
}

run(main);
