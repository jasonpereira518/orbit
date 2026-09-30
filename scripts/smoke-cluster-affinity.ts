/**
 * Which constellations are related — the pulls that place clusters near each other.
 * Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-cluster-affinity.ts
 */
import { buildConstellationClusters } from "../src/lib/constellation-clusters";
import {
  AFFINITY,
  buildClusterAffinity,
  type AffinityContact,
  type AffinityEdge,
} from "../src/lib/constellation-affinity";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

type P = AffinityContact & { company?: string | null; title?: string | null };
const person = (id: string, company: string | null, extra: Partial<P> = {}): P => ({
  id,
  company,
  ...extra,
});

function affinityOf(contacts: P[]): AffinityEdge[] {
  const { clusters, byContactId } = buildConstellationClusters(contacts);
  const eligible = clusters.filter((c) => c.kind !== "other" && c.count >= 2);
  return buildClusterAffinity(contacts, byContactId, eligible);
}
const find = (edges: AffinityEdge[], a: string, b: string) =>
  edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));

console.log("\nFamily");
{
  const edges = affinityOf([
    person("g1", "Google"),
    person("g2", "Google"),
    person("d1", "Google DeepMind"),
    person("d2", "Google DeepMind"),
    person("s1", "Stripe"),
    person("s2", "Stripe"),
  ]);
  const gd = find(edges, "company:google", "company:google deepmind");
  check("Google and DeepMind are related", Boolean(gd));
  check("family is a strong pull", (gd?.weight ?? 0) >= AFFINITY.family);
  check("a family edge is kind family", gd?.kind === "family", String(gd?.kind));
  check("unrelated companies are not", !find(edges, "company:google", "company:stripe"));
}

console.log("\nAlumni");
{
  const edges = affinityOf([
    person("a1", "Acme", { school: "MIT" }),
    person("a2", "Acme", { school: "Massachusetts Institute of Technology" }),
    person("a3", "Acme"),
    person("b1", "Beta", { school: "M.I.T." }),
    person("b2", "Beta", { school: "MIT" }),
    person("b3", "Beta"),
    person("c1", "Gamma"),
    person("c2", "Gamma"),
    person("c3", "Gamma"),
  ]);
  const ab = find(edges, "company:acme", "company:beta");
  check("two companies sharing a school (in any spelling) are related", Boolean(ab));
  // min(2 alumni, 2 alumni) / sqrt(3 members * 3 members) = 2/3
  check("weight is shared alumni over √(sizes)", Math.abs((ab?.weight ?? 0) - (2 / 3) * AFFINITY.alumni) < 1e-9, String(ab?.weight));
  check("an alumni-only edge is kind alumni", ab?.kind === "alumni", String(ab?.kind));
  check("a company with no shared school is not pulled in", !find(edges, "company:acme", "company:gamma"));
}

console.log("\nTags and interests");
{
  const contacts: P[] = [
    person("x1", "Xco", { tags: ["Climbing", "friend"] }),
    person("x2", "Xco"),
    person("y1", "Yco", { sharedInterests: ["climbing"], tags: ["friend"] }),
    person("y2", "Yco"),
  ];
  // "friend" spans 27 clusters: too generic to mean anything.
  for (let i = 0; i < 25; i++) {
    contacts.push(person(`z${i}-1`, `Zco${i}`, { tags: ["friend"] }), person(`z${i}-2`, `Zco${i}`));
  }
  const edges = affinityOf(contacts);
  const xy = find(edges, "company:xco", "company:yco");
  check("a rare shared value relates two clusters", Boolean(xy));
  // one shared value / sqrt(2*2) = 0.5, times the tag coefficient
  check("weight is shared values over √(sizes)", Math.abs((xy?.weight ?? 0) - 0.5 * AFFINITY.tags) < 1e-9, String(xy?.weight));
  check("a tags-only edge is kind tags", xy?.kind === "tags", String(xy?.kind));
  check("a generic value (>20 clusters) relates nothing", !find(edges, "company:xco", "company:zco0"));
}

console.log("\nKind is the dominant contributor");
{
  // Google and DeepMind are family (1) and also share a school (2/3): family dominates.
  const edges = affinityOf([
    person("g1", "Google", { school: "MIT" }),
    person("g2", "Google", { school: "MIT" }),
    person("g3", "Google"),
    person("d1", "Google DeepMind", { school: "MIT" }),
    person("d2", "Google DeepMind", { school: "MIT" }),
    person("d3", "Google DeepMind"),
  ]);
  const gd = find(edges, "company:google", "company:google deepmind");
  check("family plus alumni is kind family", gd?.kind === "family" && (gd?.weight ?? 0) > 1, JSON.stringify(gd));
}

console.log("\nBounds and determinism");
{
  const contacts: P[] = [];
  for (let i = 0; i < 30; i++) {
    const n = String(i).padStart(2, "0");
    contacts.push(person(`m${n}-1`, `Co${n}`, { school: "MIT" }), person(`m${n}-2`, `Co${n}`));
  }
  const edges = affinityOf(contacts);
  check("a school shared by 30 clusters is capped to the 24 largest", !edges.some((e) => e.a === "company:co29" || e.b === "company:co29"));
  check("edges are capped per cluster (≤ 8 kept from each side)", edges.length <= 24 * AFFINITY.perCluster, String(edges.length));
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  check("every kept cluster still has its 8 strongest links", [...degree.values()].every((d) => d >= AFFINITY.perCluster));
  check("sorted by weight, then ids", edges.every((e, i) => i === 0 || edges[i - 1].weight >= e.weight));
  const again = affinityOf(contacts);
  check("deterministic", JSON.stringify(again) === JSON.stringify(edges));
  const reversed = affinityOf([...contacts].reverse());
  check("independent of contact order", JSON.stringify(reversed) === JSON.stringify(edges));
}

console.log("\nSums do not depend on contact order");
{
  // Two clusters related three ways (two schools and a rare tag), several more sharing some of
  // them: each pair's weight is a float sum of irrational terms, so a different accumulation
  // order shows up as a last-digit difference.
  const contacts: P[] = [];
  const sizes = [3, 5, 7, 4, 6, 9];
  sizes.forEach((n, k) => {
    for (let i = 0; i < n; i++) {
      const school = (k + i) % 3 === 0 ? "MIT" : (k + i) % 3 === 1 ? "Stanford" : undefined;
      const tags = i % 2 === 0 ? ["climbing"] : k % 2 === 0 ? ["jazz", "climbing"] : ["jazz"];
      contacts.push(person(`k${k}-${i}`, `Firm ${k}`, { school, tags }));
    }
  });
  const forward = affinityOf(contacts);
  check("the network has related clusters", forward.length > 5, String(forward.length));
  for (const order of [[...contacts].reverse(), [...contacts].sort((a, b) => (a.id < b.id ? 1 : -1))]) {
    check("affinity is byte-identical whatever the contact order", JSON.stringify(affinityOf(order)) === JSON.stringify(forward));
  }
}

console.log("\ncluster-affinity: all checks passed");
process.exit(0);
