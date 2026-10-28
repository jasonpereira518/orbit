/**
 * No plan includes Orbit's hosted Apollo key (a user's own key is the only way in), and the
 * monthly and daily caps on hosted enrichment still hold for whenever a plan turns it on; a
 * user's own key is never capped.
 * Run: npx tsx scripts/smoke-apollo-hosted-budget.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { planMeterUsage, rateLimitBuckets, userSettings } from "../src/db/schema";
import { APOLLO_DAILY_LIMIT_MESSAGE, enrichPerson } from "../src/lib/apollo";
import { encrypt } from "../src/lib/crypto";
import { UserFacingError } from "../src/lib/errors";
import { PLAN_CONFIG, PLANS } from "../src/lib/plans/plan-config";
import { RATE_LIMITS } from "../src/lib/rate-limit";
import { ensureUserSettings } from "../src/lib/user-settings";

process.env.APOLLO_API_KEY = "hosted-apollo-key";
const HOSTED = "smoke-apollo-hosted";
const OWN = "smoke-apollo-own-key";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const realFetch = globalThis.fetch;
let apolloCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://api.apollo.io/")) {
    apolloCalls++;
    return Response.json({ person: null });
  }
  return realFetch(input, init);
}) as typeof fetch;

run(async () => {
  const db = await getDb();
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "apollo.%"));
  await db.delete(planMeterUsage).where(eq(planMeterUsage.userId, HOSTED));
  for (const userId of [HOSTED, OWN]) {
    await db.delete(userSettings).where(eq(userSettings.userId, userId));
    await ensureUserSettings(userId);
  }
  // Pro via a comp; OWN also has its own key.
  await db.update(userSettings).set({ compedPlan: "orbit" }).where(eq(userSettings.userId, HOSTED));
  await db.update(userSettings).set({ compedPlan: "orbit", apolloApiKeyEncrypted: encrypt("own-key") }).where(eq(userSettings.userId, OWN));

  // Orbit's key is set in the environment, and still no plan reaches it.
  for (const plan of PLANS) {
    check(`${plan}: hosted enrichment is off in the plan table`, PLAN_CONFIG[plan].features.hostedEnrichment === false && PLAN_CONFIG[plan].hostedEnrichmentsPerMonth === 0);
    await db.update(userSettings).set({ compedPlan: plan === "free" ? null : plan }).where(eq(userSettings.userId, HOSTED));
    const enriched = await enrichPerson(HOSTED, "person-1", { email: "a@example.test" });
    check(`${plan}: no key means no enrichment, and Apollo is never called`, enriched === null && apolloCalls === 0, String(apolloCalls));
  }
  await db.update(userSettings).set({ compedPlan: "orbit" }).where(eq(userSettings.userId, HOSTED));

  // The caps on the hosted path stay correct for a future plan that turns the flag back on.
  // The flag and the monthly allowance are changed in-process only and restored in `finally`.
  const plan = PLAN_CONFIG.orbit;
  const limit = RATE_LIMITS.apolloEnrich.limit;
  const enrich = () => enrichPerson(HOSTED, "person-1", { email: "a@example.test" });
  let monthlyThrown: unknown = null;
  let dailyThrown: unknown = null;
  plan.features.hostedEnrichment = true;
  try {
    try {
      await enrich();
    } catch (err) {
      monthlyThrown = err;
    }
    plan.hostedEnrichmentsPerMonth = limit + 10;
    for (let i = 0; i < limit; i++) await enrich();
    try {
      await enrich();
    } catch (err) {
      dailyThrown = err;
    }
  } finally {
    plan.features.hostedEnrichment = false;
    plan.hostedEnrichmentsPerMonth = 0;
  }
  check("a plan with 0 monthly enrichments is refused", monthlyThrown instanceof UserFacingError, String(monthlyThrown));
  check(`a hosted key would allow ${limit} enrichments a day`, apolloCalls === limit, String(apolloCalls));
  check("the next one is refused with the daily cap copy", dailyThrown instanceof Error && dailyThrown.message === APOLLO_DAILY_LIMIT_MESSAGE, String(dailyThrown));

  apolloCalls = 0;
  for (let i = 0; i < limit + 2; i++) await enrichPerson(OWN, "person-1", { email: "a@example.test" });
  check("a user's own key is never capped", apolloCalls === limit + 2, String(apolloCalls));

  await db.delete(planMeterUsage).where(eq(planMeterUsage.userId, HOSTED));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "apollo.%"));
  for (const userId of [HOSTED, OWN]) await db.delete(userSettings).where(eq(userSettings.userId, userId));
  globalThis.fetch = realFetch;
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll hosted Apollo budget checks passed.");
});
