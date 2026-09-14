/**
 * Funding (spec §7.2): a run uses the source it was started with and never silently switches.
 * Personal keys are verified before they are stored and stored only encrypted; Orbit funding
 * needs a paid plan and Orbit's key; every provider call is metered into usage_events.
 *
 * Funding is exactly "orbit" or "personal". Anything else is refused by every entry point —
 * the resolver, startDiscoveryRun, researchOnePerson, setFundingPreference — before it can
 * insert a run, spend a daily Orbit search or hold a credit: reading "not personal" as Orbit
 * was unlimited Orbit-keyed searching that was never charged. The daily Orbit-funded search
 * is spent only once the run row exists, so a start that loses the one-active-run race costs
 * nothing. A demo account with no Orbit key gets the demo adapters.
 *
 * Run: npx tsx scripts/smoke-outreach-funding.ts
 */
import "./smoke/_env";

import { and, eq, inArray } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import {
  outreachProspects,
  outreachResearchAttempts,
  outreachResearchRuns,
  rateLimitBuckets,
  usageEvents,
  userSettings,
} from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { createCampaignV2, saveCriteria } from "../src/lib/outreach/campaigns";
import { getCreditBalance } from "../src/lib/outreach/credits/ledger";
import { upsertCandidate } from "../src/lib/outreach/discovery/candidates";
import { cancelDiscoveryRun, startDiscoveryRun } from "../src/lib/outreach/discovery/run";
import {
  clearBraveKey,
  getResearchKeyStatus,
  saveBraveKey,
  setFundingPreference,
  verifySavedApolloKey,
} from "../src/lib/outreach/keys";
import { researchOnePerson } from "../src/lib/outreach/people";
import { resolveResearchProviders, type ProviderResolver } from "../src/lib/outreach/providers/resolve";
import { isProviderError, type FetchLike } from "../src/lib/outreach/providers/types";
import type { OutreachFundingSource } from "../src/lib/outreach/types";
import { RATE_LIMITS } from "../src/lib/rate-limit";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const PAID = "smoke-funding-paid";
const FREE = "smoke-funding-free";
const DEMO = "smoke-funding-demo";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const always = (status: number, body: unknown = { web: { results: [] } }): FetchLike => async () => json(status, body);

/** Neither "orbit" nor "personal" — what a crafted server-action call could send. */
const INVALID = "x" as unknown as OutreachFundingSource;
const REFUSED = "Orbit’s allowance or your own keys";
const ORBIT_BUCKET = `outreach.orbit-search:${PAID}`;

/**
 * A resolver as lenient as the old one ("anything not personal is Orbit"), so the
 * startDiscoveryRun checks prove that function refuses bad funding ITSELF rather than leaning
 * on the real resolver to do it.
 */
const lenient: ProviderResolver = async (_userId, funding) => ({
  funding, keyOwner: "orbit", demo: false,
  search: { name: "brave", async search() { return { results: [], moreAvailable: false }; } },
  enrichment: { name: "apollo", async match() { return null; } },
});

async function message(fn: () => Promise<unknown>) {
  try {
    await fn();
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

async function main() {
  const db = await getDb();
  await ensureUserSettings(PAID);
  await ensureUserSettings(FREE);
  await db.update(userSettings).set({ compedPlan: "orbit" }).where(eq(userSettings.userId, PAID));
  const priorBrave = process.env.BRAVE_SEARCH_API_KEY;
  const priorApollo = process.env.APOLLO_API_KEY;
  const priorDemoAccount = process.env.DEMO_ACCOUNT_USER_ID;
  const bucketCount = async () =>
    (await db.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, ORBIT_BUCKET)))[0]?.count ?? 0;
  const confirmedCampaign = async () => {
    const { id } = await createCampaignV2(PAID, {
      brief: { purpose: "Meet partnership leads in fintech", desiredOutcome: "Intro calls" }, channel: "email",
    });
    await saveCriteria(PAID, id, { required: [{ kind: "role", label: "Partnerships", values: ["Partnerships"] }], preferred: [], exclusions: [] });
    return id;
  };
  try {
    console.log("Personal keys...");
    check("personal funding without a key says so",
      (await message(() => resolveResearchProviders(PAID, "personal"))).includes("Brave Search key"));
    check("a rejected key is refused",
      (await message(() => saveBraveKey(PAID, "brv_rejected_key_000", { fetch: always(403) }))).includes("didn’t accept"));
    check("…and nothing was stored", !(await getResearchKeyStatus(PAID)).brave.saved);
    const saved = await saveBraveKey(PAID, "brv_good_key_1234567", { fetch: always(200) });
    check("a working key is saved as verified", saved.status === "valid" && Boolean((await getResearchKeyStatus(PAID)).brave.verifiedAt));
    const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, PAID));
    check("the key is stored encrypted", Boolean(row.braveApiKeyEncrypted) && !row.braveApiKeyEncrypted!.includes("brv_good_key"));
    const unverified = await saveBraveKey(PAID, "brv_flaky_key_1234567", { fetch: always(503) });
    check("an unreachable provider saves the key unverified", unverified.status === "unverified" && !(await getResearchKeyStatus(PAID)).brave.verifiedAt);

    const personal = await resolveResearchProviders(PAID, "personal", { fetch: always(200) });
    check("personal funding uses the user's Brave key", personal.keyOwner === "user" && personal.search.name === "brave");
    check("without a personal Apollo key there is no enrichment", personal.enrichment === null);
    await db.update(userSettings).set({ apolloApiKeyEncrypted: encrypt("ap_personal") }).where(eq(userSettings.userId, PAID));
    check("with one there is", (await resolveResearchProviders(PAID, "personal", { fetch: always(200) })).enrichment?.name === "apollo");
    check("the saved Apollo key verifies", (await verifySavedApolloKey(PAID, { fetch: always(200, { is_logged_in: true }) })) === "valid");

    const rejecting = await resolveResearchProviders(PAID, "personal", { fetch: always(401) });
    let kind = "";
    try {
      await rejecting.search.search("q", { count: 20, offset: 0 });
    } catch (err) {
      kind = isProviderError(err) ? err.kind : "other";
    }
    check("a personal key that stops working surfaces as auth — it does not fall back", kind === "auth");

    console.log("Orbit funding...");
    delete process.env.BRAVE_SEARCH_API_KEY;
    check("Orbit funding without Orbit's key refuses outside demo mode",
      (await message(() => resolveResearchProviders(PAID, "orbit"))).includes("isn’t available right now"));
    process.env.BRAVE_SEARCH_API_KEY = "brv_orbit";
    process.env.APOLLO_API_KEY = "ap_orbit";
    check("the free plan cannot use Orbit funding",
      (await message(() => resolveResearchProviders(FREE, "orbit"))).includes("Orbit Pro"));
    const orbit = await resolveResearchProviders(PAID, "orbit", { fetch: always(200) });
    check("Orbit funding uses Orbit's keys", orbit.keyOwner === "orbit" && orbit.enrichment?.name === "apollo" && !orbit.demo);

    console.log("Metering...");
    await orbit.search.search("site:linkedin.com/in cfo", { count: 20, offset: 0 });
    // Scoped to keyOwner "orbit": an earlier check ("a personal key that stops working")
    // already put its own (keyOwner "user") row into usage_events for this same user and
    // provider, so an unscoped query here would race that stray row instead of waiting for
    // this call's fire-and-forget write to land.
    let metered: Array<typeof usageEvents.$inferSelect> = [];
    for (let i = 0; i < 40 && metered.length === 0; i++) {
      metered = await db
        .select()
        .from(usageEvents)
        .where(and(eq(usageEvents.userId, PAID), eq(usageEvents.provider, "brave"), eq(usageEvents.keyOwner, "orbit")));
      if (!metered.length) await new Promise((r) => setTimeout(r, 50));
    }
    check("a Brave call is metered", metered.length === 1, String(metered.length));
    check("…with its cost and payer", metered[0].kind === "search" && metered[0].keyOwner === "orbit" && (metered[0].estimatedCostMicros ?? 0) > 0);

    await clearBraveKey(PAID);
    check("clearing removes the key", !(await getResearchKeyStatus(PAID)).brave.saved);

    // Orbit's own keys are still set here, and PAID is on a comped Orbit plan — so before the
    // fix every one of these calls went through as Orbit-funded, unmetered and uncharged.
    console.log("Funding is exactly orbit or personal...");
    check("the resolver refuses anything else",
      (await message(() => resolveResearchProviders(PAID, INVALID))).includes(REFUSED));

    const campaignId = await confirmedCampaign();
    const bucketBefore = await bucketCount();
    const heldBefore = (await getCreditBalance(PAID)).held;
    check("startDiscoveryRun refuses it, even behind a lenient resolver",
      (await message(() => startDiscoveryRun(PAID, { campaignId, funding: INVALID, researchBudget: 5 }, { resolveProviders: lenient }))).includes(REFUSED));
    const refusedRuns = await db
      .select()
      .from(outreachResearchRuns)
      .where(and(eq(outreachResearchRuns.userId, PAID), eq(outreachResearchRuns.campaignId, campaignId)));
    check("…no run was inserted", refusedRuns.length === 0, String(refusedRuns.length));
    check("…no daily Orbit search was spent", (await bucketCount()) === bucketBefore);
    check("…and no credits were held", (await getCreditBalance(PAID)).held === heldBefore);

    const { prospectId } = await upsertCandidate(PAID, campaignId, {
      fullName: "Jane Doe", linkedinUrl: "https://www.linkedin.com/in/funding-jane", origin: "discovered",
      evidence: [{ kind: "search_result", provider: "brave", url: "https://www.linkedin.com/in/funding-jane", title: "Jane Doe - Partnerships", snippet: "x" }],
    });
    check("researchOnePerson refuses it",
      (await message(() => researchOnePerson(PAID, prospectId, INVALID))).includes(REFUSED));
    const refusedAttempts = await db
      .select()
      .from(outreachResearchAttempts)
      .where(and(eq(outreachResearchAttempts.userId, PAID), eq(outreachResearchAttempts.prospectId, prospectId)));
    check("…no attempt was created", refusedAttempts.length === 0, String(refusedAttempts.length));
    const [unclaimed] = await db.select().from(outreachProspects).where(eq(outreachProspects.id, prospectId));
    check("…the person was never claimed", unclaimed.researchState === "none", unclaimed.researchState);
    check("…and no credits were held", (await getCreditBalance(PAID)).held === heldBefore);

    await setFundingPreference(PAID, "personal");
    check("setFundingPreference refuses it",
      (await message(() => setFundingPreference(PAID, INVALID))).includes(REFUSED));
    check("…and keeps the stored preference", (await getResearchKeyStatus(PAID)).fundingPreference === "personal");

    console.log("The daily Orbit search is spent only by a start that got its run row...");
    // A competing start lands its own active run between this call's friendly pre-check and
    // its INSERT — the window only the structural one-active-run index closes.
    const raceCampaign = await confirmedCampaign();
    const racing: ProviderResolver = async (userId, funding) => {
      await db.insert(outreachResearchRuns).values({
        userId: PAID, campaignId: raceCampaign, criteriaVersion: 1, status: "queued", fundingSource: "orbit",
      });
      return lenient(userId, funding);
    };
    const beforeRace = await bucketCount();
    check("a start that loses the one-active-run race is refused",
      (await message(() => startDiscoveryRun(PAID, { campaignId: raceCampaign, funding: "orbit", researchBudget: 0 }, { resolveProviders: racing }))).includes("already running"));
    check("…without spending a daily Orbit search", (await bucketCount()) === beforeRace, `${await bucketCount()} vs ${beforeRace}`);
    const [winner] = await db
      .select()
      .from(outreachResearchRuns)
      .where(and(eq(outreachResearchRuns.userId, PAID), eq(outreachResearchRuns.campaignId, raceCampaign)));
    await cancelDiscoveryRun(PAID, winner.id);

    // Today's allowance used up: the start inserts its run, the bucket refuses, and the cleanup
    // cancels that run (releasing nothing, since no hold was taken yet) before the refusal
    // reaches the caller.
    await db
      .insert(rateLimitBuckets)
      .values({ bucket: ORBIT_BUCKET, windowStartedAt: new Date(), count: RATE_LIMITS.outreachOrbitSearch.limit })
      .onConflictDoUpdate({
        target: rateLimitBuckets.bucket,
        set: { windowStartedAt: new Date(), count: RATE_LIMITS.outreachOrbitSearch.limit },
      });
    const cappedCampaign = await confirmedCampaign();
    check("a start past today’s Orbit-funded searches is refused",
      (await message(() => startDiscoveryRun(PAID, { campaignId: cappedCampaign, funding: "orbit", researchBudget: 5 }, { resolveProviders: lenient }))).includes("today’s Orbit-funded searches"));
    const cappedActive = await db
      .select()
      .from(outreachResearchRuns)
      .where(
        and(
          eq(outreachResearchRuns.userId, PAID),
          eq(outreachResearchRuns.campaignId, cappedCampaign),
          inArray(outreachResearchRuns.status, ["queued", "running"])
        )
      );
    check("…leaving no active run behind", cappedActive.length === 0, String(cappedActive.length));
    check("…and no credits held", (await getCreditBalance(PAID)).held === heldBefore);

    console.log("Demo accounts...");
    delete process.env.BRAVE_SEARCH_API_KEY;
    process.env.DEMO_ACCOUNT_USER_ID = DEMO;
    await ensureUserSettings(DEMO);
    const demo = await resolveResearchProviders(DEMO, "orbit");
    check("a demo account with no Orbit key gets the demo adapters",
      demo.demo && demo.keyOwner === "orbit" && demo.search.name === "demo" && demo.enrichment?.name === "demo");
    check("…while an ordinary account is still refused",
      (await message(() => resolveResearchProviders(PAID, "orbit"))).includes("isn’t available right now"));
  } finally {
    if (priorBrave === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = priorBrave;
    if (priorApollo === undefined) delete process.env.APOLLO_API_KEY;
    else process.env.APOLLO_API_KEY = priorApollo;
    if (priorDemoAccount === undefined) delete process.env.DEMO_ACCOUNT_USER_ID;
    else process.env.DEMO_ACCOUNT_USER_ID = priorDemoAccount;
  }
  console.log("All outreach funding checks passed.");
}

run(main);
