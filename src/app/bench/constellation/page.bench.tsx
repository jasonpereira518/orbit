import { ConstellationBench } from "./constellation-bench";

/**
 * The constellation, fed a synthetic network of `?n=` contacts, for measuring.
 *
 * Only compiled into a build made with ORBIT_BENCH=1 (see `pageExtensions` in next.config.ts),
 * so no deployment ever has this route. It sits outside the (clerk) group because a production
 * build run locally has no Clerk keys, and the benchmark has to measure production React, not
 * the development build's extra checks.
 *
 * Driven by `scripts/bench/constellation-browser.mjs`.
 */
export default function ConstellationBenchPage() {
  return <ConstellationBench />;
}
