/**
 * Scoring for `scripts/eval-ai.ts`. Pure — no DB, no network — so the rules that decide
 * whether a cheaper model is "as accurate" are themselves pinned by a smoke test
 * (`scripts/smoke-eval-ai-score.ts`). A gate that scores wrong is worse than no gate.
 */
import { nameSimilarity } from "../../src/lib/duplicates";

/**
 * Lowercase, strip accents and punctuation, collapse whitespace. "@" and a "." inside a
 * token survive (so an email still compares as an email); a sentence's full stop does not.
 */
export function norm(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@.\s]/g, " ")
    .replace(/\.(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a returned name is the expected person. Edit distance catches a dropped letter
 * ("Siobhan OBrian"); the token rule accepts a middle name or initial the fixture left out
 * ("Priya K. Raman" for "Priya Raman") but never a first name alone.
 */
export function sameName(expected: string, actual: string | null | undefined): boolean {
  if (!actual) return false;
  if (nameSimilarity(expected, actual) >= 0.85) return true;
  const want = norm(expected).split(" ").filter((t) => t.length > 1);
  const have = new Set(norm(actual).split(" "));
  return want.length >= 2 && want.every((t) => have.has(t));
}

/**
 * Field agreement: case-insensitive, either containing the other, so "Staff Engineer" matches
 * "Staff Software Engineer, Payments" and "Larkspur" matches "Larkspur Robotics". An empty
 * actual never matches.
 */
export function sameField(expected: string, actual: string | null | undefined): boolean {
  const a = norm(actual);
  const e = norm(expected);
  if (!a || !e) return false;
  return a.includes(e) || e.includes(a);
}

/** True when `needle` appears in `haystack`, normalized. */
export function mentions(haystack: string, needle: string): boolean {
  const n = norm(needle);
  return n.length > 0 && norm(haystack).includes(n);
}

function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Character error rate of `actual` against `reference`, both normalized. 0 = perfect. */
export function characterErrorRate(reference: string, actual: string): number {
  const ref = [...norm(reference)];
  if (ref.length === 0) return actual.trim() ? 1 : 0;
  return levenshtein(ref, [...norm(actual)]) / ref.length;
}

/** Word error rate of `actual` against `reference`, both normalized. 0 = perfect. */
export function wordErrorRate(reference: string, actual: string): number {
  const ref = norm(reference).split(" ").filter(Boolean);
  if (ref.length === 0) return actual.trim() ? 1 : 0;
  return levenshtein(ref, norm(actual).split(" ").filter(Boolean)) / ref.length;
}

/** A hit/total pair that sums across cases and runs. */
export type Tally = { hit: number; total: number };

export const tally = (): Tally => ({ hit: 0, total: 0 });

export function count(t: Tally, ok: boolean): void {
  t.total += 1;
  if (ok) t.hit += 1;
}

/** hit/total, or null when nothing was scored (a null metric is skipped by the gate). */
export function rate(t: Tally): number | null {
  return t.total === 0 ? null : t.hit / t.total;
}

export function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((n, v) => n + v, 0) / values.length;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One gate rule. `higherIsBetter` metrics may not drop by more than `maxDrop`; the others
 * (error rates, hallucination counts) may not rise by more than `maxRise`.
 */
export type GateRule = { maxDrop?: number; maxRise?: number };
export type GateRules = Record<string, Record<string, GateRule>>;
export type TaskMetrics = Record<string, number | null>;

export type GateFinding = {
  task: string;
  metric: string;
  baseline: number;
  candidate: number;
  allowed: string;
};

/**
 * Compares a candidate run to a baseline run. A metric either side left null (task not run,
 * nothing scored) is not compared — the report says which tasks were skipped instead.
 */
export function gate(
  rules: GateRules,
  baseline: Record<string, TaskMetrics>,
  candidate: Record<string, TaskMetrics>
): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const [task, metrics] of Object.entries(rules)) {
    for (const [metric, rule] of Object.entries(metrics)) {
      const b = baseline[task]?.[metric];
      const c = candidate[task]?.[metric];
      if (b == null || c == null) continue;
      // A hair of float tolerance so 0.7 - 0.02 is not "below" 0.68.
      if (rule.maxDrop != null && c < b - rule.maxDrop - 1e-9) {
        findings.push({ task, metric, baseline: b, candidate: c, allowed: `drop ≤ ${rule.maxDrop}` });
      }
      if (rule.maxRise != null && c > b + rule.maxRise + 1e-9) {
        findings.push({ task, metric, baseline: b, candidate: c, allowed: `rise ≤ ${rule.maxRise}` });
      }
    }
  }
  return findings;
}

/**
 * One research-eval answer, scored. Pure, so `smoke-eval-ai-score` can pin it.
 *
 * - A person counts as mentioned if the answer names them OR a recommendation that SURVIVED
 *   the allowlist filter points at them — a recommendation the filter dropped reached nobody.
 * - A fact counts if the answer text contains it. The fixture only uses facts that live in a
 *   note and nowhere on a contact card, so this is a test of whether the research found the
 *   note, not of whether the model can paraphrase what retrieval handed it.
 * - An invented id is a raw recommendation (before the filter) pointing at an id that is not
 *   one of this user's contacts at all: a fabrication, not a judgement call. The filter would
 *   catch it in production; counting it here is how a model change that starts making them
 *   up gets noticed before the filter is the only thing standing in the way.
 */
export function scoreResearchAnswer(input: {
  answer: string;
  /** contact_id of every recommendation the model returned, before filtering. */
  rawRecommendationIds: Array<string | null | undefined>;
  /** contact_id of every recommendation that survived `filterRecommendations`. */
  keptRecommendationIds: Array<string | null | undefined>;
  mustMention: Array<{ id: string; fullName: string }>;
  mustSay: string[];
  forbidden: string[];
  /** Every contact id this user really has. */
  knownContactIds: Set<string>;
}): {
  mentioned: boolean[];
  said: boolean[];
  forbiddenHits: number;
  inventedIds: number;
  filteredOut: number;
} {
  const kept = new Set(input.keptRecommendationIds.filter((id): id is string => !!id));
  const raw = input.rawRecommendationIds.filter((id): id is string => !!id);
  return {
    mentioned: input.mustMention.map((p) => mentions(input.answer, p.fullName) || kept.has(p.id)),
    said: input.mustSay.map((fact) => mentions(input.answer, fact)),
    forbiddenHits: input.forbidden.filter((claim) => mentions(input.answer, claim)).length,
    inventedIds: raw.filter((id) => !input.knownContactIds.has(id)).length,
    filteredOut: raw.filter((id) => input.knownContactIds.has(id) && !kept.has(id)).length,
  };
}
