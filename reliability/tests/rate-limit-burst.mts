// Burst against the real Postgres-backed limiter (src/lib/rate-limit.ts consumeBucket):
// 300 simultaneous requests on one bucket with limit 50 must admit exactly 50.
//
//   npx tsx reliability/lib/with-shim.mts reliability/tests/rate-limit-burst.mts
import fs from "node:fs";
import { consumeBucket, isRateLimitedError } from "../../src/lib/rate-limit";

const BURST = 300;
const policy = { limit: 50, windowSec: 600 };
const key = `burst-${Date.now()}`;

const started = Date.now();
const outcomes = await Promise.allSettled(
  Array.from({ length: BURST }, () => consumeBucket("rel-test", key, policy))
);
const ms = Date.now() - started;
const allowed = outcomes.filter((o) => o.status === "fulfilled").length;
const limited = outcomes.filter((o) => o.status === "rejected" && isRateLimitedError(o.reason)).length;
const errors = outcomes.filter((o) => o.status === "rejected" && !isRateLimitedError(o.reason)).length;
const result = { BURST, limit: policy.limit, allowed, limited, errors, ms };
console.log(result);
fs.writeFileSync("reliability/results/rate-limit-burst.json", JSON.stringify(result, null, 2));
process.exit(0);
