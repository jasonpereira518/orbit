import type { NameGuess } from "@/lib/contact-name-guess";
import type { PeerEdgeReason } from "@/lib/network-metrics";

export type RelatedReason =
  | PeerEdgeReason
  | "school"
  | "companyId";

export type RelatedContactCandidate = {
  id: string;
  fullName: string;
  preferredName?: string | null;
  firstName?: string | null;
  title?: string | null;
  company?: string | null;
  companyId?: string | null;
  school?: string | null;
  location?: string | null;
  howMet?: string | null;
  profileImageUrl?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  tags?: string[] | null;
  sharedInterests?: string[] | null;
  notes?: string | null;
  aiSummary?: string | null;
  keyFacts?: string[] | null;
  relationshipScore?: number | null;
};

export type RelatedContact = {
  id: string;
  fullName: string;
  preferredName: string | null;
  firstName: string | null;
  title: string | null;
  company: string | null;
  school: string | null;
  location: string | null;
  profileImageUrl: string | null;
  linkedinUrl: string | null;
  email: string | null;
  phone: string | null;
  aiSummary: string | null;
  /** Filled in with the display columns; a weak one puts a "?" by the name. */
  nameGuess?: NameGuess | null;
  relationshipScore: number | null;
  reason: RelatedReason;
  reasonLabel: string;
};

const REASON_WEIGHT: Record<RelatedReason, number> = {
  mention: 100,
  companyId: 90,
  company: 80,
  event: 75,
  howMet: 70,
  school: 60,
  sharedTags: 40,
  sharedInterests: 30,
};

function normalizePhrase(value: string | null | undefined) {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function companyKey(company: string | null | undefined) {
  return normalizePhrase(company);
}

function contactCorpus(c: RelatedContactCandidate) {
  return [
    c.aiSummary || "",
    ...(c.keyFacts || []),
    c.notes || "",
    ...(c.sharedInterests || []),
  ]
    .join(" ")
    .toLowerCase();
}

/** The lowercased names a corpus is searched for when deciding "mentioned together". */
export function nameAliases(c: RelatedContactCandidate) {
  const names = new Set<string>();
  const full = c.fullName.trim();
  const preferred = (c.preferredName || "").trim();
  if (full.length >= 3) names.add(full.toLowerCase());
  if (preferred.length >= 3) names.add(preferred.toLowerCase());
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (last.length >= 4) names.add(last.toLowerCase());
  }
  return [...names];
}

/**
 * SQL `LIKE` patterns that match every text in which `contactCorpus` could contain one of
 * `aliases` — a SUPERSET prefilter, so a caller can fetch the wide text columns
 * (`notes`, `aiSummary`, `keyFacts`) only for the rows that could possibly mention the
 * source, and still get exactly what `findRelatedContacts` would have computed from every
 * row. The exact test still runs in JS on the rows the prefilter lets through.
 *
 * Why it is a superset, given a text piece `p` (a text column or one jsonb string element)
 * and the SQL side lowering `p` with {@link RELATED_SQL_LOWER}:
 *   - The corpus joins its pieces with U+0020, and a pattern is built from one
 *     U+0020-free segment of the alias, so any occurrence of that segment lies inside one
 *     piece — a match across a join boundary still leaves every segment whole in a piece.
 *   - `String#toLowerCase` maps each code point to exactly one code point except U+0130
 *     (to "i" + U+0307), and sends a non-ASCII code point to ASCII only for U+0130 and
 *     U+212A (KELVIN SIGN, to "k"); verified over every code point. The SQL lowering does
 *     A-Z, U+212A and U+0130 exactly that way and leaves every other character alone, so
 *     the two lowered strings are code-point aligned and agree at every position where the
 *     JS one is ASCII. Locale-independent on purpose: `lower()`/`ILIKE` follow the
 *     database collation, which the JS side does not.
 *   - So the pattern keeps ASCII characters (with `\`, `%`, `_` escaped) and turns every
 *     non-ASCII code point into `_` (exactly one character).
 */
export function mentionLikePatterns(aliases: string[]): string[] {
  const patterns = new Set<string>();
  for (const alias of aliases) {
    // `mentionsOtherSignals` skips these, so they can never produce a mention.
    if (alias.length < 3) continue;
    const segment = alias
      .split(" ")
      .reduce((best, s) => (s.length > best.length ? s : best), "");
    if (!segment) continue;
    let body = "";
    for (const ch of segment) {
      const cp = ch.codePointAt(0)!;
      if (cp >= 0x80) body += "_";
      else if (ch === "\\" || ch === "%" || ch === "_") body += `\\${ch}`;
      else body += ch;
    }
    patterns.add(`%${body}%`);
  }
  return [...patterns];
}

/** One already-lowered text as a `LIKE` body: ASCII kept (escaped), anything else `_`. See `mentionLikePatterns`. */
export function likeBody(lowered: string): string {
  let body = "";
  for (const ch of lowered) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x80) body += "_";
    else if (ch === "\\" || ch === "%" || ch === "_") body += `\\${ch}`;
    else body += ch;
  }
  return body;
}

/**
 * What a candidate's narrow columns must look like for `bestReason` to give it anything
 * but a mention, as SUPERSET prefilters for SQL (the same argument as `mentionLikePatterns`:
 * the SQL side lowers with {@link RELATED_SQL_LOWER}, code-point aligned with JS where JS
 * is ASCII, and every non-ASCII code point is a `_`). The exact test still runs in JS.
 *
 * - `phrase`: `normalizePhrase(x) === key` needs the raw text to hold the key's space-free
 *   segments in order, so `%seg1%seg2%` matches it. Null when the source cannot match
 *   (empty company; howMet or school under three characters).
 * - `interests`: two of the source's interests in the candidate's needs at least one
 *   element equal to one of them; lowered here, for `interestTextPattern` or `likeBody`.
 *   Null when the source has fewer than two.
 * - `corpus`: the source's own corpus, which a candidate's NAME can appear in.
 *
 * Returns null when the source's own jsonb is not an array of strings: then scoring is
 * not shaped the way this reasons about, and the caller reads every contact as before.
 */
export function relatedCandidateFilter(source: RelatedContactCandidate): {
  companyId: string | null;
  company: string | null;
  howMet: string | null;
  school: string | null;
  interests: string[] | null;
  corpus: string;
} | null {
  const stringArray = (v: unknown) => v == null || (Array.isArray(v) && v.every((t) => typeof t === "string"));
  if (!stringArray(source.sharedInterests) || !stringArray(source.keyFacts)) return null;
  const phrase = (value: string | null | undefined, min: number) => {
    const key = normalizePhrase(value);
    if (key.length < Math.max(min, 1)) return null;
    return `%${key.split(" ").filter(Boolean).map(likeBody).join("%")}%`;
  };
  const interests = source.sharedInterests ?? [];
  return {
    companyId: source.companyId || null,
    company: phrase(source.company, 1),
    howMet: phrase(source.howMet, 3),
    school: phrase(source.school, 3),
    interests: interests.length >= 2 ? [...new Set(interests.map((t) => t.toLowerCase()))] : null,
    corpus: contactCorpus(source),
  };
}

/**
 * The characters JS's `\s` (and so `trim()` and `split(/\s+/)`) counts as whitespace, and
 * as many spaces: SQL `translate()`s a name with these before splitting it, so it splits
 * exactly where JS would. Spelled out rather than a regex `\s`, whose meaning in Postgres
 * follows the database locale.
 */
export const JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
export const JS_WHITESPACE_AS_SPACES = " ".repeat(JS_WHITESPACE.length);

/**
 * An interest as a `LIKE` body over a jsonb array's text, or null when it cannot be one.
 * `jsonb::text` writes a string element verbatim except for `"`, `\` and control
 * characters, which it escapes; an interest without them appears in the text as is.
 */
export function interestTextPattern(lowered: string): string | null {
  return /["\\\u0000-\u001f]/.test(lowered) ? null : `%${likeBody(lowered)}%`;
}

/** A-Z and U+212A lowered the way JS lowers them; `relatedSqlLower` (related-contacts-sql.ts) is the SQL form. */
export const RELATED_SQL_LOWER = {
  from: "ABCDEFGHIJKLMNOPQRSTUVWXYZ\u212A",
  to: "abcdefghijklmnopqrstuvwxyzk",
} as const;

/**
 * Per-contact text/alias/tag data, built once per contact instead of
 * rebuilt (corpus/aliases/tag-Sets) on every `other` the loop below visits —
 * `source`'s own corpus/aliases in particular were previously recomputed on
 * every single iteration even though `source` never changes.
 */
type ContactSignals = {
  corpus: string;
  aliases: string[];
  tagSet: Set<string>;
  interestSet: Set<string>;
};

function buildContactSignals(
  contacts: RelatedContactCandidate[]
): Map<string, ContactSignals> {
  const map = new Map<string, ContactSignals>();
  for (const c of contacts) {
    map.set(c.id, {
      corpus: contactCorpus(c),
      aliases: nameAliases(c),
      tagSet: new Set((c.tags || []).map((t) => t.toLowerCase())),
      interestSet: new Set((c.sharedInterests || []).map((t) => t.toLowerCase())),
    });
  }
  return map;
}

function mentionsOtherSignals(a: ContactSignals, b: ContactSignals) {
  if (!a.corpus) return false;
  return b.aliases.some((alias) => {
    if (alias.length < 3) return false;
    return a.corpus.includes(alias);
  });
}

/** Counts overlap with multiplicity from `aList` (raw) against `bSet` (already lowercased). */
function sharedCountFromSignals(aList: string[], bSet: Set<string>) {
  let n = 0;
  for (const t of aList) {
    if (bSet.has(t.toLowerCase())) n += 1;
  }
  return n;
}

function reasonLabel(
  reason: RelatedReason,
  source: RelatedContactCandidate
): string {
  switch (reason) {
    case "mention":
      return "Mentioned together";
    case "companyId":
    case "company":
      return source.company?.trim()
        ? `Same company · ${source.company.trim()}`
        : "Same company";
    case "howMet":
    case "event":
      return source.howMet?.trim()
        ? `Met via · ${source.howMet.trim()}`
        : "Same intro context";
    case "school":
      return source.school?.trim()
        ? `Same school · ${source.school.trim()}`
        : "Same school";
    case "sharedTags":
      return "Shared tags";
    case "sharedInterests":
      return "Shared interests";
  }
}

function bestReason(
  source: RelatedContactCandidate,
  other: RelatedContactCandidate,
  sourceSignals: ContactSignals,
  otherSignals: ContactSignals
): RelatedReason | null {
  if (
    mentionsOtherSignals(sourceSignals, otherSignals) ||
    mentionsOtherSignals(otherSignals, sourceSignals)
  ) {
    return "mention";
  }
  if (
    source.companyId &&
    other.companyId &&
    source.companyId === other.companyId
  ) {
    return "companyId";
  }
  const sourceCompany = companyKey(source.company);
  const otherCompany = companyKey(other.company);
  if (sourceCompany && sourceCompany === otherCompany) {
    return "company";
  }
  const sourceHowMet = normalizePhrase(source.howMet);
  const otherHowMet = normalizePhrase(other.howMet);
  if (sourceHowMet.length >= 3 && sourceHowMet === otherHowMet) {
    return "howMet";
  }
  const sourceSchool = normalizePhrase(source.school);
  const otherSchool = normalizePhrase(other.school);
  if (sourceSchool.length >= 3 && sourceSchool === otherSchool) {
    return "school";
  }
  if (sharedCountFromSignals(source.tags || [], otherSignals.tagSet) >= 2) {
    return "sharedTags";
  }
  if (
    sharedCountFromSignals(
      source.sharedInterests || [],
      otherSignals.interestSet
    ) >= 2
  ) {
    return "sharedInterests";
  }
  return null;
}

/**
 * Rank contacts related to `contactId` from shared company, school, howMet,
 * mentions, tags, and interests. Mixes connection strength with intro usefulness.
 */
export function findRelatedContacts(
  contactId: string,
  contacts: RelatedContactCandidate[],
  limit = 6,
  activeGoals: string[] = []
): RelatedContact[] {
  const source = contacts.find((c) => c.id === contactId);
  if (!source) return [];

  const goalTokens = activeGoals
    .flatMap((g) =>
      g
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/i)
        .filter((t) => t.length > 2)
    )
    .slice(0, 40);

  const signals = buildContactSignals(contacts);
  const sourceSignals = signals.get(source.id)!;
  const scored: Array<RelatedContact & { score: number }> = [];

  for (const other of contacts) {
    if (other.id === contactId) continue;
    const otherSignals = signals.get(other.id)!;
    const reason = bestReason(source, other, sourceSignals, otherSignals);
    if (!reason) continue;

    const weight = REASON_WEIGHT[reason];
    const strengthBoost = (other.relationshipScore ?? 2) * 4;

    const otherCorpus = otherSignals.corpus;
    let introBoost = 0;
    if (goalTokens.length > 0 && otherCorpus) {
      const hits = goalTokens.filter((t) => otherCorpus.includes(t)).length;
      introBoost = hits * 8;
    }
    // Mentions and shared company/school are especially useful intro paths
    if (reason === "mention") introBoost += 25;
    if (reason === "company" || reason === "companyId") introBoost += 12;
    if (reason === "school") introBoost += 8;

    scored.push({
      id: other.id,
      fullName: other.fullName,
      preferredName: other.preferredName ?? null,
      firstName: other.firstName ?? null,
      title: other.title ?? null,
      company: other.company ?? null,
      school: other.school ?? null,
      location: other.location ?? null,
      profileImageUrl: other.profileImageUrl ?? null,
      linkedinUrl: other.linkedinUrl ?? null,
      email: other.email ?? null,
      phone: other.phone ?? null,
      aiSummary: other.aiSummary ?? null,
      relationshipScore: other.relationshipScore ?? null,
      reason,
      reasonLabel: reasonLabel(reason, source),
      score: weight + strengthBoost + introBoost,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName));

  return scored.slice(0, limit).map(({ score: _score, ...rest }) => rest);
}
