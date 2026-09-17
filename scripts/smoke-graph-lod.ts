/**
 * Constellation level of detail: the band rule, and the three places that have to agree.
 *
 * A star label is 11px of text; at the fit view of a 2,000-contact sky the camera sits near
 * 0.06, which renders it under a pixel tall. Those labels were the most expensive thing on
 * the page — measured over five zoom steps in and five out, hiding them took the gesture
 * from 13,752ms of long tasks to 8,594ms, and the shipped rule lands at ~9,300ms because
 * part of the gesture legitimately crosses back into the readable band.
 *
 * The failure mode this file guards is not a wrong number, it is a silent no-op. The rule
 * spans a TypeScript constant, a class name in JSX, and a selector in `globals.css`. Rename
 * any one of them and nothing breaks, nothing looks different, and the optimisation is
 * simply gone until somebody profiles the page again. So the checks below read the other
 * two files and assert they still refer to what this module exports.
 *
 * Pure: no database, no browser.
 *
 * Run: npx tsx scripts/smoke-graph-lod.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LABEL_LOD_ZOOM,
  STAR_LABEL_CLASS,
  lodBandFor,
} from "../src/lib/graph-lod";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function main() {
  section("The band");

  check("the fit view of a large sky is far", lodBandFor(0.06) === "far");
  check("just below the threshold is far", lodBandFor(LABEL_LOD_ZOOM - 0.001) === "far");
  check(
    "the threshold itself is near",
    lodBandFor(LABEL_LOD_ZOOM) === "near",
    "the boundary has to belong to exactly one band or labels flicker on a slow zoom across it"
  );
  check("zoomed in is near", lodBandFor(2.4) === "near");
  check(
    "any non-finite scale is far",
    lodBandFor(Number.NaN) === "far" &&
      lodBandFor(Number.POSITIVE_INFINITY) === "far" &&
      lodBandFor(Number.NEGATIVE_INFINITY) === "far",
    "mid-initialisation the camera has no usable scale; far renders strictly less, so it is the safe default for every unusable value — including Infinity, which is not a scale a camera can hold"
  );
  check(
    "the threshold leaves text genuinely unreadable",
    LABEL_LOD_ZOOM * 11 < 5,
    `11px at ${LABEL_LOD_ZOOM} is ${(LABEL_LOD_ZOOM * 11).toFixed(1)}px — above ~5px this would start dropping legible labels`
  );

  section("The three places that have to agree");

  const css = read("src/app/globals.css");
  const nodes = read("src/components/graph/graph-nodes.tsx");
  const graph = read("src/components/graph/network-graph.tsx");

  check(
    "the CSS rule keys on the exported class",
    css.includes(`.${STAR_LABEL_CLASS}`),
    `globals.css has no .${STAR_LABEL_CLASS} rule — the labels would render at every zoom`
  );
  check(
    "and is scoped to the far band",
    /\[data-lod="far"\][^{]*\.constellation-star-label\s*\{[^}]*display:\s*none/.test(css),
    'expected .constellation-stage[data-lod="far"] .constellation-star-label { display: none }'
  );
  check(
    "the label element carries that class",
    nodes.includes(STAR_LABEL_CLASS),
    "graph-nodes.tsx renders no element with the class the CSS selects"
  );
  check(
    "both label variants carry it",
    (nodes.match(new RegExp(STAR_LABEL_CLASS, "g")) ?? []).length >= 2,
    "there are two label containers — the star and the comet — and both are labels"
  );
  check(
    "the stage publishes the band",
    graph.includes("lodBandFor") && graph.includes("dataset.lod"),
    "nothing writes data-lod, so the CSS rule can never match"
  );
  check(
    "display:none, not opacity",
    !/\[data-lod="far"\][^{]*\.constellation-star-label\s*\{[^}]*opacity/.test(css),
    "opacity or visibility keeps the subtree in layout, which is where the cost is"
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll graph LOD checks passed.");
  process.exit(0);
}

main();
