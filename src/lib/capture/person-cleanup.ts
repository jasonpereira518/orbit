/**
 * What the model returns as "people" before any of it becomes a review card. Pure, so the
 * smoke can drive it without a model:
 *
 * - Who is not a person at all (a company, a team, "the recruiter") is `isPersonName`'s call, in
 *   `@/lib/names/classify`.
 * - `collapseSamePeople`: one person returned twice ("Sarah" and "Sarah Chen" in one note).
 */
import { nameKey } from "@/lib/names/key";

function isEmpty(v: unknown): boolean {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

function mergeValue(a: unknown, b: unknown): unknown {
  if (isEmpty(a)) return b;
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set(a.map((x) => JSON.stringify(x)));
    return [...a, ...b.filter((x) => !seen.has(JSON.stringify(x)))];
  }
  return a;
}

type CollapsiblePerson = {
  name?: string | null;
  email?: string | null;
  linkedin_url?: string | null;
  source_excerpt?: string;
};

/** Fold `b` into `a`: a's values win, b fills gaps, lists union, the fuller name is kept. */
function mergePeople<T extends CollapsiblePerson>(a: T, b: T): T {
  const out = { ...a } as Record<string, unknown>;
  for (const [k, v] of Object.entries(b)) out[k] = mergeValue(out[k], v);
  const an = a.name?.trim() ?? "";
  const bn = b.name?.trim() ?? "";
  out.name = bn.length > an.length ? bn : an || null;
  if ("source_excerpt" in a || "source_excerpt" in b) {
    const excerpts = [a.source_excerpt, b.source_excerpt].map((e) => e?.trim()).filter(Boolean);
    out.source_excerpt = [...new Set(excerpts)].join("\n");
  }
  return out as T;
}

function keysFor(p: CollapsiblePerson): string[] {
  const keys: string[] = [];
  const email = p.email?.trim().toLowerCase();
  if (email) keys.push(`e:${email}`);
  const slug = p.linkedin_url?.match(/linkedin\.com\/in\/([^/?#\s]+)/i)?.[1]?.toLowerCase();
  if (slug) keys.push(`l:${slug}`);
  const name = nameKey(p.name);
  if (name) keys.push(`n:${name}`);
  return keys;
}

const isSingleName = (p: CollapsiblePerson) => !nameKey(p.name).includes(" ");

/**
 * One entry per person. Entries sharing an email, LinkedIn slug or full name merge; then a
 * first-name-only entry ("Sarah") folds into the ONE full-name entry with that first name.
 * Two Sarah-somebodies leave a bare "Sarah" alone — guessing would merge the wrong one.
 */
export function collapseSamePeople<T extends CollapsiblePerson>(people: readonly T[]): T[] {
  const out: T[] = [];
  const byKey = new Map<string, number>();
  for (const p of people) {
    const keys = keysFor(p);
    const hit = keys.map((k) => byKey.get(k)).find((i) => i !== undefined);
    if (hit === undefined) {
      out.push(p);
      keys.forEach((k) => byKey.set(k, out.length - 1));
    } else {
      out[hit] = mergePeople(out[hit], p);
      keysFor(out[hit]).forEach((k) => byKey.set(k, hit));
    }
  }

  const absorbed = new Set<number>();
  out.forEach((p, i) => {
    const first = nameKey(p.name);
    if (!first || !isSingleName(p)) return;
    const fulls = out
      .map((q, j) => ({ q, j }))
      .filter(({ q, j }) => j !== i && !absorbed.has(j) && !isSingleName(q) && nameKey(q.name).split(" ")[0] === first);
    if (fulls.length !== 1) return;
    const { q: target, j } = fulls[0];
    // A different email means a different person who shares a first name.
    if (p.email && target.email && p.email.toLowerCase() !== target.email.toLowerCase()) return;
    out[j] = mergePeople(target, p);
    absorbed.add(i);
  });
  return out.filter((_, i) => !absorbed.has(i));
}
