/**
 * The chart's shared zoom steps (src/components/graph/zoom-steps.ts): stars and cluster names
 * read the camera through two rounded steps, and only a step change may reach them. This pins
 * both halves — the rounding is the old per-node selectors' rounding, and a wheel event inside
 * one step notifies nobody.
 *
 * No DB, no network, no DOM.
 * Run: npx tsx scripts/smoke-zoom-steps.ts
 */

import { createZoomSteps } from "../src/components/graph/zoom-steps";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`ok: ${label}`);
}

// The selectors this replaced, verbatim, as the oracle.
const oldStar = (z: number) => Math.round(z * 20) / 20;
const oldName = (z: number) => Math.pow(2, Math.round(Math.log2(Math.max(z, 0.01)) * 16) / 16);

{
  let matches = true;
  for (let z = 0.001; z < 3; z *= 1.013) {
    const steps = createZoomSteps(z);
    if (steps.get("star") !== oldStar(z) || steps.get("name") !== oldName(z)) matches = false;
  }
  check("both steps round exactly as the per-node selectors did", matches);
}

{
  const steps = createZoomSteps(0.5);
  let star = 0;
  let name = 0;
  steps.subscribe("star", () => star++);
  steps.subscribe("name", () => name++);

  steps.set(0.5);
  steps.set(0.5001);
  steps.set(0.5009);
  check("camera updates inside one step notify no one", star === 0 && name === 0, `${star}/${name}`);

  steps.set(0.56);
  check("crossing a star step notifies the star channel", star === 1, String(star));
  check("the name channel moves in the same stretch", name === 1, String(name));
  check("the stored step follows", steps.get("star") === oldStar(0.56));

  let afterUnsub = 0;
  const off = steps.subscribe("star", () => afterUnsub++);
  off();
  steps.set(1.5);
  check("an unsubscribed listener is not called", afterUnsub === 0);
}

{
  // Each channel counts its own crossings: 1.00 -> 1.04 -> 1.10 crosses two star steps (0.05)
  // and, at 1/16 octave (~4.4%), at most two name steps.
  const steps = createZoomSteps(1);
  let star = 0;
  let name = 0;
  steps.subscribe("star", () => star++);
  steps.subscribe("name", () => name++);
  steps.set(1.04);
  steps.set(1.1);
  check("each channel counts its own crossings", star === 2 && name <= 2, `${star}/${name}`);
}

console.log("\nAll zoom-step smoke checks passed.\n");
process.exit(0);
