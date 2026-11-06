/**
 * The industry constellation tier: company → school → industry → Deep Space.
 *
 * Pure — no database. Run: npx tsx scripts/smoke-constellation-industry.ts
 */
import { buildConstellationClusters, toNamedGraphClusters } from "../src/lib/constellation-clusters";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const { clusters, byContactId } = buildConstellationClusters([
  { id: "rti-1", company: "RTI International", industry: "Research" },
  { id: "rti-2", company: "RTI International", industry: "Global Health" },
  { id: "unc-1", school: "UNC Chapel Hill", industry: "Global Health" },
  { id: "unc-2", school: "UNC Chapel Hill" },
  { id: "who", company: "World Health Organization", industry: "Global Health" },
  { id: "gavi", company: "Gavi", industry: "global health " },
  { id: "pharma", company: "Labcorp", industry: "Pharma & Biotech" },
  { id: "none", company: "Solo Co" },
]);
const ref = (id: string) => byContactId.get(id)!;

check("a shared company still wins over industry", ref("rti-2").kind === "company");
check("a shared school still wins over industry", ref("unc-1").kind === "school");
check(
  "single-member orgs group by a shared industry, case-insensitively",
  ref("who").kind === "industry" && ref("who").id === ref("gavi").id && ref("who").name === "Global Health"
);
check("a lone industry does not form a constellation", ref("pharma").kind !== "industry");
const named = toNamedGraphClusters(clusters);
check(
  "the industry group is a named cluster of two",
  named.some((c) => c.kind === "industry" && c.count === 2),
  JSON.stringify(named.map((c) => [c.kind, c.name, c.count]))
);
check("no singleton is named", named.every((c) => c.count >= 2));
console.log("\nAll constellation industry checks passed.");
