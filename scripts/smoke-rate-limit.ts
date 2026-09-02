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

import { RateLimitedError, consumeBucket } from "../src/lib/rate-limit";

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
