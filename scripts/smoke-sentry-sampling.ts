/**
 * `sampleServerTrace` (src/lib/sentry-sampling.ts): the always-on beats are never traced,
 * everything else keeps the default rate, and an upstream decision is followed.
 *
 * Pure. Run: npx tsx scripts/smoke-sentry-sampling.ts
 */
import { DEFAULT_TRACE_SAMPLE_RATE, sampleServerTrace } from "../src/lib/sentry-sampling";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const rate = (name: string, inherited?: number) =>
  sampleServerTrace({ name, inheritOrSampleWith: (fallback) => inherited ?? fallback });

check("presence beats are never traced", rate("POST /api/presence") === 0);
check("page-view beacons are never traced", rate("POST /api/track") === 0 && rate("POST /api/track/load") === 0);
check("even when upstream sampled them", rate("POST /api/presence", 1) === 0);
check("other routes keep the default rate", rate("GET /api/health") === DEFAULT_TRACE_SAMPLE_RATE && rate("POST /contacts") === DEFAULT_TRACE_SAMPLE_RATE);
check("a look-alike route is not caught", rate("GET /api/tracking-links") === DEFAULT_TRACE_SAMPLE_RATE && rate("POST /api/presences") === DEFAULT_TRACE_SAMPLE_RATE);
check("an upstream decision is followed elsewhere", rate("GET /api/health", 1) === 1);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Sentry sampling checks passed");
