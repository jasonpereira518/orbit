/**
 * What a cluster is made of: its form, and — for a big company — a leadership core and one
 * petal per function. Pure: no DB, no network.
 * Run: npx tsx scripts/smoke-constellation-parts.ts
 */
import {
  FUNCTION_LABELS,
  knotOrder,
  planClusterParts,
  type PlanInput,
} from "../src/lib/constellation-parts";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const many = (n: number, title: string | null, from = 0, prefix = "m") =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(from + i).padStart(2, "0")}`, title }));
const company = (members: PlanInput[]) => planClusterParts({ kind: "company", count: members.length }, members);
const covers = (members: PlanInput[], parts: Array<{ memberIds: string[] }>) => {
  const ids = parts.flatMap((p) => p.memberIds).sort();
  return JSON.stringify(ids) === JSON.stringify(members.map((m) => m.id).sort());
};

console.log("\nForms by kind and size");
{
  check("2 members are a binary", planClusterParts({ kind: "company", count: 2 }, many(2, null)).form === "binary");
  check("3 members are a binary, whatever the kind", ["company", "role", "school"].every((kind) => planClusterParts({ kind: kind as "company", count: 3 }, many(3, null)).form === "binary"));
  check("a company of 5 with no titles is a figure", company(many(5, null)).form === "figure");
  check("a role cluster of 4 is open", planClusterParts({ kind: "role", count: 4 }, many(4, "Engineer")).form === "open");
  check("a school of 4 is a ring", planClusterParts({ kind: "school", count: 4 }, many(4, null)).form === "ring");
  const single = company(many(6, null));
  check("a non-split cluster has one 'main' part holding everyone", single.parts.length === 1 && single.parts[0].key === "main" && single.parts[0].role === "main" && single.parts[0].label === null && covers(many(6, null), single.parts));
}

console.log("\nPetals");
{
  const m = [...many(2, "VP Engineering", 0), ...many(6, "Software Engineer", 2), ...many(4, "Product Designer", 8), ...many(3, "Account Executive", 12)];
  const plan = company(m);
  check("a company with leaders and several functions is a petal cluster", plan.form === "petal");
  check("its first part is the leadership core", plan.parts[0].key === "core" && plan.parts[0].role === "core" && plan.parts[0].label === "Leadership" && plan.parts[0].memberIds.join() === "m00,m01");
  check("the petals follow, biggest first", plan.parts.slice(1).map((p) => p.key).join() === "petal:engineering,petal:design,petal:sales");
  check("petals are labelled by function", plan.parts[1].label === FUNCTION_LABELS.engineering && plan.parts[2].label === "Design");
  check("everyone is in exactly one part", covers(m, plan.parts));
  check("members keep their placement order inside a part", plan.parts[1].memberIds.join() === "m02,m03,m04,m05,m06,m07");

  const noLeaders = company([...many(4, "Software Engineer", 0), ...many(4, "Product Designer", 4)]);
  check("no leaders means no core", noLeaders.form === "petal" && noLeaders.parts.every((p) => p.role === "petal"));
  const oneLeader = company([...many(1, "CEO", 0), ...many(4, "Software Engineer", 1), ...many(4, "Product Designer", 5)]);
  check("a single leader is a core of one", oneLeader.parts[0].role === "core" && oneLeader.parts[0].memberIds.length === 1);

  check("7 members are too few for petals", company([...many(4, "Software Engineer", 0), ...many(3, "Product Designer", 4)]).form === "figure");
  check("one function is not petals", company(many(10, "Software Engineer")).form === "figure");
  check("leaders plus one function are not petals", company([...many(3, "CEO", 0), ...many(8, "Software Engineer", 3)]).form === "figure");
}

console.log("\nFolding lone members");
{
  const m = [...many(4, "Software Engineer", 0), ...many(4, "Product Designer", 4), { id: "m08", title: "Data Scientist" }, { id: "m09", title: "Account Executive" }];
  const plan = company(m);
  check("two lone functions fold into 'Other'", plan.form === "petal" && plan.parts.some((p) => p.key === "petal:other" && p.memberIds.join() === "m08,m09"));

  const one = company([...many(4, "Software Engineer", 0), ...many(4, "Product Designer", 4), { id: "m08", title: "Data Scientist" }]);
  check("a lone 'Other' joins the largest petal", one.form === "petal" && !one.parts.some((p) => p.key === "petal:other") && one.parts[0].memberIds.includes("m08") && covers([...many(4, "Software Engineer", 0), ...many(4, "Product Designer", 4), { id: "m08", title: "Data Scientist" }], one.parts));
  check("ties for 'largest' go to the earlier function key (no leaders, so it is the first part)", one.parts[0].key === "petal:design" && one.parts[0].memberIds.length === 5);
}

console.log("\nSchool knots");
{
  const school: Record<string, string | null> = { a: "mit", b: "waterloo", c: "mit", d: null, e: "waterloo", f: "mit" };
  const out = knotOrder(["a", "b", "c", "d", "e", "f"], (id) => school[id] ?? null);
  check("members of one school become adjacent", out.join() === "a,c,f,b,e,d", out.join());
  check("nobody is dropped or duplicated", [...out].sort().join() === "a,b,c,d,e,f");
  check("with no schools nothing moves", knotOrder(["x", "y", "z"], () => null).join() === "x,y,z");
}

console.log("\nDeterminism");
{
  const m = [...many(2, "VP Engineering", 0), ...many(6, "Software Engineer", 2), ...many(4, "Product Designer", 8)];
  check("planning is deterministic", JSON.stringify(company(m)) === JSON.stringify(company(m)));
}

console.log("\nconstellation-parts: all checks passed");
process.exit(0);
