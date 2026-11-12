/**
 * Pins the landing intro's warp curve and its once-per-session gate.
 *
 * The warp draws every real star of the landing sky along `warpPoint(rest, origin, k)` for its
 * first WARP_MS and then hands the stars back to the plain loop. The hand-off is only invisible
 * if `k` lands on exactly 1 (each star on its own rest pixel) and the streak has collapsed to a
 * point; a tab hidden mid-warp must come back at rest, not mid-flight.
 *
 * Run: npx tsx scripts/smoke-landing-intro.ts
 */
import {
  LANDING_INTRO_ATTR,
  LANDING_INTRO_KEY,
  LANDING_INTRO_PREPAINT_SCRIPT,
  SKY_FADE_MS,
  STREAK_LAG_MS,
  WARP_MS,
  skyAlpha,
  warpK,
  warpPoint,
  warpProgress,
} from "../src/lib/landing-intro";

function monotonicWithinOne() {
  let prev = -1;
  for (let t = 0; t <= WARP_MS; t += 16) {
    const p = warpProgress(t);
    if (p < prev || p > 1) return false;
    prev = p;
  }
  return true;
}

const END = WARP_MS + STREAK_LAG_MS;
const head = warpPoint(300, 200, 100, 100, warpK(0.2, warpProgress(END)));
const tail = warpPoint(300, 200, 100, 100, warpK(0.2, warpProgress(END - STREAK_LAG_MS)));
const restPoint = warpPoint(300, 200, 100, 100, 1);
const s = LANDING_INTRO_PREPAINT_SCRIPT;

const CASES: Array<[label: string, got: unknown, expected: unknown]> = [
  ["progress starts at 0", warpProgress(0), 0],
  ["negative elapsed clamps to 0", warpProgress(-50), 0],
  ["progress ends at exactly 1", warpProgress(WARP_MS), 1],
  ["a tab hidden for a minute comes back at rest", warpProgress(WARP_MS * 40), 1],
  ["progress is monotonic and never above 1", monotonicWithinOne(), true],
  ["k ends at exactly 1", warpK(0.2, 1), 1],
  ["k starts at the star's depth", warpK(0.2, 0), 0.2],
  ["k=1 lands on the rest pixel (x)", restPoint.x, 300],
  ["k=1 lands on the rest pixel (y)", restPoint.y, 200],
  ["streak has no length once the warp is over", head.x === tail.x && head.y === tail.y, true],
  ["sky alpha starts at 0", skyAlpha(0), 0],
  ["sky alpha is full after the fade", skyAlpha(SKY_FADE_MS), 1],
  ["sky alpha stays full", skyAlpha(1e6), 1],
  ["gate uses sessionStorage", s.includes("sessionStorage"), true],
  ["gate skips hash links", s.includes("location.hash"), true],
  ["gate honours Orbit's Reduce motion", s.includes("data-motion"), true],
  ["gate honours the system setting", s.includes("prefers-reduced-motion: reduce"), true],
  ["gate uses the storage key", s.includes(LANDING_INTRO_KEY), true],
  ["gate sets the attribute", s.includes(LANDING_INTRO_ATTR), true],
  ["gate cannot throw (opens)", s.startsWith("try{"), true],
  ["gate cannot throw (closes)", s.endsWith("}catch(e){}"), true],
];

let failed = 0;
for (const [label, got, expected] of CASES) {
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` (got ${String(got)}, expected ${String(expected)})`}`);
}

if (failed) {
  console.error(`\nFAILED: ${failed} case(s). See src/lib/landing-intro.ts.`);
  process.exit(1);
}
console.log(`\nLanding intro warp lands every star at rest (${CASES.length} cases).`);
process.exit(0);
