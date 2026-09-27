/**
 * Exercises `withRateLimitBackoff` in isolation: a rate-limit error retries with backoff and
 * eventually succeeds or gives up, and a non-rate-limit error never retries at all. No DB,
 * no network — this is the gap `smoke-page-budgets.ts`'s `embedding-backfill.ts` coverage
 * doesn't reach, since that test stubs `embed` above this layer entirely.
 * Run: npx tsx scripts/smoke-embedding-rate-limit-backoff.ts
 */
import { withRateLimitBackoff } from "../src/lib/ai";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

class FakeRateLimitError extends Error {
  constructor() {
    super("429 rate limit exceeded");
  }
}

async function main() {
  // --- Retries a rate-limit error and succeeds once it clears ---------------------------
  {
    let calls = 0;
    const start = Date.now();
    const result = await withRateLimitBackoff(async () => {
      calls++;
      if (calls < 3) throw new FakeRateLimitError();
      return "ok";
    });
    const elapsed = Date.now() - start;
    check("succeeds after transient rate limits clear", result === "ok");
    check("retried exactly as many times as needed", calls === 3, `calls=${calls}`);
    check("actually waited between attempts (backoff, not a busy loop)", elapsed >= 500, `${elapsed}ms`);
  }

  // --- Gives up after the retry budget, so a sustained outage still surfaces -------------
  {
    let calls = 0;
    await withRateLimitBackoff(async () => {
      calls++;
      throw new FakeRateLimitError();
    }).then(
      () => check("a sustained rate limit eventually throws", false, "resolved instead of throwing"),
      (err) => check("a sustained rate limit eventually throws", err instanceof FakeRateLimitError)
    );
    // RATE_LIMIT_MAX_RETRIES = 3 -> 1 initial attempt + 3 retries = 4 calls.
    check("stops after a bounded number of attempts", calls === 4, `calls=${calls}`);
  }

  // --- Never retries an error that isn't a rate limit ------------------------------------
  {
    let calls = 0;
    await withRateLimitBackoff(async () => {
      calls++;
      throw new Error("Empty embedding response");
    }).then(
      () => check("a non-rate-limit error is not retried", false, "resolved instead of throwing"),
      () => check("a non-rate-limit error is not retried", true)
    );
    check("only tried once", calls === 1, `calls=${calls}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll embedding rate-limit backoff checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
