/**
 * Pins the database-backed rate limiter in `src/lib/rate-limit.ts`.
 *
 * Nothing but the extension API was rate limited: a signed-up user could drive unbounded
 * chat and capture calls through server actions, and the avatar route would resolve
 * LinkedIn photos as fast as a page could ask. The limiter is a fixed window per
 * (scope, key) kept in Postgres, because a serverless instance's memory is neither shared
 * nor durable. One statement per check — the same upsert-with-CASE shape the extension
 * budget already used.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-rate-limit.ts
 */
import "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { ipBucketKey } from "../src/lib/client-ip";
import { RATE_LIMITS, RateLimitedError, bucketCount, consumeBucket, pruneRateLimitBuckets } from "../src/lib/rate-limit";
import { forgetManagedAiPause } from "../src/lib/ai-access";
import { usageRow } from "../src/lib/usage-events";
import { usageEvents } from "../src/db/schema";
import { getWebSearchSwitchState } from "../src/lib/managed-ai-switch";
import { estimateCostMicros } from "../src/lib/ai-pricing";
import { utcDayKey } from "../src/lib/timeline-cost";
import {
  WEB_SEARCH_ALL_SCOPE,
  WEB_SEARCH_DAILY_CEILING,
  WEB_SEARCH_SCOPE,
  anthropicSearchCount,
  reserveWebSearch,
  resumeMaxUses,
  secondsToNextMonth,
  settleWebSearch,
  webSearchMonthKey,
} from "../src/lib/web-search-budget";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const KEY = `smoke-rate-limit-${Date.now()}`;

async function main() {
  console.log("Fixed window...");
  for (let i = 1; i <= 3; i++) {
    const r = await consumeBucket("smoke.chat", KEY, { limit: 3, windowSec: 60 });
    check(`call ${i} of 3 is allowed (remaining ${r.remaining})`, r.remaining === 3 - i);
  }
  let blocked: RateLimitedError | null = null;
  try {
    await consumeBucket("smoke.chat", KEY, { limit: 3, windowSec: 60 });
  } catch (err) {
    if (err instanceof RateLimitedError) blocked = err;
    else throw err;
  }
  check("the 4th call is rejected with RateLimitedError", blocked !== null);
  check("retryAfter is a positive number of seconds within the window", (blocked?.retryAfterSec ?? 0) >= 1 && (blocked?.retryAfterSec ?? 999) <= 60, String(blocked?.retryAfterSec));
  check("the error carries a user-facing message", /moment|try again|too many/i.test(blocked?.message ?? ""), blocked?.message);

  console.log("\nIsolation...");
  const other = await consumeBucket("smoke.capture", KEY, { limit: 3, windowSec: 60 });
  check("a different scope has its own budget", other.remaining === 2);
  const otherKey = await consumeBucket("smoke.chat", `${KEY}-b`, { limit: 3, windowSec: 60 });
  check("a different key has its own budget", otherKey.remaining === 2);

  console.log("\nWindow expiry...");
  await consumeBucket("smoke.expiry", KEY, { limit: 1, windowSec: 1 });
  let stillBlocked = false;
  try {
    await consumeBucket("smoke.expiry", KEY, { limit: 1, windowSec: 1 });
  } catch (err) {
    stillBlocked = err instanceof RateLimitedError;
  }
  check("a second call inside the window is rejected", stillBlocked);
  await new Promise((r) => setTimeout(r, 1200));
  const after = await consumeBucket("smoke.expiry", KEY, { limit: 1, windowSec: 1 });
  check("after the window the budget resets", after.remaining === 0);

  console.log("Addresses are never stored...");
  const ip = "203.0.113.7";
  const ipKey = ipBucketKey(ip);
  check("an IP key does not contain the address", !ipKey.includes(ip) && !ipKey.includes("203.0.113"));
  check("the same IP lands in the same bucket", ipKey === ipBucketKey(ip));
  check("another IP lands in another", ipKey !== ipBucketKey("203.0.113.8"));
  await consumeBucket("smoke.ip", ipKey, { limit: 5, windowSec: 60 });
  const db = await getDb();
  const stored = rowsOf<{ bucket: string }>(await db.execute(sql`SELECT bucket FROM rate_limit_buckets WHERE bucket LIKE 'smoke.ip:%'`));
  check("the stored bucket name holds no address", stored.length > 0 && stored.every((r) => !r.bucket.includes(ip)));

  console.log("Expired buckets are pruned...");
  await db.execute(sql`INSERT INTO rate_limit_buckets (bucket, window_started_at, count) VALUES (${`smoke.old:${KEY}`}, now() - interval '63 days', 1)`);
  await consumeBucket("smoke.fresh", KEY, { limit: 5, windowSec: 60 });
  await pruneRateLimitBuckets();
  const left = rowsOf<{ bucket: string }>(await db.execute(sql`SELECT bucket FROM rate_limit_buckets WHERE bucket IN (${`smoke.old:${KEY}`}, ${`smoke.fresh:${KEY}`})`)).map((r) => r.bucket);
  check("a bucket past the retention (62 days) is deleted", !left.includes(`smoke.old:${KEY}`));
  check("a live bucket is kept", left.includes(`smoke.fresh:${KEY}`));

  console.log("Web-search budget...");
  check("the daily ceiling is half the $190 pool over a 31-day month", WEB_SEARCH_DAILY_CEILING === 306 && RATE_LIMITS.webSearchDaily.limit === WEB_SEARCH_DAILY_CEILING);
  const refusal = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (err) {
      return err instanceof RateLimitedError ? err : null;
    }
  };
  const user = `smoke-wsb-${Date.now()}`;
  const monthKey = webSearchMonthKey(user, new Date());
  const monthly = RATE_LIMITS.webSearchMonthly;
  check("a fresh account may search", (await refusal(() => reserveWebSearch(user))) === null);
  await settleWebSearch(user, 3);
  check("a call is charged its real count (1 held + 2 settled)", (await bucketCount(WEB_SEARCH_SCOPE, monthKey, monthly)) === 3);
  await settleWebSearch(user, 0);
  check("…and a call that searched once or not at all adds nothing more", (await bucketCount(WEB_SEARCH_SCOPE, monthKey, monthly)) === 3);
  await consumeBucket(WEB_SEARCH_SCOPE, monthKey, monthly, monthly.limit - 3);
  const spent = await refusal(() => reserveWebSearch(user));
  const wait = secondsToNextMonth(new Date());
  check(
    "a spent month refuses, and says to wait until the 1st",
    spent?.scope === WEB_SEARCH_SCOPE && Math.abs(spent.retryAfterSec - wait) < 5,
    spent ? `${spent.retryAfterSec} vs ${wait}: ${spent.message}` : "not refused"
  );
  check("…in days, not thousands of minutes", wait < 2 * 86_400 || /\d+ days?\./.test(spent?.message ?? ""), spent?.message);
  check("settling past the ceiling never throws", (await settleWebSearch(user, 5).then(() => true, () => false)) === true);
  check("the month key rolls over at month end", webSearchMonthKey(user, new Date("2026-10-31T23:59:00Z")) !== webSearchMonthKey(user, new Date("2026-11-01T00:00:00Z")));
  check("…and the wait is exact at the edge", secondsToNextMonth(new Date("2026-10-31T23:59:00Z")) === 60);

  const otherUser = `smoke-wsb-other-${Date.now()}`;
  const dayKey = utcDayKey(new Date());
  const dayCount = await bucketCount(WEB_SEARCH_ALL_SCOPE, dayKey, RATE_LIMITS.webSearchDaily);
  await consumeBucket(WEB_SEARCH_ALL_SCOPE, dayKey, RATE_LIMITS.webSearchDaily, RATE_LIMITS.webSearchDaily.limit - dayCount);
  const orbitWide = await refusal(() => reserveWebSearch(otherUser));
  check("Orbit's daily ceiling refuses every account", orbitWide?.scope === WEB_SEARCH_ALL_SCOPE, orbitWide?.message ?? "not refused");
  await db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket = ${`${WEB_SEARCH_ALL_SCOPE}:${dayKey}`}`);

  await db.execute(sql`INSERT INTO site_settings (id, web_search_paused) VALUES (1, true) ON CONFLICT (id) DO UPDATE SET web_search_paused = true`);
  forgetManagedAiPause();
  const paused = await refusal(() => reserveWebSearch(`smoke-wsb-paused-${Date.now()}`));
  check("the admin switch refuses before any bucket", paused?.scope === WEB_SEARCH_ALL_SCOPE, paused?.message ?? "not refused");
  await db.execute(sql`UPDATE site_settings SET web_search_paused = NULL WHERE id = 1`);
  forgetManagedAiPause();
  check("…and switching it back lets searches run", (await refusal(() => reserveWebSearch(`smoke-wsb-back-${Date.now()}`))) === null);

  check("a pause_turn resume gets what is left of the budget", resumeMaxUses(2, 0) === 2 && resumeMaxUses(2, 1) === 1);
  check("…never 0, which the API rejects", resumeMaxUses(2, 2) === 1 && resumeMaxUses(2, 5) === 1);
  check(
    "Anthropic's search count is read off usage.server_tool_use",
    anthropicSearchCount({ usage: { server_tool_use: { web_search_requests: 3 } } }) === 3 &&
      anthropicSearchCount({ usage: {} }) === 0 &&
      anthropicSearchCount(null) === 0
  );
  const base = { userId: user, operation: "contact.work_history", provider: "anthropic" as const, model: "claude-haiku-5-5", kind: "completion" as const, keyOwner: "user" as const, success: true, inputTokens: 1000, outputTokens: 100 };
  const tokensOnly = estimateCostMicros({ model: base.model, inputTokens: 1000, outputTokens: 100 })!;
  check("two Anthropic searches' surcharge adds $0.02 to the row's cost", usageRow({ ...base, webSearches: 2, surchargeMicros: 20_000 }).estimatedCostMicros === tokensOnly + 20_000);
  check("…and the row keeps the count itself", usageRow({ ...base, webSearches: 2 }).webSearches === 2 && usageRow(base).webSearches === null);
  const opKey = `smoke.op.${Date.now()}`;
  await db.insert(usageEvents).values([
    { ...usageRow({ ...base, operation: opKey, webSearches: 2 }) },
    { ...usageRow({ ...base, operation: opKey, webSearches: 1 }) },
    { ...usageRow({ ...base, operation: opKey, webSearches: 3, success: false }) },
    { ...usageRow({ ...base, operation: opKey }) },
  ]);
  const breakdown = (await getWebSearchSwitchState()).byOperation.find((r) => r.operation === opKey);
  check(
    "the admin breakdown counts searches per feature, and searches per completed call",
    breakdown?.searches30 === 6 && breakdown.searches7 === 6 && breakdown.calls30 === 3 && breakdown.perSuccess === 3,
    JSON.stringify(breakdown)
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll rate-limit checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
