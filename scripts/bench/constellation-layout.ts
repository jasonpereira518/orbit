/**
 * Time `buildHybridGraphLayout` — the whole constellation layout, sun to deep-space rim — at
 * several network sizes, and fingerprint what it produced.
 *
 * The layout runs synchronously on the main thread whenever the chart mounts or its filters
 * change, so its wall time is a frame budget the page cannot get back. The fingerprint is the
 * other half: an optimisation of the layout is only acceptable if it places every star exactly
 * where it was, and a hash of every node position and edge proves that in one line.
 *
 *   npx tsx scripts/bench/constellation-layout.ts [sizes=100,500,1000,2500,5000,10000] [--json out.json]
 *
 * No database, no env. Uses `buildSyntheticGraphPayload`, so a given size is the same network
 * on every run and every branch.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { buildHybridGraphLayout } from "../../src/lib/graph-layout";
import { buildSyntheticGraphPayload } from "../../src/lib/graph/synthetic-network";

const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const sizeArg = args.find((a, i) => !a.startsWith("--") && i !== jsonIdx + 1);
const sizes = (sizeArg ?? "100,500,1000,2500,5000,10000").split(",").map(Number);

function fingerprint(layout: ReturnType<typeof buildHybridGraphLayout>) {
  const h = createHash("sha256");
  for (const n of layout.nodes) {
    h.update(`${n.id}|${n.type}|${n.position.x.toFixed(6)}|${n.position.y.toFixed(6)}\n`);
  }
  for (const e of layout.edges) h.update(`${e.id}|${e.source}|${e.target}\n`);
  return h.digest("hex").slice(0, 16);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const results: Array<Record<string, unknown>> = [];
for (const n of sizes) {
  const payload = buildSyntheticGraphPayload(n);
  const runs = n <= 1000 ? 7 : n <= 5000 ? 3 : 1;
  const times: number[] = [];
  let layout: ReturnType<typeof buildHybridGraphLayout> | null = null;
  // One unmeasured warm-up so JIT compilation is not billed to the smallest size.
  buildHybridGraphLayout(payload.contacts.slice(0, 50), "You");
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    layout = buildHybridGraphLayout(payload.contacts, "You");
    times.push(performance.now() - t0);
  }
  const row = {
    contacts: n,
    clusters: payload.clusters.length,
    nodes: layout!.nodes.length,
    edges: layout!.edges.length,
    medianMs: Math.round(median(times) * 10) / 10,
    runs,
    fingerprint: fingerprint(layout!),
  };
  results.push(row);
  console.log(
    `${String(n).padStart(6)} contacts  ${String(row.clusters).padStart(5)} clusters  ` +
      `${String(row.nodes).padStart(6)} nodes  ${String(row.edges).padStart(5)} edges  ` +
      `${String(row.medianMs).padStart(9)} ms  (n=${runs})  ${row.fingerprint}`
  );
}

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
process.exit(0);
