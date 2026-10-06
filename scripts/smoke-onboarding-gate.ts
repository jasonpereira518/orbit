/**
 * The guided tour's state predicates, the matrix the (app) layout, /onboarding and Settings
 * all decide from: when the coach rail mounts, when a Resume door is offered, and when a
 * tour is simply over.
 *
 * Run: npx tsx scripts/smoke-onboarding-gate.ts
 */
import { tourInProgress, tourRailVisible, tourResumable } from "../src/lib/tour/tour-state";

function check(label: string, condition: boolean) {
  if (!condition) throw new Error(`${label} failed`);
  console.log(`  ok  ${label}`);
}

const now = new Date();

function main() {
  console.log("Tour state…");
  const fresh = { tourStartedAt: null, tourExitedAt: null, tourCompletedAt: null };
  const running = { tourStartedAt: now, tourExitedAt: null, tourCompletedAt: null };
  const exited = { tourStartedAt: now, tourExitedAt: now, tourCompletedAt: null };
  const finished = { tourStartedAt: now, tourExitedAt: null, tourCompletedAt: now };
  const finishedAfterExit = { tourStartedAt: now, tourExitedAt: now, tourCompletedAt: now };
  const asStrings = { tourStartedAt: now.toISOString(), tourExitedAt: null, tourCompletedAt: null };

  check("a fresh account has no tour", !tourInProgress(fresh) && !tourRailVisible(fresh) && !tourResumable(fresh));
  check("a running tour shows the rail and is not resumable", tourInProgress(running) && tourRailVisible(running) && !tourResumable(running));
  check("an exited tour hides the rail and is resumable", tourInProgress(exited) && !tourRailVisible(exited) && tourResumable(exited));
  check("a finished tour is over", !tourInProgress(finished) && !tourRailVisible(finished) && !tourResumable(finished));
  check("finishing after an exit is still over", !tourInProgress(finishedAfterExit) && !tourResumable(finishedAfterExit));
  check("ISO strings from a serialised row count as dates", tourRailVisible(asStrings));

  console.log("\nAll tour state checks passed.");
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exit(1);
}
