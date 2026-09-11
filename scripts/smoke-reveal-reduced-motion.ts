/**
 * Asserts that <Reveal> never hides content from someone who asked for reduced motion.
 *
 * It did, on every page that uses it. `usePrefersReducedMotion` starts false and learns the
 * real preference one render late, so Reveal's first effect run saw "not reduced" and set
 * below-the-fold elements to "pending" (opacity 0). When the hook then flipped, the effect's
 * cleanup disconnected the observer, which was the only thing that could reveal them. Measured
 * on production with reduced motion emulated: 21 of 21 landing-page reveals stuck at opacity 0,
 * i.e. every scroll-revealed heading, paragraph and button, including the sign-up ask.
 *
 * The browser proof lives with the fix (headless Chrome, reduced motion emulated). This pins
 * the decision so nobody "simplifies" the synchronous media-query read back out.
 *
 * Run: npx tsx scripts/smoke-reveal-reduced-motion.ts
 */
import { revealAttr, shouldStartHidden } from "../src/components/motion/reveal";

const BELOW = { top: 2000, viewportHeight: 900 };
const ONSCREEN = { top: 300, viewportHeight: 900 };

const CASES: Array<[label: string, got: unknown, expected: unknown]> = [
  // The bug, exactly: the hook has not caught up, the media query already knows.
  [
    "hook says no, media query says reduced -> never hide",
    shouldStartHidden({ hookReduced: false, mediaReduced: true, ...BELOW }),
    false,
  ],
  ["hook has caught up -> never hide", shouldStartHidden({ hookReduced: true, mediaReduced: true, ...BELOW }), false],
  ["no reduced motion, below the fold -> hide until revealed", shouldStartHidden({ hookReduced: false, mediaReduced: false, ...BELOW }), true],
  ["no reduced motion, already on screen -> leave visible", shouldStartHidden({ hookReduced: false, mediaReduced: false, ...ONSCREEN }), false],
  // The render guard: a preference that turns on mid-session beats a stuck "pending".
  ["pending + reduced -> rendered visible", revealAttr("pending", true), undefined],
  ["pending, not reduced -> stays pending", revealAttr("pending", false), "pending"],
  ["in, not reduced -> in", revealAttr("in", false), "in"],
  ["visible -> no attribute", revealAttr("visible", false), undefined],
];

let failed = 0;
for (const [label, got, expected] of CASES) {
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` (got ${String(got)}, expected ${String(expected)})`}`);
}

if (failed) {
  console.error(`\nFAILED: ${failed} case(s). See src/components/motion/reveal.tsx.`);
  process.exit(1);
}
console.log(`\nReveal never hides content from a reduced-motion visitor (${CASES.length} cases).`);
process.exit(0);
