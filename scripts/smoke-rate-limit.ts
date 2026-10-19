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

import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { ipBucketKey } from "../src/lib/client-ip";
import { RateLimitedError, consumeBucket, pruneRateLimitBuckets } from "../src/lib/rate-limit";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    const text = detail === undefined || detail === null ? "" : typeof detail === "string" ? detail : JSON.stringify(detail);
    console.error(`  FAIL ${label}${text ? `\n       ${text}` : ""}`);
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
  await db.execute(sql`INSERT INTO rate_limit_buckets (bucket, window_started_at, count) VALUES (${`smoke.old:${KEY}`}, now() - interval '3 days', 1)`);
  await consumeBucket("smoke.fresh", KEY, { limit: 5, windowSec: 60 });
  await pruneRateLimitBuckets();
  const left = rowsOf<{ bucket: string }>(await db.execute(sql`SELECT bucket FROM rate_limit_buckets WHERE bucket IN (${`smoke.old:${KEY}`}, ${`smoke.fresh:${KEY}`})`)).map((r) => r.bucket);
  check("a bucket past two days is deleted", !left.includes(`smoke.old:${KEY}`));
  check("a live bucket is kept", left.includes(`smoke.fresh:${KEY}`));

  console.log("\nThe prune is served by an index (schema 176)...");
  const idx = rowsOf<{ indexname: string }>(await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'rate_limit_buckets'`)).map((r) => r.indexname);
  check("rate_limit_buckets_window_started_idx exists", idx.includes("rate_limit_buckets_window_started_idx"), idx.join(", "));

  await newLimits();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll rate-limit checks passed.");
  process.exit(0);
}

/**
 * The post-launch buckets and caps (audit M-07, L-22, M-18) and the `ORBIT_NEW_LIMITS=log`
 * switch that softens exactly those, and nothing older.
 */
async function newLimits() {
  const { CapReachedError, MAX_ACTIVE_API_KEYS, NEW_LIMIT_SCOPES, RATE_LIMITS, consumeDailyCap, newLimitsLogOnly } = await import("../src/lib/rate-limit");
  const { UserFacingError, friendlyError, asActionResult } = await import("../src/lib/errors");
  const db = await getDb();

  console.log("\nThe new budgets...");
  const expect: Record<string, [number, number]> = {
    draft: [30, 600],
    brief: [20, 600],
    compose: [20, 600],
    prep: [20, 600],
    duplicateHints: [30, 600],
    dictationToken: [12, 300],
    chatThreadDaily: [200, 86_400],
    reminderDaily: [500, 86_400],
    importDaily: [50, 86_400],
  };
  for (const [scope, [limit, windowSec]] of Object.entries(expect)) {
    const policy = (RATE_LIMITS as Record<string, { limit: number; windowSec: number }>)[scope];
    check(`${scope} is ${limit} per ${windowSec}s`, policy?.limit === limit && policy?.windowSec === windowSec, policy);
    check(`…and is one the switch softens`, NEW_LIMIT_SCOPES.has(scope));
  }
  check("API keys: 10 active per account", MAX_ACTIVE_API_KEYS === 10);
  check("the speech mint is tighter than the shared token bucket",
    RATE_LIMITS.dictationToken.limit / RATE_LIMITS.dictationToken.windowSec < RATE_LIMITS.speechToken.limit / RATE_LIMITS.speechToken.windowSec);
  for (const old of ["chat", "capture", "emailSend", "speechToken", "mcp", "apiWrite", "export"]) {
    check(`the switch never softens the older "${old}" bucket`, !NEW_LIMIT_SCOPES.has(old));
  }
  check("the longest window is still within the prune's retention", Object.values(RATE_LIMITS).every((p) => p.windowSec * 1000 <= 2 * 86_400_000));

  console.log("\nEnforced by default...");
  delete process.env.ORBIT_NEW_LIMITS;
  check("no switch → enforce", newLimitsLogOnly() === false);
  check("ORBIT_NEW_LIMITS=log → log only", newLimitsLogOnly({ ORBIT_NEW_LIMITS: "log" } as unknown as unknown as NodeJS.ProcessEnv) === true);
  check("any other value → enforce", newLimitsLogOnly({ ORBIT_NEW_LIMITS: "off" } as unknown as unknown as NodeJS.ProcessEnv) === false);
  const user = `smoke-new-limits-${Date.now()}`;
  for (let i = 0; i < RATE_LIMITS.draft.limit; i++) await consumeBucket("draft", user, RATE_LIMITS.draft);
  let refused: unknown = null;
  try {
    await consumeBucket("draft", user, RATE_LIMITS.draft);
  } catch (err) {
    refused = err;
  }
  check("the 31st draft in ten minutes is refused", refused instanceof RateLimitedError, String(refused));
  check("…in words a person can act on", /AI draft limit/.test((refused as Error)?.message ?? ""), (refused as Error)?.message);
  check("friendlyError shows a rate limit's own words", friendlyError(refused, "Couldn’t draft that") === (refused as Error).message);
  const asResult = await asActionResult(async () => {
    throw refused;
  });
  check("asActionResult returns it as data instead of a digest", !asResult.ok && /AI draft limit/.test(asResult.error));

  console.log("\nORBIT_NEW_LIMITS=log softens only the new ones...");
  process.env.ORBIT_NEW_LIMITS = "log";
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warned.push(args.map(String).join(" "));
  };
  try {
    const softened = await consumeBucket("draft", user, RATE_LIMITS.draft);
    check("a draft past the limit is let through", softened.remaining === 0);
    check("…and logged with its scope and count", warned.some((w) => /ORBIT_NEW_LIMITS=log allowed scope=draft/.test(w) && /count=32/.test(w)), warned);
    const counted = rowsOf<{ count: number }>(await db.execute(sql`SELECT count FROM rate_limit_buckets WHERE bucket = ${`draft:${user}`}`));
    check("…while the bucket keeps counting", Number(counted[0]?.count) === 32, counted);
    for (let i = 0; i < 3; i++) await consumeBucket("smoke.oldscope", user, { limit: 2, windowSec: 60 }).catch(() => null);
    let oldRefused = false;
    try {
      await consumeBucket("chat", user, { limit: 0, windowSec: 60 });
    } catch (err) {
      oldRefused = err instanceof RateLimitedError;
    }
    check("an older bucket is still enforced under the switch", oldRefused);
  } finally {
    console.warn = warn;
    delete process.env.ORBIT_NEW_LIMITS;
  }

  console.log("\nDaily caps are user-facing...");
  const capUser = `smoke-cap-${Date.now()}`;
  await db.execute(sql`INSERT INTO rate_limit_buckets (bucket, window_started_at, count) VALUES (${`importDaily:${capUser}`}, now(), ${RATE_LIMITS.importDaily.limit})`);
  let cap: unknown = null;
  try {
    await consumeDailyCap("importDaily", capUser);
  } catch (err) {
    cap = err;
  }
  check("the 51st import of the day is refused with CapReachedError", cap instanceof CapReachedError, String(cap));
  check("…which is a UserFacingError, so actions show it", cap instanceof UserFacingError);
  check("…that says what and when", /daily import limit \(50\)/.test((cap as Error)?.message ?? "") && /tomorrow/.test((cap as Error)?.message ?? ""), (cap as Error)?.message);
  check("…and carries the wait for a 429", ((cap as { retryAfterSec?: number })?.retryAfterSec ?? 0) > 0);
  process.env.ORBIT_NEW_LIMITS = "log";
  const warn2 = console.warn;
  console.warn = () => {};
  try {
    await consumeDailyCap("importDaily", capUser);
    check("under ORBIT_NEW_LIMITS=log the cap only logs", true);
  } catch (err) {
    check("under ORBIT_NEW_LIMITS=log the cap only logs", false, String(err));
  } finally {
    console.warn = warn2;
    delete process.env.ORBIT_NEW_LIMITS;
  }

  console.log("\nThe API key cap counts live keys...");
  const { apiKeyCapRefusal } = await import("../src/lib/api/key-cap");
  const { generateApiKey } = await import("../src/lib/api/keys");
  const { apiKeys } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const keyUser = `smoke-keycap-${Date.now()}`;
  const ids: string[] = [];
  for (let i = 0; i < MAX_ACTIVE_API_KEYS; i++) {
    const key = generateApiKey("api");
    const [row] = await db.insert(apiKeys).values({ userId: keyUser, name: `k${i}`, kind: "api", prefix: key.prefix, keyHash: key.keyHash, scopes: ["read"] }).returning();
    ids.push(row!.id);
  }
  const atCap = await apiKeyCapRefusal(keyUser);
  check("at 10 active keys another is refused", typeof atCap === "string" && /Revoke one/.test(atCap), atCap);
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, ids[0]!));
  check("revoking one frees a slot", (await apiKeyCapRefusal(keyUser)) === null);
  await db.update(apiKeys).set({ revokedAt: null }).where(eq(apiKeys.id, ids[0]!));
  process.env.ORBIT_NEW_LIMITS = "log";
  const warn3 = console.warn;
  console.warn = () => {};
  try {
    check("under ORBIT_NEW_LIMITS=log the key cap only logs", (await apiKeyCapRefusal(keyUser)) === null);
  } finally {
    console.warn = warn3;
    delete process.env.ORBIT_NEW_LIMITS;
  }
  await db.delete(apiKeys).where(eq(apiKeys.userId, keyUser));

  console.log("\nWhere the new limits are spent (source)...");
  const src = (path: string) => readFileSync(path, "utf8");
  check("outreach drafts spend `draft`", /consumeBucket\("draft", userId, RATE_LIMITS\.draft\)/.test(src("src/lib/outreach-drafts.ts")));
  check("…a bulk run per ten drafts", /Math\.ceil\(inputs\.length \/ DRAFTS_PER_UNIT\)/.test(src("src/lib/outreach-drafts.ts")));
  check("recruiter drafts spend `draft`", /consumeBucket\("draft"/.test(src("src/lib/recruiter-drafts.ts")));
  check("follow-up drafts spend `draft` or `compose`", /consumeBucket\(scope, input\.userId, RATE_LIMITS\[scope\]\)/.test(src("src/lib/follow-up-drafts.ts")));
  check("compose asks for the `compose` bucket", /meter: "compose"/.test(src("src/actions/email-compose.ts")));
  check("briefs spend `brief` where the model is asked", /consumeBucket\("brief", userId, RATE_LIMITS\.brief\)/.test(src("src/lib/contact-brief.ts")));
  check("talking points spend `prep`", /consumeBucket\("prep", userId, RATE_LIMITS\.prep\)/.test(src("src/lib/meeting-talking-points.ts")));
  check("duplicate ranking spends `duplicateHints`", /consumeBucket\("duplicateHints"/.test(src("src/lib/duplicate-review.ts")));
  check("the chat-mic mint spends `dictationToken`", /consumeBucket\("dictationToken"/.test(src("src/app/api/speech/token/route.ts")));
  check("new chats are capped", /consumeDailyCap\("chatThreadDaily", userId\)/.test(src("src/actions/chat.ts")));
  check("reminders are capped", (src("src/lib/reminder-writes.ts").match(/consumeDailyCap\("reminderDaily", userId\)/g) ?? []).length === 2);
  const importSites = ["src/actions/imports.ts", "src/actions/gmail.ts", "src/actions/outlook.ts", "src/lib/chat-import-preview.ts", "src/lib/drive-import-processor.ts", "src/lib/linkedin-export-store.ts"]
    .map((p) => (src(p).match(/consumeDailyCap\("importDaily", userId\)/g) ?? []).length);
  check("imports are capped at every start (6 + 1 + 1 + 1 + 1 + 1)", importSites.join(",") === "6,1,1,1,1,1", importSites);
  check("API keys are capped", /apiKeyCapRefusal\(userId\)/.test(src("src/actions/api-keys.ts")));
  check(".env.example documents the switch", /ORBIT_NEW_LIMITS/.test(src(".env.example")));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
