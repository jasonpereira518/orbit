/**
 * One name per score: Strength (1–5 rating), Closeness (computed %), Orbit (Inner/Mid/Outer
 * tier), Health. Graph rings have their own names, so "Inner orbit" means the tier only.
 * Pure: reads the label module and the files that used to carry their own copies.
 * Run: npx tsx scripts/smoke-score-vocabulary.ts
 */
import { readFileSync } from "node:fs";
import { ORBIT_TIER_LABELS, RING_LABELS } from "../src/lib/score-labels";
import { RING_LABELS as GRAPH_RINGS } from "../src/lib/graph-layout";

let failures = 0;
const fail = (m: string) => { failures++; console.error(`  FAIL ${m}`); };
const read = (f: string) => readFileSync(f, "utf8");

if (JSON.stringify(RING_LABELS) !== JSON.stringify({ 1: "Deep space", 2: "Far", 3: "Middle", 4: "Close", 5: "Core" })) fail("ring labels changed");
if (GRAPH_RINGS !== RING_LABELS) fail("graph-layout must re-export the shared ring labels");
if (Object.values(RING_LABELS).some((l) => /orbit/i.test(l))) fail("a ring label says orbit");
if (ORBIT_TIER_LABELS.inner !== "Inner orbit") fail("tier label changed");

const chart = read("src/components/dashboard/network-depth-chart.tsx");
if (/label:\s*"(Close|Warm|Cool)"/.test(chart)) fail("network-depth-chart still uses Close/Warm/Cool tier labels");
if (/Relationship strength/.test(chart)) fail("network-depth-chart heading still says Relationship strength");

const filters = read("src/components/contacts/contacts-filters.tsx");
if (/>\s*Closeness\s*</.test(filters) || /"Closeness"/.test(filters)) fail("the 1–5 filter is still labelled Closeness");

const graph = read("src/components/graph/network-graph.tsx");
if (/(Inner|Mid|Outer|Core) orbit/.test(graph)) fail("network-graph ring filter still says orbit");

const inspect = read("src/components/graph/contact-inspect-panel.tsx");
if (/By orbit/.test(inspect)) fail("contact-inspect-panel ring heading still says By orbit");
if (/\|\|\s*"Orbit"/.test(inspect)) fail("contact-inspect-panel ring fallback still says Orbit");

for (const f of [
  "src/components/dashboard/closeness-tier-badge.tsx",
  "src/components/knowledge/dossier-pane.tsx",
  "src/components/contacts/contacts-list.tsx",
  "src/components/contacts/contact-follow-up-section.tsx",
  "src/lib/graph-layout.ts",
  "src/components/graph/network-graph.tsx",
]) {
  if (/"(Inner|Mid|Outer) orbit"/.test(read(f))) fail(`${f} carries its own tier label string`);
}
if (failures) { console.error(`\n${failures} vocabulary check(s) failed`); process.exit(1); }
console.log("all vocabulary checks passed");
process.exit(0);
