/**
 * Who belongs to which constellation: company → family satellite → role → school → fallback.
 * Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-constellation-clusters.ts
 */
import {
  buildConstellationClusters,
  toNamedGraphClusters,
  type ClusterContact,
} from "../src/lib/constellation-clusters";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const people: ClusterContact[] = [
  // Tier 1: a company cluster.
  { id: "g1", company: "Google", title: "Software Engineer" },
  { id: "g2", company: "Alphabet", title: "Product Manager" },
  // Tier 2: alone at a Google-family company — stays with the family, not with Engineers.
  { id: "dm", company: "DeepMind", title: "Research Engineer" },
  // Tier 3: engineers at one-off companies form a cross-company cluster.
  { id: "e1", company: "Acme Robotics", title: "Backend Engineer" },
  { id: "e2", company: "Nimbus Labs", title: "Software Engineer", school: "MIT" },
  // Leaders at one-off companies: Founders & Execs.
  { id: "f1", company: "Tiny Startup", title: "Co-founder & CEO" },
  { id: "f2", company: "Other Startup", title: "CTO" },
  // Tier 4: unknown titles, one school in two spellings (majority spelling names it).
  { id: "s1", company: "Solo Co", title: "Student", school: "Massachusetts Institute of Technology" },
  { id: "s2", title: null, school: "MIT" },
  { id: "s3", title: "Intern", school: "MIT" },
  // Fallbacks.
  { id: "lone", company: "Lonely LLC", title: "Chef" },
  { id: "lone-school", title: null, school: "Tiny College" },
  { id: "void" },
];

const { clusters, byContactId } = buildConstellationClusters(people);
const home = (id: string) => byContactId.get(id)!;

console.log("\nTiers");
check("aliases collapse into one company cluster", home("g1").id === home("g2").id && home("g1").kind === "company");
check("family satellite keeps its own company ref", home("dm").kind === "company" && home("dm").name === "Google DeepMind");
check("one-off engineers share Engineers", home("e1").id === "role:engineering" && home("e2").id === "role:engineering");
check("role cluster is named", home("e1").name === "Engineers" && home("e1").kind === "role");
check("role beats school (e2 went to MIT but is an engineer)", home("e2").kind === "role");
check("leaders at one-off companies are Founders & Execs", home("f1").id === "role:founders" && home("f2").id === "role:founders");
check("spellings of one school cluster together", home("s1").id === home("s2").id && home("s2").id === home("s3").id);
check("school cluster takes the majority spelling", home("s1").name === "MIT" && home("s1").kind === "school");
check("singleton company falls back to its own ref", home("lone").kind === "company" && home("lone").name === "Lonely LLC");
check("singleton school falls back to its own ref", home("lone-school").kind === "school" && home("lone-school").name === "Tiny College");
check("nothing at all is Deep Space", home("void").kind === "other");
check("every contact has exactly one home", byContactId.size === people.length);

console.log("\nClusters");
const mit = clusters.find((c) => c.id === home("s1").id)!;
check("school cluster counts all three spellings", mit.count === 3);
check(
  "sorted by size, then kind, then name",
  clusters.every((c, i) => i === 0 || clusters[i - 1].count >= c.count)
);
check(
  "named clusters include role clusters and drop Deep Space",
  toNamedGraphClusters(clusters).some((c) => c.kind === "role") &&
    !toNamedGraphClusters(clusters).some((c) => (c.kind as string) === "other")
);
const again = buildConstellationClusters(people);
check("deterministic", JSON.stringify(again.clusters) === JSON.stringify(clusters));

console.log("\nconstellation-clusters: all checks passed");
process.exit(0);
