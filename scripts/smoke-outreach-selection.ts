/**
 * People listing and selection (spec §7.7). "Select page" and "select all matching" are
 * different operations and must stay so; "all matching" applies to exactly the rows the filter
 * matches minus the exceptions, never to excluded or filtered-out people, and never to anyone
 * already in a conversation. Everything is scoped to the owner.
 *
 * Also covers the controller ruling on `researchOnePerson`: it is check-then-act on
 * `research_state`, so a double-click must not queue two attempts. The claim is one conditional
 * UPDATE — only one of two concurrent calls for the same person can win it. A run's allocation
 * takes the same claim, so a click and a run never both research (and charge for) one person.
 *
 * Run: npx tsx scripts/smoke-outreach-selection.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { createCampaignV2 } from "../src/lib/outreach/campaigns";
import { getCreditBalance } from "../src/lib/outreach/credits/ledger";
import {
  excludePeople,
  listPeople,
  researchOnePerson,
  restorePeople,
  resolveDuplicate,
  selectPeople,
} from "../src/lib/outreach/people";
import { allocateRunResearch } from "../src/lib/outreach/research/attempt";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-selection-user";
const OTHER = "smoke-selection-other";

async function main() {
  const db = await getDb();
  await ensureUserSettings(USER);
  const { id: campaignId } = await createCampaignV2(USER, { brief: { purpose: "Meet partnership leads in fintech", desiredOutcome: "Intro calls" }, channel: "email" });
  const tiers = [...Array(12).fill("strong"), ...Array(10).fill("possible"), ...Array(5).fill("weak"), ...Array(3).fill("filtered")] as const;
  const ids: string[] = [];
  for (const [i, tier] of tiers.entries()) {
    const [row] = await db
      .insert(schema.outreachProspects)
      .values({
        userId: USER, campaignId, externalId: `li:p${i}`, fullName: `Person ${i}`, rankTier: tier,
        rankScore: 1 - i / 100, rankedCriteriaVersion: 0, email: i % 2 === 0 ? `p${i}@x.com` : null,
      })
      // Bare `.returning()`, not `.returning({ id })` — the same drizzle union-`Db`-type trap
      // noted for `.update(...).returning({ col })` elsewhere in this codebase also applies to
      // `.insert(...).returning({ col })` here; it fails typecheck against `getDb()`'s union
      // return type. See the pre-cleared deviation in the task-16 report.
      .returning();
    ids.push(row.id);
  }

  const page1 = await listPeople(USER, campaignId, { limit: 25 });
  check("filtered people are hidden by default", page1.total === 27);
  check("the first page holds 25, in rank order", page1.rows.length === 25 && page1.rows[0].rankTier === "strong" && page1.nextOffset === 25);
  const page2 = await listPeople(USER, campaignId, { limit: 25, offset: 25 });
  check("the second page holds the rest", page2.rows.length === 2 && page2.nextOffset === null);
  check("counts cover the whole campaign",
    page1.counts.strong === 12 && page1.counts.possible === 10 && page1.counts.weak === 5 && page1.counts.filtered === 3);

  const onPage = await selectPeople(USER, campaignId, { scope: "ids", ids: page1.rows.map((r) => r.id), selected: true });
  check("selecting a page selects exactly that page", onPage.changed === 25);
  await selectPeople(USER, campaignId, { scope: "ids", ids, selected: false });

  await excludePeople(USER, campaignId, [ids[0]], "Already know them");
  const [conversationProspect] = [ids[1]];
  await db.insert(schema.outreachConversations).values({
    userId: USER, campaignId, prospectId: conversationProspect, channel: "email", provider: "gmail", providerThreadId: "t-1",
  });
  const all = await selectPeople(USER, campaignId, {
    scope: "filter", filter: { tiers: ["strong", "possible"] }, exceptIds: [ids[2], ids[3]], selected: true,
  });
  check("all matching = 22 strong+possible − 1 excluded − 1 in conversation − 2 exceptions", all.changed === 18, String(all.changed));
  const selected = await listPeople(USER, campaignId, { filter: { selection: "selected" }, limit: 100 });
  check("the selection is exactly those rows", selected.total === 18 && !selected.rows.some((r) => [ids[0], ids[1], ids[2], ids[3]].includes(r.id)));
  check("filtered people are never swept up", selected.rows.every((r) => r.rankTier !== "filtered"));

  const withEmail = await listPeople(USER, campaignId, { filter: { hasEmail: true }, limit: 100 });
  check("the email filter works", withEmail.rows.every((r) => r.email !== null));

  await restorePeople(USER, campaignId, [ids[0]]);
  check("restore brings an excluded person back", (await listPeople(USER, campaignId, { limit: 100 })).total === 27);

  await db.update(schema.outreachProspects).set({ possibleDuplicateOf: ids[4], duplicateReview: "pending" }).where(eq(schema.outreachProspects.id, ids[5]));
  await resolveDuplicate(USER, ids[5], "merged");
  const [merged] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, ids[5]));
  check("merging a duplicate excludes it with the reason", merged.status === "excluded" && merged.duplicateReview === "merged");

  console.log("Tenancy...");
  const intrusion = await selectPeople(OTHER, campaignId, { scope: "filter", filter: {}, exceptIds: [], selected: true });
  check("another user's selection changes nothing", intrusion.changed === 0);
  check("another user's listing is empty", (await listPeople(OTHER, campaignId, { limit: 100 })).total === 0);
  check("another user cannot exclude", (await excludePeople(OTHER, campaignId, ids, null)).changed === 0);
  const untouched = await db
    .select()
    .from(schema.outreachProspects)
    .where(and(eq(schema.outreachProspects.campaignId, campaignId), eq(schema.outreachProspects.status, "excluded")));
  check("…so exclusions are unchanged", untouched.length === 1);

  const beforeDuplicateGuard = (await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, ids[6])))[0];
  await resolveDuplicate(OTHER, ids[6], "merged");
  const afterDuplicateGuard = (await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, ids[6])))[0];
  check(
    "another user's resolveDuplicate changes nothing",
    afterDuplicateGuard.status === beforeDuplicateGuard.status && afterDuplicateGuard.duplicateReview === beforeDuplicateGuard.duplicateReview
  );

  // researchOnePerson's tenancy check (the prospect lookup, scoped by id + userId) runs BEFORE
  // any provider resolution — so OTHER is rejected as a tenancy failure even without keys. Give
  // OTHER encrypted dummy keys anyway, so the rejection can't be mistaken for a missing-key one.
  await ensureUserSettings(OTHER);
  await db
    .update(schema.userSettings)
    .set({ braveApiKeyEncrypted: encrypt("other-brave-key"), apolloApiKeyEncrypted: encrypt("other-apollo-key") })
    .where(eq(schema.userSettings.userId, OTHER));
  let otherRejected = false;
  try {
    await researchOnePerson(OTHER, ids[6], "personal");
  } catch (err) {
    otherRejected = true;
    check(
      "another user's researchOnePerson is rejected as tenancy, not a missing key",
      String((err as Error).message).includes("isn’t in your campaign"),
      String((err as Error).message)
    );
  }
  check("the call was rejected", otherRejected);

  console.log("researchOnePerson double-claim...");
  // Personal funding needs keys the resolver can decrypt; no network call happens because no
  // job runs in this smoke (allocateResearch only enqueues it).
  await db
    .update(schema.userSettings)
    .set({ braveApiKeyEncrypted: encrypt("fake-brave-key"), apolloApiKeyEncrypted: encrypt("fake-apollo-key") })
    .where(eq(schema.userSettings.userId, USER));
  // Use a prospect outside the selection fixtures' counts so this doesn't disturb them.
  const [raceProspect] = await db
    .insert(schema.outreachProspects)
    .values({ userId: USER, campaignId, externalId: "li:race", fullName: "Race Person", rankTier: "strong", rankScore: 1, rankedCriteriaVersion: 0 })
    // Bare `.returning()` — see the note above.
    .returning();

  const outcomes = await Promise.allSettled([
    researchOnePerson(USER, raceProspect.id, "personal"),
    researchOnePerson(USER, raceProspect.id, "personal"),
  ]);
  const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
  const rejected = outcomes.filter((o) => o.status === "rejected");
  check("exactly one call wins the claim", fulfilled.length === 1, JSON.stringify(outcomes));
  check(
    "the other is rejected as already underway",
    rejected.length === 1 && rejected[0].status === "rejected" && String((rejected[0] as PromiseRejectedResult).reason?.message).includes("already underway")
  );
  const attempts = await db
    .select()
    .from(schema.outreachResearchAttempts)
    .where(and(eq(schema.outreachResearchAttempts.userId, USER), eq(schema.outreachResearchAttempts.prospectId, raceProspect.id)));
  check("exactly one research attempt row was created", attempts.length === 1, String(attempts.length));

  console.log("researchOnePerson hold paths...");
  await db.update(schema.userSettings).set({ compedPlan: "orbit" }).where(eq(schema.userSettings.userId, USER));
  const priorBraveKey = process.env.BRAVE_SEARCH_API_KEY;
  const priorApolloKey = process.env.APOLLO_API_KEY;
  // Orbit funding resolves its search provider from BRAVE_SEARCH_API_KEY and its enrichment
  // provider from APOLLO_API_KEY (both Orbit's own keys, not the user's) — researchOnePerson
  // requires a non-null enrichment provider before it will claim anything, so both need a
  // (dummy) value. No network call happens: no job runs in this smoke.
  process.env.BRAVE_SEARCH_API_KEY = "dummy-brave-key-for-smoke";
  process.env.APOLLO_API_KEY = "dummy-apollo-key-for-smoke";
  try {
    const baseline = await getCreditBalance(USER);

    const [holdSuccessProspect] = await db
      .insert(schema.outreachProspects)
      .values({ userId: USER, campaignId, externalId: "li:hold-success", fullName: "Hold Success", rankTier: "strong", rankScore: 1, rankedCriteriaVersion: 0 })
      // Bare `.returning()` — see the note above.
      .returning();
    const { attemptId } = await researchOnePerson(USER, holdSuccessProspect.id, "orbit");
    check("orbit-funded research returns an attempt id", Boolean(attemptId));
    const heldAttempts = await db
      .select()
      .from(schema.outreachResearchAttempts)
      .where(and(eq(schema.outreachResearchAttempts.userId, USER), eq(schema.outreachResearchAttempts.prospectId, holdSuccessProspect.id)));
    check(
      "exactly one attempt row, held with a hold id",
      heldAttempts.length === 1 && heldAttempts[0].creditState === "held" && heldAttempts[0].holdId !== null,
      JSON.stringify(heldAttempts)
    );
    const [afterHoldProspect] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, holdSuccessProspect.id));
    check("the prospect is queued", afterHoldProspect.researchState === "queued", afterHoldProspect.researchState ?? "null");
    const afterHoldBalance = await getCreditBalance(USER);
    check("held went up by 1", afterHoldBalance.held === baseline.held + 1, `${afterHoldBalance.held} vs ${baseline.held}`);

    // Exhaust this user's credits directly on their research_credit_accounts row (scoped to
    // USER only), rather than reserving in a loop — the account's monthly allowance was already
    // granted above, so using it up (not zeroing the allowance) avoids ensureCreditAccount's
    // mid-period top-up logic silently undoing this.
    const [acct] = await db.select().from(schema.researchCreditAccounts).where(eq(schema.researchCreditAccounts.userId, USER));
    const available = Math.max(0, acct.monthlyAllowance - acct.monthlyUsed - acct.monthlyHeld);
    await db
      .update(schema.researchCreditAccounts)
      .set({ monthlyUsed: acct.monthlyUsed + available })
      .where(eq(schema.researchCreditAccounts.userId, USER));

    const [outOfCreditsProspect] = await db
      .insert(schema.outreachProspects)
      .values({ userId: USER, campaignId, externalId: "li:out-of-credits", fullName: "Out Of Credits", rankTier: "strong", rankScore: 1, rankedCriteriaVersion: 0 })
      // Bare `.returning()` — see the note above.
      .returning();
    check("the fresh prospect starts unresearched", outOfCreditsProspect.researchState === "none", outOfCreditsProspect.researchState ?? "null");
    const heldBefore = (await getCreditBalance(USER)).held;

    let outOfCreditsRejected = false;
    try {
      await researchOnePerson(USER, outOfCreditsProspect.id, "orbit");
    } catch (err) {
      outOfCreditsRejected = true;
      check(
        "rejects with an out-of-credits message",
        String((err as Error).message).includes("out of research credits"),
        String((err as Error).message)
      );
    }
    check("the call was rejected", outOfCreditsRejected);
    const [afterFailProspect] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, outOfCreditsProspect.id));
    check(
      "the prospect's research state is back to its prior value",
      afterFailProspect.researchState === "none",
      afterFailProspect.researchState ?? "null"
    );
    const failedAttempts = await db
      .select()
      .from(schema.outreachResearchAttempts)
      .where(and(eq(schema.outreachResearchAttempts.userId, USER), eq(schema.outreachResearchAttempts.prospectId, outOfCreditsProspect.id)));
    check("no attempt row exists for the rejected prospect", failedAttempts.length === 0, String(failedAttempts.length));
    const heldAfter = (await getCreditBalance(USER)).held;
    check("held is unchanged by the rejected reservation", heldAfter === heldBefore, `${heldAfter} vs ${heldBefore}`);
  } finally {
    if (priorBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = priorBraveKey;
    if (priorApolloKey === undefined) delete process.env.APOLLO_API_KEY;
    else process.env.APOLLO_API_KEY = priorApolloKey;
  }

  // A run's ranking phase picks its pool (research_state 'none') and only then allocates, so a
  // "Research · 1 credit" click in between used to leave the person with two attempts — two
  // provider bills, and on Orbit funding two credits. Both paths now take the same one-UPDATE
  // claim on research_state, so exactly one of them gets the person. Personal funding (USER's
  // keys from above) keeps credits out of it: the attempt count is the whole story, since each
  // attempt charges at most once.
  console.log("Run allocation and a manual research click share one claim...");
  const freshCampaign = async () =>
    (await createCampaignV2(USER, { brief: { purpose: "Meet partnership leads in fintech", desiredOutcome: "Intro calls" }, channel: "email" })).id;
  const person = async (campaign: string, slug: string) =>
    (
      await db
        .insert(schema.outreachProspects)
        .values({ userId: USER, campaignId: campaign, externalId: `li:${slug}`, fullName: slug, rankTier: "strong", rankScore: 1, rankedCriteriaVersion: 0 })
        // Bare `.returning()` — see the note above.
        .returning()
    )[0].id;
  const runFor = async (campaign: string, budget: number) =>
    (
      await db
        .insert(schema.outreachResearchRuns)
        .values({ userId: USER, campaignId: campaign, criteriaVersion: 0, fundingSource: "personal", status: "running", researchBudget: budget })
        .returning()
    )[0];
  const attemptsFor = async (prospectId: string) =>
    db
      .select()
      .from(schema.outreachResearchAttempts)
      .where(and(eq(schema.outreachResearchAttempts.userId, USER), eq(schema.outreachResearchAttempts.prospectId, prospectId)));
  const stateOf = async (prospectId: string) =>
    (await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, prospectId)))[0].researchState;

  // The run chose its pool while both were unresearched; the click lands before allocation.
  const manualFirst = await freshCampaign();
  const clicked = await person(manualFirst, "clicked-first");
  const nextInLine = await person(manualFirst, "left-for-the-run");
  const runA = await runFor(manualFirst, 2);
  await researchOnePerson(USER, clicked, "personal");
  const allocatedA = await allocateRunResearch(USER, { id: runA.id, campaignId: manualFirst, fundingSource: "personal", holdId: null }, [clicked, nextInLine]);
  const clickedAttempts = await attemptsFor(clicked);
  check("run allocation skips someone already claimed by hand", clickedAttempts.length === 1 && clickedAttempts[0].runId === null, JSON.stringify(clickedAttempts.map((a) => a.runId)));
  check("…and spends its slot on the next person instead", allocatedA === 1 && (await attemptsFor(nextInLine)).length === 1, String(allocatedA));
  const [runAAfter] = await db.select().from(schema.outreachResearchRuns).where(eq(schema.outreachResearchRuns.id, runA.id));
  check("…so the run used exactly one slot", runAAfter.researchUsed === 1, String(runAAfter.researchUsed));

  // The run got there first; the click comes after.
  const runFirst = await freshCampaign();
  const allocated = await person(runFirst, "allocated-first");
  const runB = await runFor(runFirst, 1);
  await allocateRunResearch(USER, { id: runB.id, campaignId: runFirst, fundingSource: "personal", holdId: null }, [allocated]);
  let lateClick = "";
  try {
    await researchOnePerson(USER, allocated, "personal");
  } catch (err) {
    lateClick = (err as Error).message;
  }
  check("a click on someone the run already claimed is refused as underway", lateClick.includes("already underway"), lateClick);
  check("…leaving exactly one attempt", (await attemptsFor(allocated)).length === 1);

  // Budget runs out mid-pool: the person claimed for the refused slot goes back, and the loop
  // stops without claiming anyone after them.
  const shortRun = await freshCampaign();
  const [first, second, third] = [await person(shortRun, "fits"), await person(shortRun, "over-budget"), await person(shortRun, "never-reached")];
  const runC = await runFor(shortRun, 1);
  const allocatedC = await allocateRunResearch(USER, { id: runC.id, campaignId: shortRun, fundingSource: "personal", holdId: null }, [first, second, third]);
  check("a one-slot run allocates one person", allocatedC === 1 && (await stateOf(first)) === "queued");
  check("…gives back the claim on the person the budget refused", (await stateOf(second)) === "none" && (await attemptsFor(second)).length === 0);
  check("…and stops there", (await stateOf(third)) === "none" && (await attemptsFor(third)).length === 0);

  // The mirror image of legacy Outreach being closed to generation 2: these functions take a
  // campaign or prospect id straight from the client, and a legacy (generation-1) one must be
  // "not found" — researching one would spend on a person the legacy flow still owns.
  console.log("Generation-2 people functions never touch a legacy campaign’s people...");
  const [legacy] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Spring intros", status: "active" }).returning();
  const [legacyPerson, legacyExcluded] = await db
    .insert(schema.outreachProspects)
    .values([
      { userId: USER, campaignId: legacy.id, externalId: "legacy:lee", fullName: "Lee Legacy", status: "suggested" },
      { userId: USER, campaignId: legacy.id, externalId: "legacy:lou", fullName: "Lou Legacy", status: "excluded" },
    ])
    .returning();
  let legacyResearch = "";
  try {
    await researchOnePerson(USER, legacyPerson.id, "personal");
  } catch (err) {
    legacyResearch = (err as Error).message;
  }
  check("researchOnePerson treats a generation-1 person as not found", legacyResearch.includes("isn’t in your campaign"), legacyResearch);
  check("…claiming nothing and starting nothing", (await stateOf(legacyPerson.id)) === "none" && (await attemptsFor(legacyPerson.id)).length === 0);
  check("selecting them by id changes nothing",
    (await selectPeople(USER, legacy.id, { scope: "ids", ids: [legacyPerson.id], selected: true })).changed === 0);
  check("…nor does selecting all matching", (await selectPeople(USER, legacy.id, { scope: "filter", filter: {}, exceptIds: [], selected: true })).changed === 0);
  check("…nor excluding", (await excludePeople(USER, legacy.id, [legacyPerson.id], "not mine to exclude")).changed === 0);
  check("…nor restoring", (await restorePeople(USER, legacy.id, [legacyExcluded.id])).changed === 0);
  await resolveDuplicate(USER, legacyPerson.id, "merged");
  const [legacyAfter] = await db.select().from(schema.outreachProspects).where(eq(schema.outreachProspects.id, legacyPerson.id));
  check("…nor resolving a duplicate", legacyAfter.status === "suggested" && legacyAfter.duplicateReview === null, JSON.stringify(legacyAfter));
  check("…and listing them shows nobody", (await listPeople(USER, legacy.id, { limit: 100 })).total === 0);

  console.log("All outreach selection checks passed.");
}

run(main);
