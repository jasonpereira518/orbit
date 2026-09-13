/**
 * Funding (spec §7.2): a run uses the source it was started with and never silently switches.
 * Personal keys are verified before they are stored and stored only encrypted; Orbit funding
 * needs a paid plan and Orbit's key; every provider call is metered into usage_events.
 *
 * Run: npx tsx scripts/smoke-outreach-funding.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import { usageEvents, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { clearBraveKey, getResearchKeyStatus, saveBraveKey, verifySavedApolloKey } from "../src/lib/outreach/keys";
import { resolveResearchProviders } from "../src/lib/outreach/providers/resolve";
import { isProviderError, type FetchLike } from "../src/lib/outreach/providers/types";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const PAID = "smoke-funding-paid";
const FREE = "smoke-funding-free";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const always = (status: number, body: unknown = { web: { results: [] } }): FetchLike => async () => json(status, body);

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
  } finally {
    if (priorBrave === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = priorBrave;
    if (priorApollo === undefined) delete process.env.APOLLO_API_KEY;
    else process.env.APOLLO_API_KEY = priorApollo;
  }
  console.log("All outreach funding checks passed.");
}

run(main);
