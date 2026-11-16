/**
 * Which source may change which contact field (contact-info accuracy plan, PR 1).
 *
 * Every contact field below records where its value came from (`contacts.field_sources`).
 * Automated writers ask `decideFieldWrites` before writing; the person's own edits never pass
 * through it, they only stamp `user`. The rule, in tiers:
 *
 *   4 user         the person typed it (form, chat, MCP). Nothing automated replaces it.
 *   3 dated record the person's own record: the extension reading their profile, the LinkedIn
 *                  export, Refresh from LinkedIn, a reviewed capture card, a confident job move.
 *   2 kept record  a record the user keeps: address books, file imports, unattended capture.
 *   1 inferred     confident web research, signatures, email domain.
 *   0 unknown      a value written before field sources existed (no stamp).
 *
 * Higher replaces lower. Same tier: only dated records (3) replace each other, newest fact
 * wins; two address books never flip a value back and forth. Unknown (0) values are replaced
 * only by a dated record. A newer dated record against a typed value becomes a suggestion.
 * Losers from tiers 1–2 are dropped silently: suggesting them would refill the queue on every
 * sync. Pure, no I/O: the one place the rule lives (tested by scripts/smoke-contact-fields.ts).
 */

export const FIELD_SOURCE_TIER = {
  user: 4,
  extension: 3,
  linkedin_export: 3,
  linkedin_refresh: 3,
  capture: 3,
  job_move: 3,
  address_book: 2,
  import: 2,
  calendar: 2,
  unattended_capture: 2,
  web: 1,
  signature: 1,
  email_domain: 1,
} as const;

export type FieldSource = keyof typeof FIELD_SOURCE_TIER;

/** The contact fields that carry a source. Keys are `ContactInput` keys. */
export const FIELD_KEYS = [
  "company",
  "title",
  "location",
  "school",
  "email",
  "phone",
  "linkedinUrl",
  "xHandle",
  "website",
  "industry",
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

export type FieldStamp = { s: FieldSource; at: string };
export type FieldSources = Partial<Record<FieldKey, FieldStamp>>;

/** Fields an automated source may replace. Every other field is fill-only. */
const REPLACEABLE = new Set<FieldKey>(["company", "title", "location"]);
/** Fill-only fields where a conflicting dated record is still worth asking about. */
const SUGGEST_ON_CONFLICT = new Set<FieldKey>(["linkedinUrl"]);

export type FieldChange = {
  field: FieldKey;
  before: string | null;
  after: string;
  status: "applied" | "suggested";
};

export type FieldDecision = {
  /** The incoming values that won, to write. */
  write: Partial<Record<FieldKey, string>>;
  /** Stamps to merge into `field_sources` (winners, and same values seen from a better source). */
  stamps: FieldSources;
  /** Replacements, inferred fills and suggestions: what "Changed by Orbit" shows. */
  changes: FieldChange[];
};

/** "keep": the incoming value is the one already stored; it never holds up its pair. */
type Verdict = "drop" | "fill" | "replace" | "suggest" | "restamp" | "keep";

function blank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function same(field: FieldKey, a: string, b: string): boolean {
  const norm = (v: string) => {
    let s = v.trim().toLowerCase().replace(/\s+/g, " ");
    if (field === "linkedinUrl" || field === "website") {
      s = s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    }
    if (field === "xHandle") s = s.replace(/^@/, "");
    if (field === "phone") s = s.replace(/[^\d+]/g, "");
    return s;
  };
  return norm(a) === norm(b);
}

export function tierOf(stamp: FieldStamp | undefined | null): number {
  return stamp ? (FIELD_SOURCE_TIER[stamp.s] ?? 0) : 0;
}

function verdictFor(
  field: FieldKey,
  existing: string | null | undefined,
  stamp: FieldStamp | undefined,
  incoming: string,
  source: FieldSource,
  at: Date
): Verdict {
  const tier = FIELD_SOURCE_TIER[source];
  if (field === "email" && tier <= 1) return "drop";
  const have = tierOf(stamp);
  const newer = !stamp || at.getTime() > new Date(stamp.at).getTime();
  const askable = REPLACEABLE.has(field) || SUGGEST_ON_CONFLICT.has(field);
  // A field the person cleared stays clear; only newer news from their own record is offered.
  if (blank(existing)) return have === 4 ? (tier === 3 && newer ? "suggest" : "drop") : "fill";
  if (same(field, existing as string, incoming)) return tier > have ? "restamp" : "keep";
  // A conflict. A dated record that is newer news than what the person typed: ask.
  if (have === 4) return tier === 3 && newer && askable ? "suggest" : "drop";
  if (!REPLACEABLE.has(field)) return tier === 3 && askable ? "suggest" : "drop";
  if (have === 0) return tier === 3 ? "replace" : "drop";
  if (tier > have) return "replace";
  if (tier === 3 && have === 3 && newer) return "replace";
  return "drop";
}

/** Lower is more cautious. */
const CAUTION: Partial<Record<Verdict, number>> = { drop: 0, suggest: 1, replace: 2 };

/**
 * Decide which incoming values an automated `source` may write onto a contact that holds
 * `current` (with `sources`). `at` is when the fact was true (a job's start month, an
 * export's upload day), not when it is written; it defaults to now.
 */
export function decideFieldWrites(
  current: Partial<Record<FieldKey, string | null>>,
  sources: FieldSources | null | undefined,
  incoming: Partial<Record<FieldKey, string | null | undefined>>,
  source: FieldSource,
  at: Date = new Date()
): FieldDecision {
  const stampsIn = sources ?? {};
  const verdicts = new Map<FieldKey, Verdict>();
  for (const field of FIELD_KEYS) {
    const value = incoming[field];
    if (blank(value)) continue;
    verdicts.set(field, verdictFor(field, current[field], stampsIn[field], (value as string).trim(), source, at));
  }

  // Company and title describe one job: when both conflict with what is stored, they move
  // together at the more cautious verdict, so a new title never lands on the old company.
  const c = verdicts.get("company");
  const t = verdicts.get("title");
  if (c !== undefined && t !== undefined && CAUTION[c] !== undefined && CAUTION[t] !== undefined) {
    const pair = CAUTION[c] <= CAUTION[t] ? c : t;
    verdicts.set("company", pair);
    verdicts.set("title", pair);
  }

  const decision: FieldDecision = { write: {}, stamps: {}, changes: [] };
  const stamp: FieldStamp = { s: source, at: at.toISOString() };
  const inferred = FIELD_SOURCE_TIER[source] <= 1;
  for (const [field, verdict] of verdicts) {
    const after = (incoming[field] as string).trim();
    const before = blank(current[field]) ? null : (current[field] as string);
    if (verdict === "fill" || verdict === "replace") {
      decision.write[field] = after;
      decision.stamps[field] = stamp;
      if (verdict === "replace" || inferred) decision.changes.push({ field, before, after, status: "applied" });
    } else if (verdict === "restamp") {
      decision.stamps[field] = stamp;
    } else if (verdict === "suggest") {
      decision.changes.push({ field, before, after, status: "suggested" });
    }
  }
  return decision;
}

/** Stamps for a new contact: every sourced field it is created with. */
export function stampsFor(
  values: Partial<Record<FieldKey, string | null | undefined>>,
  source: FieldSource,
  at: Date = new Date()
): FieldSources {
  const out: FieldSources = {};
  for (const field of FIELD_KEYS) if (!blank(values[field])) out[field] = { s: source, at: at.toISOString() };
  return out;
}

/** Stamps for fields the person just typed: only those whose value actually changed. */
export function userStamps(
  current: Partial<Record<FieldKey, string | null>>,
  incoming: Partial<Record<FieldKey, string | null | undefined>>,
  at: Date = new Date()
): FieldSources {
  const out: FieldSources = {};
  for (const field of FIELD_KEYS) {
    const value = incoming[field];
    if (value === undefined) continue;
    const before = current[field];
    const changed = blank(value) ? !blank(before) : blank(before) || !same(field, before as string, value as string);
    if (changed) out[field] = { s: "user", at: at.toISOString() };
  }
  return out;
}
