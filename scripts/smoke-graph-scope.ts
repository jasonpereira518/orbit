/**
 * The scope bus between the star chart and the header toggle that drives it.
 *
 * The control moved out of the canvas and into the page header, which put it on the far side
 * of the Suspense boundary from the chart — so the two now talk through a module-scope bus
 * instead of props, and the guarantees that used to be structural have to be asserted.
 *
 * The load-bearing one, asserted by name below: **the button cannot make the chart fetch
 * anything the chart did not offer.** A request with no chart mounted is a no-op, not a queued
 * intent — that is what keeps "we never load everyone until you ask" a property of one file.
 *
 * Run: npx tsx scripts/smoke-graph-scope.ts
 */
import {
  __resetGraphScopeForTests,
  getGraphScopeState,
  publishGraphScope,
  registerGraphScopeController,
  requestGraphScope,
  subscribeGraphScope,
} from "../src/lib/graph/scope-signal";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

console.log("Before a chart mounts…");
__resetGraphScopeForTests();
check(
  "the toggle has nothing to offer",
  getGraphScopeState().available === false,
  "with the filter off there is only one view, and a toggle between two identical charts is a lie"
);
requestGraphScope("all");
check(
  "and a request goes nowhere rather than being queued",
  getGraphScopeState().scope === "engaged",
  "a queued intent would fire the full-network fetch the moment a chart appeared"
);

console.log("\nA mounted chart owns the decision…");
__resetGraphScopeForTests();
const asked: string[] = [];
const release = registerGraphScopeController((next) => asked.push(next));
requestGraphScope("all");
check("the request reaches the chart", asked.join(",") === "all");
check(
  "but the bus does not move the scope itself",
  getGraphScopeState().scope === "engaged",
  "only the chart, which owns the payload, may say what is on screen"
);
publishGraphScope({ available: true, scope: "all", shown: 74, total: 114 });
check(
  "the chart's own report is what changes it",
  getGraphScopeState().scope === "all" && getGraphScopeState().available === true
);

console.log("\nSnapshots are stable, so useSyncExternalStore does not loop…");
const before = getGraphScopeState();
publishGraphScope({ available: true, scope: "all", shown: 74, total: 114 });
check(
  "republishing identical state returns the same object",
  getGraphScopeState() === before,
  "a fresh object every publish would re-render the header on every payload refresh"
);
let notified = 0;
const unsubscribe = subscribeGraphScope(() => {
  notified += 1;
});
publishGraphScope({ shown: 74 });
check("and notifies nobody", notified === 0);
publishGraphScope({ shown: 75 });
check("while a real change does", notified === 1);
unsubscribe();

console.log("\nUnmounting resets it…");
release();
check(
  "the header stops advertising a chart that is gone",
  getGraphScopeState().available === false &&
    getGraphScopeState().scope === "engaged",
  "navigating away and back must start from the engaged-only default"
);
asked.length = 0;
requestGraphScope("all");
check("and the released controller hears nothing more", asked.length === 0);

console.log("\nAll graph scope checks passed.");
process.exit(0);
