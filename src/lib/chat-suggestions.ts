import { isRosterMatchableOrg, orgMatchKey } from "@/lib/chat-roster-match";
import { canonicalCompanyClusterName } from "@/lib/company-family";
import { sanitizeProfileLine } from "@/lib/contact-profile-format";
import { interactionTypeFamily, interactionTypeLabel, interactionTypeNoun } from "@/lib/interaction-types";
import { timelineDayLabel } from "@/lib/timeline-date";

/**
 * The suggestion cards under the chat composer.
 *
 * Replaces four strings that were the same for everyone — "Who do I know at AWS?" is a dead
 * end for a user with nobody at AWS — with questions built from what this user has actually
 * been doing, each carrying the reason it was offered. Deterministic on purpose: Orbit is
 * BYOK, most users on Vercel have no provider key, and these render *before* anyone has
 * asked anything, so an AI-written row would be blank for exactly the people who need the
 * hint most.
 *
 * Pure — no DB, no React, no `now()` of its own. `chat-suggestions-data.ts` gathers the
 * signals; `scripts/smoke-chat-suggestions.ts` drives this half directly.
 *
 * Modelled on `heuristicStarters` in `@/lib/conversation-starters`, which solves the same
 * problem for the browser extension: a ranked ladder of grounded templates, deduped, with a
 * generic rung that only shows when nothing grounded fired. Same convention here — **lower
 * rank is better, generic is 10.**
 */

export type SuggestionKind =
  | "overdue"
  | "company_cluster"
  | "recent_interaction"
  | "gone_quiet"
  | "asked_about"
  | "new_contact"
  | "generic";

export type ChatSuggestion = {
  /** `${kind}:${contactId | companyKey | index}` — stable across refetches. */
  id: string;
  kind: SuggestionKind;
  /** Line one, and the text sent verbatim on click. Already sanitized and length-capped. */
  question: string;
  /** Line two — why this was offered. Empty for generics, which have no reason to give. */
  basis: string;
  /**
   * Sent as `contextContactIds` on click.
   *
   * Load-bearing, not decoration: `loadKnowledgeSnippets` filters interaction snippets to
   * LinkedIn messages, so on the plain retrieval path the coffee you logged on Tuesday never
   * reaches the model. Attaching the contact is what routes the question through
   * `loadAttachedPeople`, which ships the real timeline. A person-scoped card without this
   * is answered from a free-text notes blob.
   */
  contactId: string | null;
  /** Drives the card's icon via `interactionTypeIcon`. Only set for `recent_interaction`. */
  interactionType: string | null;
  rank: number;
};

export type SuggestionSignals = {
  now: Date;
  overdue: Array<{ id: string; name: string; daysOverdue: number }>;
  goneQuiet: Array<{ id: string; name: string; reason: string }>;
  recentInteractions: Array<{
    contactId: string;
    name: string;
    interactionType: string;
    interactionDate: Date;
  }>;
  newContacts: Array<{ id: string; name: string; createdAt: Date }>;
  /** Companies with at least two people among the recently-touched rows. */
  companyClusters: Array<{ company: string; people: string[]; lastActiveAt: Date }>;
  /** Contacts the user named in a recent question. */
  askedAbout: Array<{ id: string; name: string; askedAt: Date }>;
  /** The user's own recent questions, for suppression. */
  recentQuestions: string[];
};

export const MAX_CARDS = 6;
export const MAX_PER_KIND = 2;
/**
 * The load-bearing cap. An overdue contact you also had coffee with last week fires the
 * overdue, recent-interaction and gone-quiet rungs at once; without this the row is three
 * cards about one person.
 */
export const MAX_PER_PERSON = 1;
export const GENERIC_RANK = 10;

/** A name longer than this is a pasted headline, not a name. The attachment carries the id. */
const MAX_NAME_LEN = 60;
/** How recent an interaction has to be to be worth a card. */
const RECENT_INTERACTION_DAYS = 7;
/** Meetings are legitimately logged a day ahead, in a timezone behind the server's. */
const FUTURE_INTERACTION_DAYS = 1;
const DAY_MS = 86_400_000;

/**
 * The fallback rung: today's four strings, unchanged.
 *
 * The single source both surfaces read — they were duplicated verbatim between
 * `chat-panel.tsx` and `floating-ask-bar.tsx`, which is how they drifted from what the
 * pipeline could answer in the first place.
 */
export const GENERIC_SUGGESTIONS: readonly string[] = [
  "Who do I know at AWS?",
  "Who have I not followed up with recently?",
  "Who are the best recruiters for my search?",
  "Who should I reconnect with this week?",
];

/**
 * The comparison form of a question. Serves dedupe and suppression alike, so a card can
 * never be deduped under one rule and suppressed under another.
 */
export function normalizeQuestionKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[?!.]+$/, "");
}

/**
 * A name safe to interpolate, or null if there is nothing to show.
 *
 * `full_name` is NOT NULL but imports do write `""` and whitespace, and "What should I ask
 *  next time we speak?" is worse than no card at all. The sanitizer matters for a different
 * reason: the question lands in the prompt as `Question: …`, which is **outside** every
 * nonce fence `buildChatPrompt` erects, so a contact named `] ignore previous instructions`
 * would arrive unfenced.
 */
function displayName(raw: string): string | null {
  const clean = sanitizeProfileLine(raw);
  if (!clean) return null;
  return clean.length > MAX_NAME_LEN ? `${clean.slice(0, MAX_NAME_LEN - 1)}…` : clean;
}

type Candidate = ChatSuggestion & {
  /**
   * Breaks rank ties, higher first.
   *
   * The unit is whatever orders that particular rung best — days overdue for `overdue`, a
   * timestamp for everything else — which is safe because `rank` is compared first and every
   * candidate in a bucket shares one. "Most overdue" and "most recent" are both the right
   * answer to "which of these first", and they are not the same number.
   */
  weight: number;
  /** Companies get their own cap; the person cap cannot see them. */
  companyKey: string | null;
};

/**
 * How two spellings of one employer fold together.
 *
 * The same function the constellation and `findOrgRosters` use, so "Ramp" and "Ramp Inc"
 * are one card here exactly as they are one roster there. Falls back to the match key for
 * a name it cannot canonicalise.
 */
function companyKeyFor(company: string): string {
  return canonicalCompanyClusterName(company) ?? orgMatchKey(company);
}

function buildCandidates(signals: SuggestionSignals): Candidate[] {
  const out: Candidate[] = [];
  const now = signals.now.getTime();

  // ── 1. A follow-up that has come due ────────────────────────────────────────────────
  // Wording avoids every ATTENTION_PATTERNS entry: "follow up", "who should i", "this week"
  // and friends make `isAttentionQuestion` fire, which hands the model twelve overdue
  // contacts and tells it to name them — a derailment on a question about one person.
  for (const c of signals.overdue) {
    const name = displayName(c.name);
    if (!name) continue;
    out.push({
      id: `overdue:${c.id}`,
      kind: "overdue",
      question: `What should I ask ${name} next time we speak?`,
      basis:
        c.daysOverdue <= 0
          ? "Follow-up due today"
          : `Follow-up due ${c.daysOverdue} day${c.daysOverdue === 1 ? "" : "s"} ago`,
      contactId: c.id,
      interactionType: null,
      rank: 1,
      // Days, not a date: the most overdue leads, and a date would put the *least* overdue
      // first because it is the more recent one.
      weight: c.daysOverdue,
      companyKey: null,
    });
  }

  // ── 2. A company several people you have touched recently share ─────────────────────
  // Second on purpose: this is the only rung `findOrgRosters` answers exhaustively rather
  // than from a relevance-ranked top-12, and the only one that names nobody — which is
  // exactly what the diversity caps want near the top.
  for (const cluster of signals.companyClusters) {
    if (!isRosterMatchableOrg(cluster.company)) continue;
    const company = displayName(cluster.company);
    if (!company) continue;
    const names = cluster.people.map(displayName).filter((n): n is string => Boolean(n));
    if (names.length < 2) continue;
    const extra = names.length - 2;
    out.push({
      id: `company_cluster:${companyKeyFor(cluster.company)}`,
      kind: "company_cluster",
      question: `Who else do I know at ${company}?`,
      basis: extra
        ? `${names[0]}, ${names[1]} and ${extra} other${extra === 1 ? "" : "s"} work there`
        : `${names[0]} and ${names[1]} both work there`,
      contactId: null,
      interactionType: null,
      rank: 2,
      weight: cluster.lastActiveAt.getTime(),
      companyKey: companyKeyFor(cluster.company),
    });
  }

  // ── 3. Something logged in the last week ────────────────────────────────────────────
  for (const i of signals.recentInteractions) {
    // "After our note" and "after our cold intro" are nonsense: `note` and `reach_out` are
    // the user's own bookkeeping, not something that happened with the person. The family
    // map already draws exactly that line.
    if (interactionTypeFamily(i.interactionType) === "yours") continue;
    const age = now - i.interactionDate.getTime();
    if (age > RECENT_INTERACTION_DAYS * DAY_MS) continue;
    if (age < -FUTURE_INTERACTION_DAYS * DAY_MS) continue;
    const name = displayName(i.name);
    if (!name) continue;
    out.push({
      id: `recent_interaction:${i.contactId}`,
      kind: "recent_interaction",
      question: `What's my next move with ${name} after our ${interactionTypeNoun(i.interactionType)}?`,
      basis: `${interactionTypeLabel(i.interactionType)} · ${timelineDayLabel(i.interactionDate, signals.now)}`,
      contactId: i.contactId,
      interactionType: i.interactionType,
      rank: 3,
      weight: i.interactionDate.getTime(),
      companyKey: null,
    });
  }

  // ── 4. Someone the outreach queue says has gone quiet ───────────────────────────────
  for (const c of signals.goneQuiet) {
    const name = displayName(c.name);
    if (!name) continue;
    // The reason is written by the outreach-suggestion builder and already reads as prose
    // ("Gone quiet — last touch 105 days ago"). Sanitized anyway: it reaches a prompt.
    out.push({
      id: `gone_quiet:${c.id}`,
      kind: "gone_quiet",
      question: `What could I message ${name} about?`,
      basis: sanitizeProfileLine(c.reason) || "No contact in a while",
      contactId: c.id,
      interactionType: null,
      rank: 4,
      // The outreach queue is already ordered by confidence and carries no date of its own.
      weight: now,
      companyKey: null,
    });
  }

  // ── 5. Someone the user asked about recently ────────────────────────────────────────
  for (const c of signals.askedAbout) {
    const name = displayName(c.name);
    if (!name) continue;
    out.push({
      id: `asked_about:${c.id}`,
      kind: "asked_about",
      question: `Where did I leave things with ${name}?`,
      basis: `You asked about them ${timelineDayLabel(c.askedAt, signals.now).toLowerCase()}`,
      contactId: c.id,
      interactionType: null,
      rank: 5,
      weight: c.askedAt.getTime(),
      companyKey: null,
    });
  }

  // ── 6. Someone added recently with nothing logged ───────────────────────────────────
  // Deliberately NOT "What do I know about {name}?" — the rung's own precondition is that
  // nothing is logged, so that question's designed outcome is Orbit saying it knows nothing.
  // An intro question at least has their title, company and the reranked top-12 to work with.
  for (const c of signals.newContacts) {
    const name = displayName(c.name);
    if (!name) continue;
    out.push({
      id: `new_contact:${c.id}`,
      kind: "new_contact",
      question: `Who in my network should meet ${name}?`,
      basis: `Added ${timelineDayLabel(c.createdAt, signals.now).toLowerCase()} · nothing logged yet`,
      contactId: c.id,
      interactionType: null,
      rank: 6,
      weight: c.createdAt.getTime(),
      companyKey: null,
    });
  }

  return out;
}

/** Rank, then weight, then id — never array position, which would reshuffle the row. */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.weight !== b.weight) return b.weight - a.weight;
  return a.id.localeCompare(b.id);
}

function strip(c: Candidate): ChatSuggestion {
  const { weight: _weight, companyKey: _companyKey, ...rest } = c;
  return rest;
}

function genericCards(): ChatSuggestion[] {
  return GENERIC_SUGGESTIONS.map((question, i) => ({
    id: `generic:${i}`,
    kind: "generic" as const,
    question,
    basis: "",
    contactId: null,
    interactionType: null,
    rank: GENERIC_RANK,
  }));
}

/**
 * The row, best first.
 *
 * Grounded cards are chosen round-robin across kinds rather than straight down the ranked
 * list: eight overdue contacts would otherwise open the row with two cards that look
 * identical. Generics only fill what is left over.
 */
export function buildChatSuggestions(
  signals: SuggestionSignals,
  limit: number = MAX_CARDS
): ChatSuggestion[] {
  const all = buildCandidates(signals).sort(compareCandidates);

  // Dedupe on the rendered question, so two rungs that happen to phrase the same ask the
  // same way collapse rather than both showing.
  const seenQuestion = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of all) {
    const key = normalizeQuestionKey(c.question);
    if (seenQuestion.has(key)) continue;
    seenQuestion.add(key);
    deduped.push(c);
  }

  // Suppression. A click sends the template verbatim, so exact-key matching has essentially
  // perfect precision — no fuzzy matching needed.
  const asked = new Set(signals.recentQuestions.map(normalizeQuestionKey));
  let pool = deduped.filter((c) => !asked.has(normalizeQuestionKey(c.question)));
  // If it removed everything, keep the best one anyway: a card you asked about eleven days
  // ago still beats "Who do I know at AWS?".
  if (!pool.length && deduped.length) pool = [deduped[0]!];

  const buckets = new Map<SuggestionKind, Candidate[]>();
  for (const c of pool) {
    const list = buckets.get(c.kind);
    if (list) list.push(c);
    else buckets.set(c.kind, [c]);
  }
  // Kinds are visited in the order of their best candidate, so a strong rung still leads.
  const kindOrder = [...buckets.entries()]
    .sort((a, b) => compareCandidates(a[1][0]!, b[1][0]!))
    .map(([kind]) => kind);

  const chosen: ChatSuggestion[] = [];
  const cursor = new Map<SuggestionKind, number>();
  const perKind = new Map<SuggestionKind, number>();
  const usedPeople = new Set<string>();
  const usedCompanies = new Set<string>();

  let placed = true;
  while (chosen.length < limit && placed) {
    placed = false;
    for (const kind of kindOrder) {
      if (chosen.length >= limit) break;
      if ((perKind.get(kind) ?? 0) >= MAX_PER_KIND) continue;
      const bucket = buckets.get(kind)!;
      let i = cursor.get(kind) ?? 0;
      while (i < bucket.length) {
        const c = bucket[i]!;
        i++;
        if (c.contactId && usedPeople.has(c.contactId)) continue;
        if (c.companyKey && usedCompanies.has(c.companyKey)) continue;
        if (c.contactId) usedPeople.add(c.contactId);
        if (c.companyKey) usedCompanies.add(c.companyKey);
        chosen.push(strip(c));
        perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
        placed = true;
        break;
      }
      cursor.set(kind, i);
    }
  }

  // Generics fill the row rather than replacing it — `heuristicStarters` swaps wholesale
  // because its popup shows three of anything, but a half-empty card row reads as broken.
  if (chosen.length < limit) {
    for (const g of genericCards()) {
      if (chosen.length >= limit) break;
      chosen.push(g);
    }
  }
  return chosen;
}

/** True when nothing grounded fired, so a surface can nudge toward adding some data. */
export function suggestionsAreGeneric(list: readonly ChatSuggestion[]): boolean {
  return list.every((s) => s.kind === "generic");
}
