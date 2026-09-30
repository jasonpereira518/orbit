/**
 * The fit: which stars trace which figure, per part. Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-constellation-fit.ts
 */
import {
  buildConstellationFit,
  constellationFitEdges,
  RING_SHAPE,
} from "../src/lib/constellation-fit";
import { RING_CAPACITY } from "../src/lib/graph/cluster-anatomy";
import type { GraphContactInput } from "../src/lib/graph-layout";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

let n = 0;
function person(over: Partial<GraphContactInput>): GraphContactInput {
  n += 1;
  return {
    id: `p${String(n).padStart(3, "0")}`,
    fullName: `Person ${n}`,
    company: null,
    title: null,
    relationshipScore: 3,
    lastInteractionAt: "2026-08-20T00:00:00.000Z",
    nextFollowUpAt: null,
    tags: [],
    aiSummary: null,
    keyFacts: null,
    orbitScore: 1 + (n % 5),
    ...over,
  };
}
const group = (count: number, over: Partial<GraphContactInput>) => Array.from({ length: count }, () => person(over));

const contacts: GraphContactInput[] = [
  // A company big enough to split: 3 leaders, 10 engineers, 7 designers, 5 sales.
  ...group(1, { company: "Northwind", title: "VP Engineering", school: "MIT" }),
  ...group(1, { company: "Northwind", title: "CTO" }),
  ...group(1, { company: "Northwind", title: "Co-founder" }),
  ...group(10, { company: "Northwind", title: "Software Engineer" }).map((c, i) => ({ ...c, school: i % 2 ? "MIT" : i % 3 ? "Waterloo" : null })),
  ...group(7, { company: "Northwind", title: "Product Designer" }),
  ...group(5, { company: "Northwind", title: "Account Executive" }),
  // A plain company, a pair, a school, a big school.
  ...group(6, { company: "Plainco" }),
  ...group(2, { company: "Pairco" }),
  ...group(14, { school: "Chapel Hill" }),
  ...group(60, { school: "State U" }),
];
const fit = buildConstellationFit(contacts);
const byName = (name: string) => [...fit.fits.values()].find((f) => f.cluster.name === name)!;

console.log("\nForms");
{
  check("Northwind is split into petals", byName("Northwind").form === "petal");
  check("Plainco stays a figure", byName("Plainco").form === "figure");
  check("Pairco is a binary", byName("Pairco").form === "binary");
  check("Chapel Hill is a ring", byName("Chapel Hill").form === "ring");
  check("State U is a ring", byName("State U").form === "ring");
}

console.log("\nParts");
{
  const nw = byName("Northwind");
  check("Northwind has a core and three petals", nw.parts.map((p) => p.key).join() === "core,petal:engineering,petal:design,petal:sales");
  check("every member is in exactly one part, as figure or scatter", JSON.stringify(nw.parts.flatMap((p) => [...p.figureMemberIds, ...p.scatterMemberIds]).sort()) === JSON.stringify([...nw.cluster.contactIds].sort()));
  check("each part's figure is at most its shape's size and at most 9", nw.parts.every((p) => p.figureMemberIds.length === Math.min(p.shape.stars.length, p.figureMemberIds.length) && p.figureMemberIds.length <= 9));
  const eng = nw.parts.find((p) => p.key === "petal:engineering")!;
  check("a petal with 10 members traces a 9-star figure and scatters one", eng.figureMemberIds.length === 9 && eng.scatterMemberIds.length === 1);
  check("the aggregates are the parts joined", nw.figureMemberIds.join() === nw.parts.flatMap((p) => p.figureMemberIds).join() && nw.shape === nw.parts[0].shape);

  const plain = byName("Plainco");
  check("a figure has one 'main' part holding all 6 members", plain.parts.length === 1 && plain.parts[0].key === "main" && plain.figureMemberIds.length + plain.scatterMemberIds.length === 6 && plain.figureMemberIds.length <= 9);

  const ring = byName("Chapel Hill");
  check("a ring's members are all figure stars on the ring shape", ring.parts[0].shape === RING_SHAPE && ring.figureMemberIds.length === 14 && ring.scatterMemberIds.length === 0);
  const big = byName("State U");
  check("a huge school scatters what the rings cannot hold", big.figureMemberIds.length === RING_CAPACITY && big.scatterMemberIds.length === 60 - RING_CAPACITY);
}

console.log("\nEdges");
{
  const edges = constellationFitEdges(fit);
  const ofCluster = (name: string) => edges.filter((e) => e.clusterName === name);
  check("a ring draws no lines", ofCluster("Chapel Hill").length === 0 && ofCluster("State U").length === 0);
  check("a figure draws lines", ofCluster("Plainco").length > 0);
  const nw = byName("Northwind");
  const partOf = new Map<string, string>();
  for (const p of nw.parts) for (const id of p.figureMemberIds) partOf.set(id, p.key);
  const nwEdges = ofCluster("Northwind");
  check("petal clusters draw lines", nwEdges.length > 0);
  check("a line never joins two different parts", nwEdges.every((e) => partOf.get(e.source) === partOf.get(e.target)));
}

console.log("\nStability");
{
  const again = buildConstellationFit(contacts);
  check("deterministic", JSON.stringify([...again.fits.entries()]) === JSON.stringify([...fit.fits.entries()]));
  const reversed = buildConstellationFit([...contacts].reverse());
  const sig = (f: typeof fit) => JSON.stringify([...f.fits.entries()].sort().map(([id, x]) => [id, x.form, x.parts.map((p) => [p.key, p.shape.id, p.figureMemberIds, p.scatterMemberIds])]));
  check("independent of contact order", sig(reversed) === sig(fit));
  const knot = byName("Northwind").parts.find((p) => p.key === "petal:engineering")!;
  const schools = knot.figureMemberIds.map((id) => contacts.find((c) => c.id === id)!.school ?? null);
  let runs = 0;
  for (let i = 0; i < schools.length; i++) if (schools[i] && schools[i] !== schools[i - 1]) runs += 1;
  const distinct = new Set(schools.filter(Boolean)).size;
  check(`classmates sit on adjacent stars (${runs} runs for ${distinct} schools)`, runs === distinct);
}

console.log("\nconstellation-fit: all checks passed");
process.exit(0);
