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
  STREAK_MAX,
  WARP_DEPTH_MIN,
  WARP_MS,
  introOrigin,
  landingWarpStart,
  skyAlpha,
  warpK,
  warpPoint,
  warpProgress,
  warpTailK,
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

// The streak trails from each star back toward the origin and collapses to a point at the end.
const endK = warpK(0.9, warpProgress(WARP_MS));
const head = warpPoint(300, 200, 100, 100, endK);
const tail = warpPoint(300, 200, 100, 100, warpTailK(endK, warpProgress(WARP_MS)));
function tailShrinks() {
  let prev = Infinity;
  for (let t = 0; t <= WARP_MS; t += 16) {
    const p = warpProgress(t);
    const len = warpK(0.9, p) - warpTailK(warpK(0.9, p), p);
    if (len > prev + 1e-12 || len < 0) return false;
    prev = len;
  }
  return true;
}
const restPoint = warpPoint(300, 200, 100, 100, 1);
const s = LANDING_INTRO_PREPAINT_SCRIPT;

// The shared start. React's development double-run mounts the sky, tears it down and mounts it
// again within a frame; the second mount must continue the same warp, not lose it or restart it.
const noAttr = landingWarpStart(1000);
let attrOn = true;
(globalThis as { document?: unknown }).document = {
  documentElement: {
    hasAttribute: () => attrOn,
    getAttribute: () => null,
  },
};
const firstMount = landingWarpStart(1000);
const remount = landingWarpStart(1016);
const lateMount = landingWarpStart(1000 + WARP_MS + 1);
attrOn = false;
const clientNavBack = landingWarpStart(1020);

// The origin. The sky can mount seconds after load; a visitor who has scrolled past the hero by
// then must not get 1.6s of parallel streaks from a sun that is off the top of the screen.
const rect = (top: number, h = 400, left = 800, w = 400) => ({ left, top, width: w, height: h });
const inView = introOrigin(rect(200), 1440, 900);
const scrolledPast = introOrigin(rect(-1200), 1440, 900);
const partlyAbove = introOrigin(rect(-300), 1440, 900);
const noBox = introOrigin(null, 1440, 900);
const zeroBox = introOrigin(rect(200, 0, 800, 0), 1440, 900);

const CASES: Array<[label: string, got: unknown, expected: unknown]> = [
  ["origin is the box centre when it is on screen", inView && `${inView.x},${inView.y}`, "1000,400"],
  ["box scrolled off the top -> no warp", scrolledPast, null],
  ["box centre above the viewport -> no warp", partlyAbove, null],
  ["no box -> viewport centre", noBox && `${noBox.x},${noBox.y}`, "720,450"],
  ["zero-size box -> viewport centre", zeroBox && `${zeroBox.x},${zeroBox.y}`, "720,450"],
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
  ["streak only ever shrinks", tailShrinks(), true],
  ["streak starts STREAK_MAX of the way back to the origin", warpTailK(1, 0), 1 - STREAK_MAX],
  // Jason, Nov 12: the whole screen is covered with stars from the first frame, not poured out
  // of one point. Every star starts most of the way to its rest position.
  ["every star starts at least 80% of the way to its rest", WARP_DEPTH_MIN >= 0.8, true],
  ["sky alpha starts at 0", skyAlpha(0), 0],
  ["sky alpha is full after the fade", skyAlpha(SKY_FADE_MS), 1],
  ["sky alpha stays full", skyAlpha(1e6), 1],
  ["no document (server) -> no warp", noAttr, null],
  ["first mount starts the warp now", firstMount, 1000],
  ["a remount mid-warp continues the same warp", remount, 1000],
  ["a mount after the warp has ended gets the plain sky", lateMount, null],
  ["attribute gone (client-side return to /) -> no warp", clientNavBack, null],
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
