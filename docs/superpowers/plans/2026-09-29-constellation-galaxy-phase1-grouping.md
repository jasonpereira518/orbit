# Constellation Galaxy — Phase 1: Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the company → school → Deep Space cluster assignment with the five-tier model (company → family satellite → role → normalized school → fallback), shipping on the current sky-atlas layout.

**Architecture:** Two new pure modules — `role-function.ts` (job title → function + leader flag) and `school-key.ts` (school-name normalization and grouping) — feed a rewritten `buildConstellationClusters` in `constellation-clusters.ts`. A new cluster kind, `"role"`, is threaded through the payload type, cluster colour, peer-edge reasons and layout edges. Layout geometry is untouched; role clusters render as ordinary figures until the later phases.

**Tech Stack:** TypeScript, Next.js app (read `node_modules/next/dist/docs/` before touching any Next API — none expected here), smoke scripts run with `npx tsx`, suite runner `scripts/run-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-29-constellation-galaxy-design.md` (section 1, "Grouping model"; build phase 1).

## Global Constraints

- Tier order, first match wins: company (≥2) → family satellite → role (≥2) → school (≥2) → fallback (own singleton company/school ref, else Deep Space).
- Unknown function (`"other"`) never forms a role cluster.
- Role cluster names exactly: `Founders & Execs`, `Engineers`, `Product`, `Designers`, `Data & Research`, `Sales & BD`, `Marketing`, `People & Recruiting`, `Operations`.
- `isLeader` = VP / Head of / Director / C-suite / Founder / Partner / President / Owner / Managing Director. Plain `Manager`, `Lead`, `Staff`, `Principal` are NOT leaders.
- Recruiter titles are checked first ("Technical Recruiting Lead" is a recruiter).
- `seniorityOf()` in `src/lib/events/relevance.ts` must behave byte-for-byte as before (regexes move, they do not change).
- School display name = the most common raw spelling among the cluster's members; ties broken by `localeCompare`.
- No new DB queries, no new payload fields (`loadGraphData` is at its statement cap).
- Deterministic output: same input → same clusters, same order.
- Every new `scripts/smoke-*.ts` must be registered in `scripts/run-smoke.ts` (an unregistered smoke fails `--check`).
- Worktree: run commands from `/Users/jasonpereira/Projects/claude-worktrees/orbit/constellation-render-clustering-b81406`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Out of scope here (later phases): affinity weights, per-member petal annotations, any geometry or rendering change.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `src/lib/role-function.ts` | Title → `{ fn, isLeader }`; role cluster key + names; owns the `FOUNDER_EXEC` / `LEADER` / `RECRUITER` regexes. |
| Create `src/lib/school-key.ts` | `schoolKeys()` (moved verbatim) and `schoolGroupKeys()` (raw spellings → one group key). |
| Modify `src/lib/events/relevance.ts` | Import the regexes and `schoolKeys` instead of defining them. |
| Modify `src/lib/constellation-clusters.ts` | Five-tier assignment; `ClusterKind` gains `"role"`. |
| Modify `src/lib/graph-data.ts` | `GraphCluster.kind` gains `"role"`. |
| Modify `src/lib/school-color.ts` | `clusterBrandColor` returns a neutral colour for `"role"`. |
| Modify `src/lib/network-metrics.ts` | `PeerEdgeReason` gains `"role"`. |
| Modify `src/lib/graph-layout.ts` | Edge `reason` union gains `"role"`; figure edges map kind → reason properly. |
| Create `scripts/smoke-role-function.ts`, `scripts/smoke-school-key.ts`, `scripts/smoke-constellation-clusters.ts` | Pure-tier specs. |
| Modify `scripts/smoke-graph-layout.ts` | Fixture gains a role pair; kind assertion updated. |
| Modify `scripts/run-smoke.ts` | Register the three new smokes as `"pure"`. |

---

### Task 1: Title → function classifier

**Files:**
- Create: `src/lib/role-function.ts`
- Modify: `src/lib/events/relevance.ts:117-122`
- Test: `scripts/smoke-role-function.ts`
- Modify: `scripts/run-smoke.ts` (registry, next to `"smoke-graph-layout": "pure"`)

**Interfaces:**
- Produces:
  - `type RoleFunction = "founders" | "engineering" | "product" | "design" | "data" | "sales" | "marketing" | "people" | "operations" | "other"`
  - `type RoleClusterKey = Exclude<RoleFunction, "other">`
  - `type TitleRole = { fn: RoleFunction; isLeader: boolean }`
  - `function classifyTitle(title: string | null | undefined): TitleRole`
  - `function roleClusterKey(role: TitleRole): RoleClusterKey | null`
  - `const ROLE_CLUSTER_NAMES: Record<RoleClusterKey, string>`
  - `const FOUNDER_EXEC: RegExp`, `const LEADER: RegExp`, `const RECRUITER: RegExp` (moved from relevance.ts, unchanged)

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-role-function.ts`:

```ts
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
  ["Student", "other", false],
  ["", "other", false],
  [null, "other", false],
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/smoke-role-function.ts`
Expected: FAIL — `Cannot find module '../src/lib/role-function'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/role-function.ts`:

```ts
/**
 * What someone does, read from their job title — the rule the constellation groups by.
 *
 * Deterministic regexes, no model call: this runs for every contact on every layout. Order
 * matters and is the whole design:
 *   - Recruiting is checked FIRST. "Technical Recruiting Lead" is a recruiter; reading it as an
 *     engineer or a lead files the most useful person at a careers fair under the wrong group.
 *   - Specific functions before general ones: "Sales Engineer" is sales, "Machine Learning
 *     Engineer" is data, "Product Designer" is design, "Product Engineer" is engineering.
 *   - Leadership is a flag beside the function, not a function: a VP Engineering is an engineer
 *     who leads. Only titles that match no function at all ("CEO", "Partner") become founders.
 */

export type RoleFunction =
  | "founders"
  | "engineering"
  | "product"
  | "design"
  | "data"
  | "sales"
  | "marketing"
  | "people"
  | "operations"
  | "other";

export type RoleClusterKey = Exclude<RoleFunction, "other">;

export type TitleRole = { fn: RoleFunction; isLeader: boolean };

export const ROLE_CLUSTER_NAMES: Record<RoleClusterKey, string> = {
  founders: "Founders & Execs",
  engineering: "Engineers",
  product: "Product",
  design: "Designers",
  data: "Data & Research",
  sales: "Sales & BD",
  marketing: "Marketing",
  people: "People & Recruiting",
  operations: "Operations",
};

// Shared with `seniorityOf` in src/lib/events/relevance.ts — moved here, not changed.
export const FOUNDER_EXEC =
  /\b(founder|co-?founder|ceo|cto|coo|cfo|cpo|cmo|chief|president|partner|managing director|owner)\b/i;
export const LEADER = /\b(head of|vp|vice president|director|principal|lead|manager|staff)\b/i;
export const RECRUITER =
  /\b(recruit(?:er|ing)|talent|sourcer|people ops|hr|human resources|campus|university relations|hiring)\b/i;

/**
 * Senior enough for a company's leadership core. Deliberately narrower than LEADER: a manager,
 * a lead or a staff engineer is not who the core of a 300-person company should be.
 */
const EXECUTIVE = /\b(head of|s?vp|evp|vice president|director)\b/i;
/** For recruiters, "partner" is a job title ("Talent Partner"), not an ownership stake. */
const RECRUITER_EXEC = /\b(chief|co-?founder|founder)\b/i;

const FUNCTION_RULES: Array<[RoleClusterKey, RegExp]> = [
  ["design", /\b(design(?:er)?|ux|creative director|art director|illustrator)\b/i],
  ["data", /\b(data|scientist|research(?:er)?|machine learning|ml|statistician)\b/i],
  [
    "sales",
    /\b(sales|account executive|account manager|business development|bdr|sdr|partnerships|customer success|solutions engineer)\b/i,
  ],
  ["engineering", /\b(engineer(?:ing)?|developer|swe|sde|programmer|architect|devops|sre|software|cto)\b/i],
  ["marketing", /\b(marketing|marketer|growth|brand|content|communications|comms|community|cmo)\b/i],
  ["product", /\b(product|pm|program manager|cpo)\b/i],
  [
    "operations",
    /\b(operations|ops|finance|financial|accounting|accountant|legal|counsel|lawyer|attorney|coo|cfo|chief of staff|administrator)\b/i,
  ],
];

export function classifyTitle(title: string | null | undefined): TitleRole {
  const value = title?.trim();
  if (!value) return { fn: "other", isLeader: false };
  if (RECRUITER.test(value)) {
    return { fn: "people", isLeader: EXECUTIVE.test(value) || RECRUITER_EXEC.test(value) };
  }
  const isLeader = FOUNDER_EXEC.test(value) || EXECUTIVE.test(value);
  for (const [fn, pattern] of FUNCTION_RULES) {
    if (pattern.test(value)) return { fn, isLeader };
  }
  return { fn: isLeader ? "founders" : "other", isLeader };
}

/** The cross-company role cluster a person would join, or null when their function is unknown. */
export function roleClusterKey(role: TitleRole): RoleClusterKey | null {
  if (role.isLeader) return "founders";
  return role.fn === "other" ? null : role.fn;
}
```

In `src/lib/events/relevance.ts`, delete the three constant definitions at lines 117–122 (`FOUNDER_EXEC`, `LEADER`, `RECRUITER`) and add to the imports at the top of the file:

```ts
import { FOUNDER_EXEC, LEADER, RECRUITER } from "@/lib/role-function";
```

- [ ] **Step 4: Register the smoke**

In `scripts/run-smoke.ts`, add beside `"smoke-graph-layout": "pure",`:

```ts
  "smoke-role-function": "pure",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-role-function.ts && npx tsx scripts/smoke-event-relevance.ts`
Expected: both end with their pass line; no `failed`.

If a table row fails, fix the regex order in `FUNCTION_RULES`, not the table — the table is the spec. Only change a row if it contradicts the Global Constraints.

- [ ] **Step 6: Commit**

```bash
git add src/lib/role-function.ts src/lib/events/relevance.ts scripts/smoke-role-function.ts scripts/run-smoke.ts
git commit -m "feat(constellation): classify job titles into function + leadership

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: School-name grouping

**Files:**
- Create: `src/lib/school-key.ts`
- Modify: `src/lib/events/relevance.ts:155-176` (remove `SCHOOL_NOISE` and `schoolKeys`, import instead)
- Test: `scripts/smoke-school-key.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Produces:
  - `function schoolKeys(value: string): string[]` (moved verbatim from relevance.ts)
  - `function schoolGroupKeys(values: Iterable<string>): Map<string, string>` — raw trimmed spelling → group key; spellings with no usable words are absent from the map.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-school-key.ts`:

```ts
/**
 * School-name normalization: the spellings of one school become one constellation.
 * Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-school-key.ts
 */
import { schoolGroupKeys, schoolKeys } from "../src/lib/school-key";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function sameGroup(values: string[], a: string, b: string) {
  const groups = schoolGroupKeys(values);
  return groups.get(a) !== undefined && groups.get(a) === groups.get(b);
}

const ALL = [
  "MIT",
  "Massachusetts Institute of Technology",
  "M.I.T.",
  "Stanford",
  "Stanford University",
  "UNC",
  "University of North Carolina",
  "Boston University",
  "Boston College",
  "University of Toronto",
  "University of Texas",
  "UT",
  "Waterloo",
  "University of Waterloo",
  "   ",
];

console.log("\nschoolGroupKeys");
check("MIT = Massachusetts Institute of Technology", sameGroup(ALL, "MIT", "Massachusetts Institute of Technology"));
check("M.I.T. = MIT", sameGroup(ALL, "M.I.T.", "MIT"));
check("Stanford = Stanford University", sameGroup(ALL, "Stanford", "Stanford University"));
check("UNC = University of North Carolina", sameGroup(ALL, "UNC", "University of North Carolina"));
check("Waterloo = University of Waterloo", sameGroup(ALL, "Waterloo", "University of Waterloo"));
check("Boston University ≠ Boston College", !sameGroup(ALL, "Boston University", "Boston College"));
check("University of Toronto ≠ University of Texas", !sameGroup(ALL, "University of Toronto", "University of Texas"));
check(
  "an ambiguous acronym (UT) joins neither",
  !sameGroup(ALL, "UT", "University of Toronto") && !sameGroup(ALL, "UT", "University of Texas")
);
check("blank spelling has no group", schoolGroupKeys(ALL).get("   ") === undefined);
check(
  "deterministic regardless of input order",
  JSON.stringify([...schoolGroupKeys(ALL)].sort()) ===
    JSON.stringify([...schoolGroupKeys([...ALL].reverse())].sort())
);

console.log("\nschoolKeys is unchanged by the move");
check("long form + acronym", JSON.stringify(schoolKeys("University of North Carolina")) === JSON.stringify(["university north carolina", "unc"]));
check("short form", JSON.stringify(schoolKeys("MIT")) === JSON.stringify(["mit"]));
check("empty", schoolKeys("  ").length === 0);

console.log("\nschool-key: all checks passed");
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/smoke-school-key.ts`
Expected: FAIL — `Cannot find module '../src/lib/school-key'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/school-key.ts`. Copy `SCHOOL_NOISE` and `schoolKeys` (with its doc comment) **verbatim** from `src/lib/events/relevance.ts:155-176`, exported, then add the grouping:

```ts
/** Words that carry no identity in a school's name. */
const SCHOOL_NOISE = /\b(the|of|at|and|for|a)\b/g;

/**
 * The forms one school might be written in.
 * (doc comment copied verbatim from relevance.ts)
 */
export function schoolKeys(value: string): string[] {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];

  const words = cleaned.replace(SCHOOL_NOISE, " ").split(/\s+/).filter(Boolean);
  const keys = new Set<string>();
  if (words.length > 0) keys.add(words.join(" "));
  if (words.length > 1) keys.add(words.map((word) => word[0]).join(""));
  if (words.length === 1) keys.add(words[0]!);
  return [...keys];
}

function schoolWords(value: string): string[] {
  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(SCHOOL_NOISE, " ")
    .split(/\s+/)
    .filter(Boolean);
  // "M.I.T." cleans to "m i t": letters written apart are one short form.
  return words.length > 1 && words.every((w) => w.length === 1) ? [words.join("")] : words;
}

/**
 * Which spellings are the same school, for clustering.
 *
 * Stricter than `schoolKeys` on purpose. Matching is for "does this attendee share a school",
 * where a rare false positive costs one point; clustering merges whole groups of people, where a
 * false positive puts Boston University inside Boston College. So:
 *   - A long form's identity is its words minus "university": "Stanford University" and
 *     "Stanford" meet, "Boston University" and "Boston College" do not.
 *   - A one-word short form ("MIT", "UNC") joins the long form whose acronym it is — but only
 *     when exactly one long form in this network has that acronym. "UT" beside both Toronto and
 *     Texas joins neither.
 * Returns raw spelling → group key. Spellings with no usable words are absent.
 */
export function schoolGroupKeys(values: Iterable<string>): Map<string, string> {
  const distinct = [...new Set(values)];
  const parsed = distinct.map((raw) => {
    const words = schoolWords(raw);
    const core = words.filter((w) => w !== "university").join(" ") || words.join(" ");
    return { raw, words, core };
  });

  const coresByAcronym = new Map<string, Set<string>>();
  for (const { words, core } of parsed) {
    if (words.length < 2) continue;
    const acronym = words.map((w) => w[0]).join("");
    const cores = coresByAcronym.get(acronym);
    if (cores) cores.add(core);
    else coresByAcronym.set(acronym, new Set([core]));
  }

  const out = new Map<string, string>();
  for (const { raw, words, core } of parsed) {
    if (words.length === 0) continue;
    const longForms = words.length === 1 ? coresByAcronym.get(words[0]!) : undefined;
    out.set(raw, longForms && longForms.size === 1 ? [...longForms][0]! : core);
  }
  return out;
}
```

In `src/lib/events/relevance.ts`, delete `SCHOOL_NOISE` and `schoolKeys` (lines 155–176 incl. comments) and add:

```ts
import { schoolKeys } from "@/lib/school-key";
```

- [ ] **Step 4: Register the smoke**

In `scripts/run-smoke.ts`, beside the entry added in Task 1:

```ts
  "smoke-school-key": "pure",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-school-key.ts && npx tsx scripts/smoke-event-relevance.ts`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/school-key.ts src/lib/events/relevance.ts scripts/smoke-school-key.ts scripts/run-smoke.ts
git commit -m "feat(constellation): group spellings of one school together

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Five-tier cluster assignment

**Files:**
- Modify: `src/lib/constellation-clusters.ts` (rewrite `buildConstellationClusters`, remove the unused `assignCluster` export, extend `ClusterKind`)
- Test: `scripts/smoke-constellation-clusters.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `classifyTitle`, `roleClusterKey`, `ROLE_CLUSTER_NAMES` (Task 1); `schoolGroupKeys` (Task 2); `canonicalCompanyClusterName`, `companyFamilyRoot` from `@/lib/company-family`.
- Produces:
  - `type ClusterKind = "company" | "role" | "school" | "other"`
  - `type ClusterContact = { id: string; company?: string | null; school?: string | null; title?: string | null }`
  - `buildConstellationClusters(contacts: ClusterContact[]): { clusters: BuiltCluster[]; byContactId: Map<string, ClusterRef> }` — same signature; clusters sorted by count desc, then kind rank (company, role, school, other), then name.
  - Role cluster ids: `role:<key>` (e.g. `role:engineering`). School cluster ids: `school:<group key>`.
  - `toNamedGraphClusters` keeps every kind except `"other"`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-constellation-clusters.ts`:

```ts
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
    !toNamedGraphClusters(clusters).some((c) => c.kind === "other")
);
const again = buildConstellationClusters(people);
check("deterministic", JSON.stringify(again.clusters) === JSON.stringify(clusters));

console.log("\nconstellation-clusters: all checks passed");
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/smoke-constellation-clusters.ts`
Expected: FAIL — first failing check is `family satellite keeps its own company ref` or `one-off engineers share Engineers` (today's code has no role tier), or a TypeScript error for `title` on `ClusterContact`.

- [ ] **Step 3: Rewrite `src/lib/constellation-clusters.ts`**

Replace the file's contents with:

```ts
/**
 * Constellation cluster assignment. Every contact gets exactly one home; first match wins:
 *
 *   1. Company — ≥2 contacts share the canonical company (AWS ↔ Amazon Web Services collapse).
 *   2. Family satellite — alone at a company whose family (`companyFamilyRoot`) already has a
 *      company cluster: keeps its own company ref, and the layout seats it in that family's
 *      field (`familySatellites` in graph-layout.ts). A sister company is a stronger tie than a
 *      shared function, so the lone DeepMind engineer sits by Google, not in Engineers.
 *   3. Role — ≥2 of the rest share a function (role-function.ts): a cross-company cluster such
 *      as Engineers or Founders & Execs. An unknown function never forms one.
 *   4. School — ≥2 of what remains share a school, spellings grouped (school-key.ts).
 *   5. Otherwise their own singleton company or school ref, or Deep Space. Singletons are not
 *      constellations (`isWedgeEligible`) and scatter as background stars.
 *
 * Every count is taken over the people still unassigned at that tier, so a tier only groups
 * people nobody earlier claimed.
 */

import {
  canonicalCompanyClusterName,
  companyFamilyRoot,
} from "@/lib/company-family";
import {
  classifyTitle,
  roleClusterKey,
  ROLE_CLUSTER_NAMES,
  type RoleClusterKey,
} from "@/lib/role-function";
import { schoolGroupKeys } from "@/lib/school-key";

export type ClusterKind = "company" | "role" | "school" | "other";

export type ClusterRef = {
  /** Stable map key */
  id: string;
  /** Display name on the map */
  name: string;
  kind: ClusterKind;
};

export type ClusterContact = {
  id: string;
  company?: string | null;
  school?: string | null;
  title?: string | null;
};

const DEEP_SPACE = "Deep Space";

function trimLabel(value: string | null | undefined) {
  return (value || "").trim();
}

function normalizeKey(kind: ClusterKind, name: string) {
  return `${kind}:${name.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/** Company label used for clustering — aliases collapse to one name. */
function companyClusterLabel(raw: string | null | undefined): string {
  return canonicalCompanyClusterName(raw) || trimLabel(raw);
}

function companyRef(company: string): ClusterRef {
  return { id: normalizeKey("company", company), name: company, kind: "company" };
}

function roleRef(key: RoleClusterKey): ClusterRef {
  return { id: normalizeKey("role", key), name: ROLE_CLUSTER_NAMES[key], kind: "role" };
}

const DEEP_SPACE_REF: ClusterRef = {
  id: normalizeKey("other", DEEP_SPACE),
  name: DEEP_SPACE,
  kind: "other",
};

function countBy<T>(items: T[], key: (item: T) => string | null) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** Most common raw spelling per school group; ties go to the alphabetically first. */
function schoolDisplayNames(
  members: ClusterContact[],
  groupOf: (c: ClusterContact) => string | null
) {
  const spellings = new Map<string, Map<string, number>>();
  for (const c of members) {
    const group = groupOf(c);
    if (!group) continue;
    const raw = trimLabel(c.school);
    const counts = spellings.get(group) ?? new Map<string, number>();
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
    spellings.set(group, counts);
  }
  const names = new Map<string, string>();
  for (const [group, counts] of spellings) {
    const [best] = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    names.set(group, best![0]);
  }
  return names;
}

export type BuiltCluster = ClusterRef & {
  count: number;
  contactIds: string[];
};

export function buildConstellationClusters(
  contacts: ClusterContact[]
): { clusters: BuiltCluster[]; byContactId: Map<string, ClusterRef> } {
  const byContactId = new Map<string, ClusterRef>();

  // 1–2. Company clusters, and lone members of a family that has one.
  const companyOf = new Map(contacts.map((c) => [c.id, companyClusterLabel(c.company)]));
  const companyCounts = countBy(contacts, (c) => companyOf.get(c.id) || null);
  const familiesWithCluster = new Set<string>();
  for (const [company, count] of companyCounts) {
    if (count < 2) continue;
    const root = companyFamilyRoot(company);
    if (root) familiesWithCluster.add(root);
  }

  const afterCompany: ClusterContact[] = [];
  for (const c of contacts) {
    const company = companyOf.get(c.id) || "";
    const root = company ? companyFamilyRoot(company) : null;
    if (company && ((companyCounts.get(company) ?? 0) >= 2 || (root && familiesWithCluster.has(root)))) {
      byContactId.set(c.id, companyRef(company));
    } else {
      afterCompany.push(c);
    }
  }

  // 3. Role clusters across companies.
  const roleOf = new Map(afterCompany.map((c) => [c.id, roleClusterKey(classifyTitle(c.title))]));
  const roleCounts = countBy(afterCompany, (c) => roleOf.get(c.id) ?? null);
  const afterRole: ClusterContact[] = [];
  for (const c of afterCompany) {
    const role = roleOf.get(c.id);
    if (role && (roleCounts.get(role) ?? 0) >= 2) byContactId.set(c.id, roleRef(role));
    else afterRole.push(c);
  }

  // 4. School clusters, spellings grouped; 5. fallbacks.
  const schoolGroups = schoolGroupKeys(
    afterRole.map((c) => trimLabel(c.school)).filter(Boolean)
  );
  const groupOf = (c: ClusterContact) => schoolGroups.get(trimLabel(c.school)) ?? null;
  const schoolCounts = countBy(afterRole, groupOf);
  const schoolNames = schoolDisplayNames(afterRole, groupOf);
  for (const c of afterRole) {
    const group = groupOf(c);
    const company = companyOf.get(c.id) || "";
    if (group && (schoolCounts.get(group) ?? 0) >= 2) {
      byContactId.set(c.id, {
        id: normalizeKey("school", group),
        name: schoolNames.get(group)!,
        kind: "school",
      });
    } else if (company) {
      byContactId.set(c.id, companyRef(company));
    } else if (group) {
      byContactId.set(c.id, {
        id: normalizeKey("school", group),
        name: trimLabel(c.school),
        kind: "school",
      });
    } else {
      byContactId.set(c.id, DEEP_SPACE_REF);
    }
  }

  const map = new Map<string, BuiltCluster>();
  for (const c of contacts) {
    const ref = byContactId.get(c.id)!;
    const existing = map.get(ref.id);
    if (existing) {
      existing.contactIds.push(c.id);
      existing.count += 1;
    } else {
      map.set(ref.id, { ...ref, count: 1, contactIds: [c.id] });
    }
  }

  const kindRank: Record<ClusterKind, number> = {
    company: 0,
    role: 1,
    school: 2,
    other: 3,
  };

  const clusters = [...map.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const kr = kindRank[a.kind] - kindRank[b.kind];
    if (kr !== 0) return kr;
    return a.name.localeCompare(b.name);
  });

  return { clusters, byContactId };
}

/** Named clusters (everything but Deep Space) shaped for graph + dashboard payloads. */
export function toNamedGraphClusters(clusters: BuiltCluster[]) {
  return clusters
    .filter(
      (c): c is BuiltCluster & { kind: "company" | "role" | "school" } =>
        c.kind !== "other"
    )
    .map((c) => ({
      id: c.id,
      name: c.name,
      company: c.name,
      kind: c.kind,
      count: c.count,
      contactIds: c.contactIds,
    }));
}
```

Note the tier-2 test uses the raw spelling "DeepMind" and expects the name "Google DeepMind": `canonicalCompanyClusterName` maps `deepmind` → `Google DeepMind` (see `EXACT_ALIAS_TO_CANONICAL` in `src/lib/company-family.ts`), and `companyFamilyRoot("Google DeepMind")` must equal `companyFamilyRoot("Google")`. If that second call returns a different root, inspect `FAMILY_ROOTS` in `company-family.ts` before changing any code — the test expectation is correct per spec.

- [ ] **Step 4: Register the smoke**

In `scripts/run-smoke.ts`:

```ts
  "smoke-constellation-clusters": "pure",
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx scripts/smoke-constellation-clusters.ts`
Expected: ends with `constellation-clusters: all checks passed`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/constellation-clusters.ts scripts/smoke-constellation-clusters.ts scripts/run-smoke.ts
git commit -m "feat(constellation): company → family → role → school → fallback clusters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Thread the `role` kind through payload, colour, edges and layout

**Files:**
- Modify: `src/lib/graph-data.ts:30` (`GraphCluster.kind`)
- Modify: `src/lib/school-color.ts:101-111` (`clusterBrandColor`)
- Modify: `src/lib/network-metrics.ts:12-28, 168-172` (`PeerEdgeReason`, labels, `clusterReason`)
- Modify: `src/lib/graph-layout.ts:184-191` (edge `reason` union) and `:909` (figure-edge reason)
- Modify: `scripts/smoke-graph-layout.ts` (fixture + kind assertion)

**Interfaces:**
- Consumes: `ClusterKind` incl. `"role"` (Task 3).
- Produces: `PeerEdgeReason` includes `"role"` with label `"Same role"`; `clusterBrandColor(name, "role")` returns `ROLE_CLUSTER_COLOR` (`"#c8d0dc"`, exported from school-color.ts).

- [ ] **Step 1: Extend the layout smoke first (failing)**

In `scripts/smoke-graph-layout.ts`, add to the `fixture` array, right after the `solo` contact:

```ts
  // One-off companies, same function → a cross-company role constellation.
  contact("r1", { company: "Acme Robotics", title: "Backend Engineer", orbitScore: 3 }),
  contact("r2", { company: "Nimbus Labs", title: "Software Engineer", orbitScore: 4 }),
```

Replace the check `"only company/school clusters with ≥2 members get figures"` block with:

```ts
  check(
    "only named clusters with ≥2 members get figures",
    [...fit.fits.values()].every(
      ({ cluster }) => cluster.kind !== "other" && cluster.count >= 2
    ) && ![...fit.fits.values()].some((f) => f.cluster.name === "Tiny Startup")
  );
  check(
    "one-off engineers trace a role constellation",
    [...fit.fits.values()].some(
      (f) => f.cluster.kind === "role" && f.cluster.name === "Engineers" && f.cluster.count === 2
    )
  );
  check(
    "role figure lines are tagged as role edges",
    layout.edges.some((e) => e.data?.reason === "role")
  );
```

Run: `npx tsx scripts/smoke-graph-layout.ts`
Expected: FAIL at `role figure lines are tagged as role edges` (layout still maps every non-school kind to `"company"`), or a type error on `"role"`.

- [ ] **Step 2: Payload type**

`src/lib/graph-data.ts`, in `GraphCluster`:

```ts
  kind: "company" | "role" | "school" | "other";
```

- [ ] **Step 3: Cluster colour**

`src/lib/school-color.ts` — add above `clusterBrandColor` and handle the kind first:

```ts
/**
 * Role clusters span companies, so no one brand speaks for them. A quiet silver until the
 * galaxy phases tint each star by its own company.
 */
export const ROLE_CLUSTER_COLOR = "#c8d0dc";

export function clusterBrandColor(
  name: string,
  kind?: "company" | "role" | "school" | "other" | string
): string {
  if (kind === "role") return ROLE_CLUSTER_COLOR;
  if (kind === "school") return schoolStarColor(name);
  if (kind === "company") return companyBrandColor(name);
  // Infer from the name: a known school tints as a school, anything else as a company.
  return lookupBrand(name)?.kind === "school"
    ? schoolStarColor(name)
    : companyBrandColor(name);
}
```

- [ ] **Step 4: Peer-edge reason**

`src/lib/network-metrics.ts`:

```ts
export type PeerEdgeReason =
  | "company"
  | "role"
  | "school"
  | "event"
  | "howMet"
  | "mention"
  | "sharedTags"
  | "sharedInterests";

export const PEER_REASON_LABELS: Record<PeerEdgeReason, string> = {
  company: "Same company",
  role: "Same role",
  school: "Same school",
  event: "Same event",
  howMet: "Met together",
  mention: "Mentioned",
  sharedTags: "Shared tags",
  sharedInterests: "Shared interests",
};
```

and in `clusterReason`:

```ts
function clusterReason(kind: string): PeerEdgeReason {
  if (kind === "company") return "company";
  if (kind === "role") return "role";
  if (kind === "school") return "school";
  return "howMet";
}
```

Leave the metrics loop in `buildPeerEdges` as is: it keeps only `company`/`school` reasons, so cross-company role clusters correctly do NOT count as "these people know each other" in dashboard network metrics.

- [ ] **Step 5: Layout edges**

`src/lib/graph-layout.ts`, in `LayoutEdge.data.reason`, add `| "role"` after `| "company"`.

At the figure-edge loop (currently `const reason = fitEdge.clusterKind === "school" ? "school" : "company";`):

```ts
    const reason =
      fitEdge.clusterKind === "school"
        ? "school"
        : fitEdge.clusterKind === "role"
          ? "role"
          : "company";
```

(`brandOf(fitEdge.clusterName, reason)` below it then resolves `ROLE_CLUSTER_COLOR` for role edges.)

- [ ] **Step 6: Typecheck, then run the layout smoke**

Run: `npx tsc --noEmit -p . && npx tsx scripts/smoke-graph-layout.ts`
Expected: tsc exits 0 with no output; smoke passes every check including the three new ones.

If tsc reports an exhaustive `Record<ClusterKind, …>` or `switch` elsewhere missing `"role"`, add the `"role"` case alongside `"company"` with company-equivalent behaviour, and list the file in the commit message.

- [ ] **Step 7: Commit**

```bash
git add src/lib/graph-data.ts src/lib/school-color.ts src/lib/network-metrics.ts src/lib/graph-layout.ts scripts/smoke-graph-layout.ts
git commit -m "feat(constellation): carry role clusters through payload, colour and edges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Suite, golden and visual verification

**Files:**
- Possibly modify: `scripts/fixtures/behavior-golden.json` (only via `--update`, only if the diff is clustering)

- [ ] **Step 1: Registry and pure suite**

Run: `npx tsx scripts/run-smoke.ts --check && npx tsx scripts/run-smoke.ts --only smoke-role-function smoke-school-key smoke-constellation-clusters smoke-graph-layout smoke-sky-layout smoke-event-relevance smoke-constellation-match smoke-constellation-eligibility`
Expected: `--check` reports no unregistered scripts; every listed smoke passes.

- [ ] **Step 2: DB-tier constellation smokes**

Stop any dev server using this worktree's `.data/pglite` first (PGlite is single-writer). Then:

Run: `npx tsx scripts/run-smoke.ts --only smoke-constellation-payload-leak smoke-constellation-signals smoke-constellation-pin smoke-dashboard-aggregates smoke-behavior-golden`
Expected: all pass. If `smoke-behavior-golden` fails, read the diff: if every difference is a cluster `id`, `kind` or membership that the new tiers explain (e.g. a titled singleton moving into a role cluster, a school id becoming its group key), re-record with `npx tsx scripts/smoke-behavior-golden.ts --update` and name that in the commit. Any other difference is a bug — stop and investigate.

- [ ] **Step 3: Lint and typecheck**

Run: `npx tsc --noEmit -p . && npx eslint src/lib/role-function.ts src/lib/school-key.ts src/lib/constellation-clusters.ts src/lib/events/relevance.ts src/lib/school-color.ts src/lib/network-metrics.ts src/lib/graph-layout.ts src/lib/graph-data.ts scripts/smoke-role-function.ts scripts/smoke-school-key.ts scripts/smoke-constellation-clusters.ts scripts/smoke-graph-layout.ts`
Expected: 0 errors (the repo baseline is 0 — any error is from this change).

- [ ] **Step 4: Layout cost has not regressed**

Run: `npx tsx scripts/bench/constellation-layout.ts`
Expected: median ms at each size within ~10% of main's (fingerprints will differ — clustering changed on purpose). Grouping adds O(n) passes only.

- [ ] **Step 5: Visual check on the bench page**

Start the preview with `preview_start {name: "orbit-demo-bench"}` (launch config runs `ORBIT_BENCH=1 bash .claude/preview-demo.sh`), open `/bench/constellation?n=150&seed=3` and `?n=1000&seed=3`. Confirm: role clusters such as "Engineers" and "Founders & Execs" appear in the Clusters list with the `role` tag and a silver name; the sky still renders with no console errors (`read_console_messages` with `onlyErrors: true`). Screenshot both sizes for the PR.

- [ ] **Step 6: Commit (only if the golden changed)**

```bash
git add scripts/fixtures/behavior-golden.json
git commit -m "test: re-record behavior golden for role/school cluster tiers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Deferred to later phase plans (by design)

- **Affinity weights** (family / alumni / tags): the spec lists them under grouping, but nothing consumes them until disk placement, so they ship with phase 2 instead of adding unused work to every layout.
- **Per-member `{ fn, isLeader, petal }` annotations** and petal splits in `constellation-fit.ts`: consumed by phase 3 geometry.
