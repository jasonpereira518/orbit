/**
 * Orbit's hosted Apollo key is capped per user per day; a user's own key is not.
 * Run: npx tsx scripts/smoke-apollo-hosted-budget.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { rateLimitBuckets, userSettings } from "../src/db/schema";
import { APOLLO_DAILY_LIMIT_MESSAGE, searchPeople } from "../src/lib/apollo";
import { encrypt } from "../src/lib/crypto";
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
    return Response.json({ people: [], pagination: { total_entries: 0 } });
  }
  return realFetch(input, init);
}) as typeof fetch;

run(async () => {
  const db = await getDb();
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "apollo.%"));
  for (const userId of [HOSTED, OWN]) {
    await db.delete(userSettings).where(eq(userSettings.userId, userId));
    await ensureUserSettings(userId);
  }
  // Pro via a comp grants hosted enrichment; OWN also has its own key.
  await db.update(userSettings).set({ compedPlan: "orbit" }).where(eq(userSettings.userId, HOSTED));
  await db.update(userSettings).set({ compedPlan: "orbit", apolloApiKeyEncrypted: encrypt("own-key") }).where(eq(userSettings.userId, OWN));

  const limit = RATE_LIMITS.apolloSearch.limit;
  for (let i = 0; i < limit; i++) await searchPeople(HOSTED, {});
  let thrown: unknown = null;
  try {
    await searchPeople(HOSTED, {});
  } catch (err) {
    thrown = err;
  }
  check(`the hosted key allows ${limit} searches a day`, apolloCalls === limit, String(apolloCalls));
  check("the next one is refused with the cap copy", thrown instanceof Error && thrown.message === APOLLO_DAILY_LIMIT_MESSAGE, String(thrown));
  check("…and never reaches Apollo", apolloCalls === limit);

  apolloCalls = 0;
  for (let i = 0; i < limit + 2; i++) await searchPeople(OWN, {});
  check("a user's own key is never capped", apolloCalls === limit + 2, String(apolloCalls));

  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "apollo.%"));
  for (const userId of [HOSTED, OWN]) await db.delete(userSettings).where(eq(userSettings.userId, userId));
  globalThis.fetch = realFetch;
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll hosted Apollo budget checks passed.");
});
