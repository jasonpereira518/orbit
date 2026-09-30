/**
 * Job title → function and leadership, the rule the constellation groups people by.
 * Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-role-function.ts
 */
import {
  classifyTitle,
  roleClusterKey,
  ROLE_CLUSTER_NAMES,
  type RoleFunction,
} from "../src/lib/role-function";
import { seniorityOf } from "../src/lib/events/relevance";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const TABLE: Array<[string | null, RoleFunction, boolean]> = [
  ["Software Engineer", "engineering", false],
  ["Staff Engineer", "engineering", false],
  ["Principal Engineer", "engineering", false],
  ["Engineering Manager", "engineering", false],
  ["VP Engineering", "engineering", true],
  ["CTO", "engineering", true],
  ["Growth Engineer", "engineering", false],
  ["Product Engineer", "engineering", false],
  ["Co-founder & CEO", "founders", true],
  ["Partner", "founders", true],
  ["Managing Director", "founders", true],
  ["Owner", "founders", true],
  ["Technical Recruiting Lead", "people", false],
  ["Recruiter", "people", false],
  ["Talent Partner", "people", false],
  ["Head of Talent", "people", true],
  ["Product Manager", "product", false],
  ["Technical Program Manager", "product", false],
  ["Senior Director of Product", "product", true],
  ["Product Designer", "design", false],
  ["Design Lead", "design", false],
  ["Brand Designer", "design", false],
  ["Senior Data Scientist", "data", false],
  ["Machine Learning Engineer", "data", false],
  ["Researcher", "data", false],
  ["Account Executive", "sales", false],
  ["Sales Engineer", "sales", false],
  ["Solutions Engineer", "sales", false],
  ["Growth Marketing Manager", "marketing", false],
  ["Content Strategist", "marketing", false],
  ["Director of Operations", "operations", true],
  ["General Counsel", "operations", false],
  ["Chief of Staff", "operations", true],
  ["Product Owner", "product", false],
  ["Partner Engineer", "engineering", false],
  ["Client Partner", "other", false],
  ["Student Body President", "other", false],
  ["SVP Sales", "sales", true],
  ["Student", "other", false],
  ["", "other", false],
  [null, "other", false],
  // Weak-owner exclusions must not cancel a strong exec word; junior "Director" titles lead nobody.
  ["Founder & Product Owner", "product", true],
  ["Student Founder", "founders", true],
  ["Associate Director", "other", false],
  ["Assistant Vice President", "other", false],
  ["Art Director", "design", false],
  ["Chief People Officer", "founders", true],
  ["Head of Recruiting", "people", true],
  ["EVP Marketing", "marketing", true],
  ["SVP Engineering", "engineering", true],
  ["Owner & Creative Director", "design", true],
  ["Partner, Art Director", "design", true],
  ["President & Creative Director", "design", true],
  ["Creative Director", "design", false],
];

console.log("\nclassifyTitle");
for (const [title, fn, isLeader] of TABLE) {
  const got = classifyTitle(title);
  check(
    `${JSON.stringify(title)} → ${fn}${isLeader ? " (leader)" : ""}`,
    got.fn === fn && got.isLeader === isLeader,
    `got ${got.fn}${got.isLeader ? " (leader)" : ""}`
  );
}

console.log("\nroleClusterKey");
check("leaders group as founders", roleClusterKey({ fn: "engineering", isLeader: true }) === "founders");
check("non-leaders group by function", roleClusterKey({ fn: "design", isLeader: false }) === "design");
check("unknown function forms no cluster", roleClusterKey({ fn: "other", isLeader: false }) === null);
check("every key has a name", Object.keys(ROLE_CLUSTER_NAMES).length === 9);
check("engineers are named Engineers", ROLE_CLUSTER_NAMES.engineering === "Engineers");

console.log("\nseniorityOf is unchanged by the move");
check("recruiter first", seniorityOf("Technical Recruiting Lead") === "recruiter");
check("founder/exec", seniorityOf("Co-founder & CEO") === "founder_exec");
check("leader", seniorityOf("Staff Engineer") === "leader");
check("ic", seniorityOf("Software Engineer") === "ic");
check("unknown", seniorityOf("  ") === "unknown");

console.log("\nrole-function: all checks passed");
process.exit(0);
