/**
 * What a cluster is made of.
 *
 * Most clusters are one figure. A big company is not: 300 people at Google drawn as nine
 * stars and 290 dots is a blob, so it is split into a leadership CORE (the people who lead) and
 * one PETAL per function, each a small constellation of its own. This module decides that
 * split from titles alone — pure, no geometry — so the fit, the layout and the tests all read
 * one decision.
 *
 * `ordered` arrives in placement order (active before dormant, closest first). Every part
 * keeps that relative order, so a part's top members are its best ones.
 */

import type { ClusterKind } from "@/lib/constellation-clusters";
import { classifyTitle, type RoleFunction } from "@/lib/role-function";

export type ClusterForm = "petal" | "figure" | "ring" | "binary" | "open";
export type PartRole = "main" | "core" | "petal";
export type PartPlan = {
  key: string;
  label: string | null;
  role: PartRole;
  memberIds: string[];
};
export type PlanInput = { id: string; title?: string | null };

export const FUNCTION_LABELS: Record<RoleFunction, string> = {
  founders: "Founders & Execs",
  engineering: "Engineering",
  product: "Product",
  design: "Design",
  data: "Data & Research",
  sales: "Sales & BD",
  marketing: "Marketing",
  people: "People & Recruiting",
  operations: "Operations",
  other: "Other",
};

/** A company needs this many people, and… */
export const PETAL_MIN_MEMBERS = 8;
/** …at least two function groups of this many, to be worth splitting. */
export const PETAL_MIN_GROUP = 2;
/** …and at least this many named functions (not counting "Other") to split at all. */
export const PETAL_MIN_NAMED = 2;

const codepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function planCompany(ordered: PlanInput[]): PartPlan[] | null {
  if (ordered.length < PETAL_MIN_MEMBERS) return null;
  const rank = new Map(ordered.map((m, i) => [m.id, i]));
  const byRank = (a: string, b: string) => rank.get(a)! - rank.get(b)!;

  const leaders: string[] = [];
  const groups = new Map<RoleFunction, string[]>();
  for (const m of ordered) {
    const { fn, isLeader } = classifyTitle(m.title);
    if (isLeader) {
      leaders.push(m.id);
    } else {
      const list = groups.get(fn) ?? [];
      list.push(m.id);
      groups.set(fn, list);
    }
  }

  // A function with one person is no petal: they join "Other".
  const other = [...(groups.get("other") ?? [])];
  for (const [fn, ids] of [...groups]) {
    if (fn !== "other" && ids.length < PETAL_MIN_GROUP) {
      other.push(...ids);
      groups.delete(fn);
    }
  }
  other.sort(byRank);
  if (other.length > 0) groups.set("other", other);
  else groups.delete("other");

  // …and a lone "Other" joins the largest real petal, if there is one.
  if (other.length > 0 && other.length < PETAL_MIN_GROUP) {
    const target = [...groups]
      .filter(([fn, ids]) => fn !== "other" && ids.length >= PETAL_MIN_GROUP)
      .sort((a, b) => b[1].length - a[1].length || codepoint(a[0], b[0]))[0];
    if (target) {
      target[1].push(...other);
      target[1].sort(byRank);
      groups.delete("other");
    }
  }

  const petals = [...groups].filter(([, ids]) => ids.length >= PETAL_MIN_GROUP);
  // "Other" is where blank and unrecognised titles land, so it can be the biggest group in a
  // company whose titles are mostly empty. It rides along once a company really has functions,
  // but it never makes a company split by itself.
  if (petals.filter(([fn]) => fn !== "other").length < PETAL_MIN_NAMED) return null;
  petals.sort((a, b) => b[1].length - a[1].length || codepoint(a[0], b[0]));

  const parts: PartPlan[] = [];
  if (leaders.length > 0) {
    parts.push({ key: "core", label: "Leadership", role: "core", memberIds: leaders });
  }
  for (const [fn, ids] of petals) {
    parts.push({ key: `petal:${fn}`, label: FUNCTION_LABELS[fn], role: "petal", memberIds: ids });
  }
  return parts;
}

// `cluster.count` is not read (the ordered list has the size); it stays so callers pass a cluster.
export function planClusterParts(
  cluster: { kind: ClusterKind; count: number },
  ordered: PlanInput[]
): { form: ClusterForm; parts: PartPlan[] } {
  const main = (form: ClusterForm) => ({
    form,
    parts: [
      { key: "main", label: null, role: "main" as const, memberIds: ordered.map((m) => m.id) },
    ],
  });
  if (ordered.length <= 3) return main("binary");
  if (cluster.kind === "role") return main("open");
  if (cluster.kind === "school") return main("ring");
  const petals = cluster.kind === "company" ? planCompany(ordered) : null;
  return petals ? { form: "petal", parts: petals } : main("figure");
}

/**
 * Members who share a school made adjacent: each school's run sits where its first member was.
 * Applied to a petal's figure stars, so classmates usually sit on stars joined by a figure line
 * (adjacent star indices are joined in most shapes, but not all: gemini, crux, lyra and aquila
 * break it) rather than scattered across the shape. Members with no school stay where they are.
 */
export function knotOrder(ids: string[], schoolOf: (id: string) => string | null): string[] {
  const bySchool = new Map<string, string[]>();
  for (const id of ids) {
    const school = schoolOf(id);
    if (!school) continue;
    const run = bySchool.get(school) ?? [];
    run.push(id);
    bySchool.set(school, run);
  }
  const out: string[] = [];
  const emitted = new Set<string>();
  for (const id of ids) {
    if (emitted.has(id)) continue;
    const school = schoolOf(id);
    for (const member of school ? bySchool.get(school)! : [id]) {
      emitted.add(member);
      out.push(member);
    }
  }
  return out;
}
