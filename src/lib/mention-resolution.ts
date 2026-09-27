/**
 * Resolves people *mentioned* in a note (not spoken to) to existing contacts.
 *
 * Looser than `findDuplicateCandidatesIndexed` on purpose: that decides whether to MERGE
 * two records, where a false positive corrupts data. A mention only LINKS, and a wrong link
 * is one click to remove — so a unique exact name, or a unique first name, is enough.
 * Ambiguity always resolves to "unresolved"; the results view offers those as new contacts.
 */
import {
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
  type DuplicateSubject,
} from "@/lib/duplicates";
import type { MentionPick } from "@/lib/mentions/mention-picks";

export type MentionCandidate = { name: string; context: string | null; company?: string | null; nearPerson?: string | null };
export type MentionMatchedBy =
  | "exact_name"
  | "name_company"
  | "first_name_unique"
  /** The user chose them from the `@` menu. Not a guess, and never re-litigated. */
  | "user_pick"
  /** The decision model read the sentence and picked them (decisions/capture.ts). */
  | "decision";
export type ResolvedMention = { text: string; context: string | null; nearPerson: string | null; contactId: string; confidence: number; matchedBy: MentionMatchedBy };
export type UnresolvedMention = { text: string; context: string | null; nearPerson: string | null };

function normalizeName(s: string | null | undefined) {
  return (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeCompany(s: string | null | undefined) {
  return (s || "").trim().toLowerCase();
}

export function resolveMentions(
  subjects: DuplicateSubject[],
  mentions: MentionCandidate[],
  ctx?: { excludeContactIds?: Iterable<string> }
): { resolved: ResolvedMention[]; unresolved: UnresolvedMention[] } {
  const excluded = new Set(ctx?.excludeContactIds ?? []);
  const pool = subjects.filter((s) => !excluded.has(s.id));
  const index = buildDuplicateIndex(pool);
  const byFullName = new Map<string, DuplicateSubject[]>();
  const byFirstName = new Map<string, DuplicateSubject[]>();
  for (const s of pool) {
    const full = normalizeName(s.fullName);
    if (!full) continue;
    byFullName.set(full, [...(byFullName.get(full) ?? []), s]);
    const first = full.split(" ")[0];
    byFirstName.set(first, [...(byFirstName.get(first) ?? []), s]);
  }

  const resolved: ResolvedMention[] = [];
  const unresolved: UnresolvedMention[] = [];
  const seen = new Set<string>();

  for (const m of mentions) {
    // A nameless candidate is dropped, not thrown on: the people pass can emit a
    // `presence: "mentioned"` entry with a null/blank name, and one bad row must not
    // take the whole parse down.
    const text = (m.name ?? "").trim();
    if (!text) continue;
    const norm = normalizeName(text);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const company = normalizeCompany(m.company);
    const base = { text, context: m.context ?? null, nearPerson: m.nearPerson ?? null };
    const onlyWithCompany = (list: DuplicateSubject[]) =>
      company ? list.filter((s) => normalizeCompany(s.company) === company) : list;

    // Tier 1: name + company through the duplicate matcher (≥ 0.85 = its own merge bar).
    if (company && norm.includes(" ")) {
      const candidates = findDuplicateCandidatesIndexed(index, { fullName: text, company: m.company });
      const top = candidates[0];
      const runnerUp = candidates[1];
      if (top && top.confidence >= 0.85) {
        if (runnerUp && runnerUp.confidence === top.confidence) {
          unresolved.push(base);
          continue;
        }
        resolved.push({ ...base, contactId: top.contact.id, confidence: 0.9, matchedBy: "name_company" });
        continue;
      }
    }
    // Tier 2: exact full name, unique (company narrows when given).
    const fullMatches = onlyWithCompany(byFullName.get(norm) ?? []);
    if (fullMatches.length === 1) {
      resolved.push({ ...base, contactId: fullMatches[0].id, confidence: company ? 0.9 : 0.8, matchedBy: company ? "name_company" : "exact_name" });
      continue;
    }
    if (fullMatches.length > 1) { unresolved.push(base); continue; }
    // Tier 3: a single-token mention that is a unique first name.
    if (!norm.includes(" ")) {
      const firstMatches = onlyWithCompany(byFirstName.get(norm) ?? []);
      if (firstMatches.length === 1) {
        resolved.push({ ...base, contactId: firstMatches[0].id, confidence: 0.7, matchedBy: "first_name_unique" });
        continue;
      }
    }
    unresolved.push(base);
  }
  return { resolved, unresolved };
}

/**
 * A pick is a contact the user chose from a menu, so it is not a match to be made.
 *
 * Three rules, and each exists because of a specific way this goes wrong without it:
 *
 *   A PICK IS NEVER RE-LITIGATED. The three tiers above exist to guess who a name in the
 *   prose refers to. Running them over a name the user pointed at can only disagree with
 *   them, and disagreeing with the person who clicked is not a feature.
 *
 *   A PICKED NAME LEAVES THE FUZZY POOL. Otherwise `@Sam` and a tier-3 unique-first-name
 *   hit on the word "Sam" elsewhere in the note both resolve, and the two rows collapse
 *   under the unique index on `interaction_mentions` — so the save reports two mentions and
 *   writes one. Both spellings leave it: the token may be a disambiguated variant ("Chris
 *   Doyle" beside "Chris"), while the note spells the person's real name.
 *
 *   A PICK WHO IS ALREADY A PARTICIPANT IS NOT ALSO A MENTION. `excludeContactIds` is the
 *   batch's participants, and `runCaptureParse` now lets a pick BE one (it overrides the
 *   duplicate matcher for the person it names). `saveNoteBatch` drops such a mention anyway;
 *   dropping it here too stops the review screen offering someone as "also mentioned" while
 *   they are standing on their own card above it.
 *
 * Ownership is checked here rather than where the payload arrives, because `subjects` IS
 * the caller's own contact list: an id missing from it was either forged or deleted between
 * the pick and the save, and both mean the same thing — there is nobody to link to. Checking
 * at the boundary instead would cost a second query for no additional safety.
 */
export function resolveMentionsWithPicks(
  subjects: DuplicateSubject[],
  mentions: MentionCandidate[],
  picks: readonly MentionPick[],
  ctx?: { excludeContactIds?: Iterable<string> }
): { resolved: ResolvedMention[]; unresolved: UnresolvedMention[] } {
  const owned = new Map(subjects.map((s) => [s.id, s]));
  const excluded = new Set(ctx?.excludeContactIds ?? []);
  const seenIds = new Set<string>();
  const pickedNames = new Set<string>();
  const fromPicks: ResolvedMention[] = [];
  for (const pick of picks) {
    const subject = owned.get(pick.id);
    if (!subject || seenIds.has(pick.id)) continue;
    seenIds.add(pick.id);
    // Outside the `excluded` check on purpose: a participant's name having an answer is
    // exactly why the tiers must not have another go at it further down.
    for (const name of [pick.name, subject.fullName]) {
      const norm = normalizeName(name);
      if (norm) pickedNames.add(norm);
    }
    if (excluded.has(pick.id)) continue;
    fromPicks.push({
      text: pick.name,
      context: null,
      nearPerson: null,
      contactId: pick.id,
      confidence: 1,
      matchedBy: "user_pick",
    });
  }

  const rest = mentions.filter((m) => !pickedNames.has(normalizeName(m.name ?? "")));
  const { resolved, unresolved } = resolveMentions(subjects, rest, ctx);
  return { resolved: [...fromPicks, ...resolved], unresolved };
}
