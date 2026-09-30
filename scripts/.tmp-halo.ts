import { buildSyntheticGraphPayload } from "../src/lib/graph/synthetic-network";
import { buildHybridGraphLayout } from "../src/lib/graph-layout";
for (const n of [150, 1000, 10000]) {
  const c = buildSyntheticGraphPayload(n, { seed: 1 }).contacts;
  const L = buildHybridGraphLayout(c, "x");
  let far = 0;
  for (const nd of L.nodes) if (nd.type === "contact") far = Math.max(far, Math.hypot(nd.position.x, nd.position.y));
  console.log(n, "diskRadius", L.galaxy.diskRadius.toFixed(0), "farthest", far.toFixed(0), "ratio", (far / L.galaxy.diskRadius).toFixed(2));
}
