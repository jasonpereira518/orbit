/**
 * When the constellation gets a warp intro, and when it must stay out of the way.
 *
 * The animation itself is unverifiable from a script — and from the Browser pane too, which
 * runs at `visibilityState: "hidden"` where rAF is starved and CSS transitions freeze. So this
 * covers the part that actually decides whether a user waits longer than they had to: the
 * predicate, the minimum-beat floor, and the guards that stop a refresh replaying the intro.
 *
 * The load-bearing property, asserted by name below: **when the predicate declines, nothing
 * happens at all.** No run, no timer, no gate. A feature that makes fast loads slower to
 * decorate slow ones would be worse than no feature.
 *
 * Run: npx tsx scripts/smoke-graph-intro.ts
 */
import {
  INTRO_ARRIVING_MS,
  INTRO_CONTACT_FLOOR,
  INTRO_CRUISE_BURSTS,
  INTRO_LATE_MS,
  INTRO_LOW_CORE_THRESHOLD,
  INTRO_MIN_BEAT_MS,
  INTRO_OPAQUE_MS,
  INTRO_RESERVE_FRACTION,
  introCoverage,
  introFrame,
  predictSlowIntro,
} from "../src/lib/graph/intro-choreography";
import {
  __resetIntroForTests,
  beginIntro,
  getIntroRun,
  markGraphViewportReady,
  registerIntroHost,
  suppressIntro,
} from "../src/lib/graph/intro-signal";
import { IGNITION_FRACTIONS } from "../src/lib/warp/chrono";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------------------

function predict(over: Partial<Parameters<typeof predictSlowIntro>[0]> = {}) {
  return predictSlowIntro({
    reduced: false,
    chunkLoaded: true,
    contactCount: 10,
    cores: 8,
    ...over,
  });
}

console.log("The predicate…");
check(
  "a cold chunk warps whatever the network size",
  predict({ chunkLoaded: false, contactCount: 1 }).reason === "cold-chunk"
);
check(
  "reduced motion beats even a cold chunk",
  predict({ reduced: true, chunkLoaded: false, contactCount: 5000 }).warp === false
);
check(
  "a warm chunk with no payload yet does NOT warp",
  predict({ contactCount: null }).warp === false,
  "asked-too-early must not read as 'unknown, assume slow'"
);
check(
  "a small network on a warm chunk does not warp",
  predict({ contactCount: INTRO_CONTACT_FLOOR - 1 }).warp === false
);
check(
  "a network at the floor does",
  predict({ contactCount: INTRO_CONTACT_FLOOR }).reason === "layout-cost"
);
check(
  "a low-core device halves the effective floor",
  predict({
    contactCount: Math.ceil(INTRO_CONTACT_FLOOR / 2),
    cores: INTRO_LOW_CORE_THRESHOLD,
  }).warp === true &&
    predict({
      contactCount: Math.ceil(INTRO_CONTACT_FLOOR / 2),
      cores: INTRO_LOW_CORE_THRESHOLD + 4,
    }).warp === false
);

// ---------------------------------------------------------------------------------------
// The interlock with the chart's own fade
// ---------------------------------------------------------------------------------------

console.log("\nHand-off interlock…");
// If this ever fails, `network-graph.tsx` fades <ReactFlow> in over 220ms while the intro is
// already going transparent — the user sees two transitions instead of one.
check(
  "the intro holds full cover for longer than ReactFlow's 220ms opacity fade",
  INTRO_OPAQUE_MS >= 220,
  `INTRO_OPAQUE_MS=${INTRO_OPAQUE_MS.toFixed(0)} vs the "opacity 220ms ease" literal in network-graph.tsx`
);
check(
  "cover is total while the collapse runs",
  introCoverage("arriving", 5000, 0) === 1 &&
    introCoverage("arriving", 5000, INTRO_OPAQUE_MS) === 1
);
check(
  "and gone by the end of the arriving window",
  introCoverage("arriving", 5000, INTRO_ARRIVING_MS) === 0
);
check(
  "never increasing across the hand-off",
  (() => {
    let prev = 1;
    for (let t = 0; t <= INTRO_ARRIVING_MS; t += 10) {
      const c = introCoverage("arriving", 5000, t);
      if (c > prev + 1e-9) return false;
      prev = c;
    }
    return true;
  })()
);

console.log("\nA hold longer than a route transition…");
check(
  "the sky keeps growing well past the warp's own 4s cap",
  introFrame("cruise", 8000, 0).bursts >
    introFrame("cruise", 4200, 0).bursts
);
check(
  "but never past the reserve the stage seeded",
  introFrame("cruise", 60_000, 0).bursts ===
    IGNITION_FRACTIONS.length + INTRO_CRUISE_BURSTS
);
check(
  "and the reserve is big enough to actually light those levels on a small canvas",
  Math.floor(360 * INTRO_RESERVE_FRACTION) >= INTRO_CRUISE_BURSTS,
  `${Math.floor(360 * INTRO_RESERVE_FRACTION)} reserve stars for ${INTRO_CRUISE_BURSTS} levels`
);
check(
  "bursts reached during a hold carry into the landing, so the sky does not empty",
  introFrame("arriving", 8000, 0).bursts === introFrame("cruise", 8000, 0).bursts
);

// ---------------------------------------------------------------------------------------
// The run: the fast path, the floor, and the replay guards
// ---------------------------------------------------------------------------------------

async function runChecks() {
  console.log("\nThe fast path costs nothing…");
  __resetIntroForTests();
  const release = registerIntroHost();
  // The predicate declined, so nothing calls beginIntro. This is the whole feature's contract.
  markGraphViewportReady();
  check("no run is started by a ready signal alone", getIntroRun().status === "idle");
  release();

  console.log("\nThe minimum beat…");
  __resetIntroForTests();
  const release2 = registerIntroHost();
  beginIntro("layout-cost");
  const started = getIntroRun().startedAt;
  markGraphViewportReady(); // ready almost immediately
  check("ready does not collapse the run instantly", getIntroRun().status === "running");
  await sleep(INTRO_MIN_BEAT_MS + 90);
  const arrivedAt = getIntroRun().arrivingAt;
  check(
    "the collapse waits out the full beat",
    getIntroRun().status === "arriving" &&
      arrivedAt !== null &&
      arrivedAt - started >= INTRO_MIN_BEAT_MS - 5,
    `held ${arrivedAt === null ? "n/a" : (arrivedAt - started).toFixed(0)}ms`
  );
  release2();

  console.log("\nA slow load is not padded further…");
  __resetIntroForTests();
  const release3 = registerIntroHost();
  beginIntro("cold-chunk");
  await sleep(INTRO_MIN_BEAT_MS + 120);
  const before = Date.now();
  markGraphViewportReady();
  await sleep(40);
  check(
    "a run that already outlasted the beat collapses at once",
    getIntroRun().status === "arriving" && Date.now() - before < 120
  );
  release3();

  console.log("\nThe replay guards — refresh remounts must not restart it…");
  __resetIntroForTests();
  const release4 = registerIntroHost();
  beginIntro("cold-chunk");
  const firstStart = getIntroRun().startedAt;
  check("a second begin is ignored", beginIntro("layout-cost") === false);
  check("and does not move the clock", getIntroRun().startedAt === firstStart);
  // `runRefresh` bumps resetToken per batch; every bump remounts GraphCanvasInner and re-fires
  // viewportReady. Ten of those must not produce ten intros.
  for (let i = 0; i < 10; i++) markGraphViewportReady();
  await sleep(INTRO_MIN_BEAT_MS + INTRO_ARRIVING_MS + 140);
  check("the run reaches done exactly once", getIntroRun().status === "done");
  markGraphViewportReady();
  check("a ready signal after done changes nothing", getIntroRun().status === "done");
  check("and a fresh begin cannot restart it", beginIntro("late") === false);
  release4();

  console.log("\nWithout a host there is nowhere to draw…");
  __resetIntroForTests();
  check(
    "begin is refused when no intro is mounted (the dashboard preview case)",
    beginIntro("cold-chunk") === false && getIntroRun().status === "idle"
  );

  console.log("\nSuppression is total…");
  __resetIntroForTests();
  const release6 = registerIntroHost();
  suppressIntro();
  check("an explicit off blocks the predictive triggers", beginIntro("cold-chunk") === false);
  await sleep(INTRO_LATE_MS + 150);
  check(
    "and the late fallback too — 'off' has to mean no intro at all",
    getIntroRun().status === "idle",
    "the first browser check caught exactly this: off suppressed the predictors but the net still fired"
  );
  release6();

  console.log("\nThe late fallback…");
  check(
    "fires far beyond any fast load",
    INTRO_LATE_MS > 4 * 150,
    `${INTRO_LATE_MS}ms vs a ~120-150ms warm settle`
  );
  __resetIntroForTests();
  const release5 = registerIntroHost();
  markGraphViewportReady(); // settles well before the fallback would fire
  await sleep(INTRO_LATE_MS + 120);
  check(
    "a chart that settles first never trips it",
    getIntroRun().status === "idle",
    "a near-miss settle must not start a warp and then hold it for the beat"
  );
  release5();
}

runChecks()
  .then(() => {
    console.log("\nAll constellation intro checks passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
