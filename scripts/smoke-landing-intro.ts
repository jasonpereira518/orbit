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
  WARP_EXTRA_SPAN,
  WARP_FIELD_REACH,
  WARP_LAP,
  WARP_SHARE,
  WARP_TRAVEL,
  WARP_MS,
  introOrigin,
  landingWarpStart,
  skyAlpha,
  warpLogK,
  warpPoint,
  warpProgress,
  warpShareAlpha,
  warpStarAlpha,
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

// The flight (Jason, Nov 12: "like you are zooming to space and then you arrive at the solar
// system"). Each star's depth `u` (log of k) streams outward and wraps back to the vanishing
// point like flying through a field, then decelerates onto u=0, its exact rest position.
// Two random numbers per star: lap offset in [0, WARP_LAP) and extra travel in
// [0, WARP_EXTRA_SPAN). Stand-ins: 50 stars with the two spread independently (37 is coprime
// with 50).
const STARS = Array.from({ length: 50 }, (_, i) => [(i / 50) * WARP_LAP, (((i * 37) % 50) / 50) * WARP_EXTRA_SPAN] as const);
const allLand = STARS.every(([o, e]) => warpLogK(o, e, 1) === 0);
// Within a frame step a star either moves outward (u grows) or wraps back by one lap.
function flowsOutward() {
  for (const [o, e] of STARS) {
    let prev = warpLogK(o, e, 0);
    for (let t = 16; t <= WARP_MS; t += 16) {
      const u = warpLogK(o, e, warpProgress(t));
      const wrapped = Math.abs(prev - u - WARP_LAP) < 0.5;
      if (u < prev - 1e-9 && !wrapped) return false;
      prev = u;
    }
  }
  return true;
}
// The screen is full from the first frame: stars sit at every depth, inside and past their rest.
const startDepths = STARS.map(([o, e]) => warpLogK(o, e, 0));
const coversDepths =
  Math.min(...startDepths) < -0.6 * WARP_LAP && Math.max(...startDepths) > 0.3 * WARP_LAP;
// Still mixed a quarter of the way into the flight, not bunched into one shrunken copy of the sky.
const midDepths = STARS.map(([o, e]) => warpLogK(o, e, warpProgress(WARP_MS / 8)));
const midSpread = Math.max(...midDepths) - Math.min(...midDepths);
// Every star actually travels: at least one full lap over the flight.
function travels() {
  return STARS.every(([o, e]) => {
    let wraps = 0;
    let prev = warpLogK(o, e, 0);
    for (let t = 16; t <= WARP_MS; t += 16) {
      const u = warpLogK(o, e, warpProgress(t));
      if (u < prev) wraps++;
      prev = u;
    }
    return wraps >= 1;
  });
}
// Speed of the flight (progress per ms) at a moment, by finite difference.
function speedAt(ms: number) {
  return warpProgress(ms + 1) - warpProgress(ms);
}
// The streak joins where the star was STREAK_LAG_MS ago; once the flight is over it has no length.
const END = WARP_MS + STREAK_LAG_MS;
const head = warpPoint(300, 200, 100, 100, Math.exp(warpLogK(0.7, 0.3, warpProgress(END))));
const tail = warpPoint(300, 200, 100, 100, Math.exp(warpLogK(0.7, 0.3, warpProgress(END - STREAK_LAG_MS))));
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

// Run the real gate script against a stubbed page, twice in one tab, and report whether each
// load got the attribute. Localhost replays every load (Jason, Nov 12) so the intro can be
// watched while working on it; everywhere else it is once per tab session.
function gateRuns(hostname: string, hash = ""): boolean[] {
  const store = new Map<string, string>();
  const runs: boolean[] = [];
  for (let i = 0; i < 2; i++) {
    const attrs = new Map<string, string>();
    const doc = {
      documentElement: {
        getAttribute: (k: string) => attrs.get(k) ?? null,
        setAttribute: (k: string, v: string) => void attrs.set(k, v),
      },
    };
    const run = new Function("document", "location", "matchMedia", "sessionStorage", s);
    run(doc, { hostname, hash }, () => ({ matches: false }), {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    runs.push(attrs.has(LANDING_INTRO_ATTR));
  }
  return runs;
}

const CASES: Array<[label: string, got: unknown, expected: unknown]> = [
  ["production host: first load plays", gateRuns("orbit.example.com")[0], true],
  ["production host: second load in the tab does not", gateRuns("orbit.example.com")[1], false],
  ["localhost: every load plays", gateRuns("localhost").join(), "true,true"],
  ["127.0.0.1: every load plays", gateRuns("127.0.0.1").join(), "true,true"],
  ["localhost with a hash link still skips", gateRuns("localhost", "#features").join(), "false,false"],
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
  ["every star lands exactly on its rest depth", allLand, true],
  ["stars stream outward, wrapping back to the vanishing point", flowsOutward(), true],
  ["the first frame has stars at every depth (screen covered)", coversDepths, true],
  ["every star flies at least one full lap", travels(), true],
  // Jason, Nov 12: "As the galaxy zooms in the stars should already be slower." The solar
  // system's zoom does most of its growing in the second half, so by halfway the stars must be
  // well under a fifth of their starting speed.
  ["halfway through, the stars are under a fifth of their starting speed", speedAt(WARP_MS / 2) < speedAt(0) / 5, true],
  ["an eighth in, stars still sit across most of a lap of depth", midSpread > WARP_LAP * 0.8, true],
  // As the flight slows every star closes in on its rest from the sun's side, so the edges would
  // empty out. Temporary stars resting off-screen, out to this reach, fill them and then leave.
  ["temporary edge stars reach well past the screen", WARP_FIELD_REACH >= 1.8, true],
  // Less dense while flying (Jason, Nov 12): only WARP_SHARE of the stars fly; the rest stay
  // hidden and fade up at their places as the flight lands, so the resting sky is complete.
  ["a flying star is fully drawn mid-flight", warpShareAlpha(WARP_SHARE / 2, 0.5), 1],
  ["a non-flying star is hidden mid-flight", warpShareAlpha((WARP_SHARE + 1) / 2, 0.5), 0],
  ["a non-flying star is fully back on arrival", warpShareAlpha(0.99, 1), 1],
  ["fewer than two thirds of the stars fly", WARP_SHARE <= 2 / 3, true],
  ["every star ends at full brightness", STARS.every(([o, e]) => warpStarAlpha(o, e, 1) === 1), true],
  // At p=0 this offset puts the star 0.01 into its lap: it has just respawned at the sun.
  ["a star just respawned at the vanishing point is faint", warpStarAlpha(((WARP_TRAVEL % WARP_LAP) + 0.01) % WARP_LAP, 0, 0) < 0.2, true],
  ["k=1 lands on the rest pixel (x)", restPoint.x, 300],
  ["k=1 lands on the rest pixel (y)", restPoint.y, 200],
  ["streak has no length once the warp is over", head.x === tail.x && head.y === tail.y, true],
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
