import { isAttentionQuestion } from "@/lib/chat-attention-match";
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
  | "commitment"
  | "company_cluster"
  | "recent_interaction"
  | "mention"
  | "gone_quiet"
  | "asked_about"
  | "goal_match"
  | "new_contact"
  | "starter_company"
  | "newest_contact"
  | "generic";

/**
 * What a card is *for*, as a reader would describe it — never rendered.
 *
 * `MAX_PER_KIND` caps repeats of one rule, but `overdue`, `gone_quiet` and `commitment` are
 * all "someone is waiting on you" to anyone looking at the row. Three of them reads as one
 * suggestion printed three times. The first selection pass takes at most one card per
 * category, which is the level the repetition is actually visible at.
 */
export type SuggestionCategory =
  | "follow-up"
  | "explore"
  | "prepare"
  | "connect"
  | "revisit"
  | "pursue"
  | "start";

export const CATEGORY_FOR: Record<SuggestionKind, SuggestionCategory> = {
  overdue: "follow-up",
  commitment: "follow-up",
  gone_quiet: "follow-up",
  company_cluster: "explore",
  recent_interaction: "prepare",
  mention: "connect",
  new_contact: "connect",
  asked_about: "revisit",
  goal_match: "pursue",
  starter_company: "start",
  newest_contact: "start",
  generic: "start",
};

export type ChatSuggestion = {
  /** `${kind}:${contactId | companyKey | index}` — stable across refetches. */
  id: string;
  kind: SuggestionKind;
  /** Line one, and the text sent verbatim on click. Already sanitized and length-capped. */
  question: string;
  /** Line two — why this was offered. Empty for generics, which have no reason to give. */
  basis: string;
  /**
   * Sent as `contextContactIds` on click. Empty for cards about no one in particular.
   *
   * An array because `mention` is about a pair — "what is the connection between A and B"
   * needs both timelines to be answerable at all. Attaching is what routes a question
   * through `loadAttachedPeople`; retrieval alone gives the model a much thinner picture of
   * someone than the attached block does.
   */
  contactIds: readonly string[];
  /** Drives the card's icon via `interactionTypeIcon`. Only set for `recent_interaction`. */
  interactionType: string | null;
  rank: number;
};

export type SuggestionSignals = {
  now: Date;
  /**
   * `lastDiscussed` is the one-line summary from their contact brief, when there is one.
   *
   * Urgency without a subject is half the story: "follow-up due 6 days ago" says you should
   * write, not whether you have anything to say. The brief already holds a sentence about
   * what you last talked about, written when it was fresh.
   */
  overdue: Array<{
    id: string;
    name: string;
    daysOverdue: number;
    lastDiscussed?: string | null;
  }>;
  goneQuiet: Array<{
    id: string;
    name: string;
    reason: string;
    lastDiscussed?: string | null;
  }>;
  recentInteractions: Array<{
    contactId: string;
    name: string;
    interactionType: string;
    interactionDate: Date;
  }>;
  /**
   * Recently added contacts, unfiltered.
   *
   * One query serves two rungs: `new_contact` wants the recent ones with nothing logged,
   * the `newest_contact` starter wants the single most recent whenever it was added. The
   * emptiness tests come back as flags rather than a `WHERE`, so the starter still fires
   * for someone whose whole network is annotated.
   */
  newContacts: Array<{
    id: string;
    name: string;
    company: string | null;
    createdAt: Date;
    notesEmpty: boolean;
    hasInteraction: boolean;
  }>;
  /** Pending dated commitments the capture flow extracted from the user's own notes. */
  commitments: Array<{ contactId: string; name: string; phrase: string }>;
  /** A contact named in a note written about somebody else. */
  mentions: Array<{
    id: string;
    name: string;
    inNoteAboutId: string;
    inNoteAboutName: string;
    times: number;
    lastAt: Date;
  }>;
  /** Active goals, and whichever in-hand contact best matches each. */
  goalMatches: Array<{ id: string; name: string; goal: string; score: number }>;
  /** The user's largest employer cluster, any time — the cold-start rung. */
  biggestCompany: { company: string; total: number } | null;
  /** Companies with at least two people among the recently-touched rows. */
  companyClusters: Array<{ company: string; people: string[]; lastActiveAt: Date }>;
  /** Contacts the user named in a recent question. */
  askedAbout: Array<{ id: string; name: string; askedAt: Date }>;
  /** The user's own recent questions, for suppression. */
  recentQuestions: string[];
};

export const MAX_CARDS = 6;
export const MAX_PER_KIND = 2;
/** The first pass takes one card per category; the second fills up to `MAX_PER_KIND`. */
export const MAX_PER_CATEGORY = 1;
/**
 * The load-bearing cap. An overdue contact you also had coffee with last week fires the
 * overdue, recent-interaction and gone-quiet rungs at once; without this the row is three
 * cards about one person.
 */
export const MAX_PER_PERSON = 1;
/** Grounded but not recent — the cold-start tier, below every windowed rung. */
export const STARTER_RANK = 20;
export const GENERIC_RANK = 30;
/** "Who else do I know at X" needs at least one else. */
export const MIN_STARTER_COMPANY_SIZE = 2;
/** Below this a goal match is a coincidence, and a coincidence is worse than no card. */
export const MIN_GOAL_SCORE = 0.12;

/** A name longer than this is a pasted headline, not a name. The attachment carries the id. */
const MAX_NAME_LEN = 60;
/** How recently someone must have been added for "nothing logged yet" to be news. */
const NEW_CONTACT_DAYS = 14;
/** How recent an interaction has to be to be worth a card. */
const RECENT_INTERACTION_DAYS = 7;
/** Meetings are legitimately logged a day ahead, in a timezone behind the server's. */
const FUTURE_INTERACTION_DAYS = 1;
const DAY_MS = 86_400_000;

/**
 * The last resort, for an account with nothing in it at all.
 *
 * Two, not four. The other two were actively bad and are deleted: "Who do I know at AWS?"
 * names a company most users do not have, so it becomes a relevance-ranked guess under a
 * question that implies a count; and "Who are the best recruiters for my search?" fires
 * `isRecruiterIntent`, but a user who is not sharing and has logged no recruiters gets zero
 * recruiter rows, so the block and its prompt rule vanish and the question ends up keyword-
 * searching contacts for the word "recruiter".
 *
 * These two survive because both reach the attention brief, which is the only path that
 * grounds with no data at all. They are near-duplicates on purpose — an empty row reads as
 * broken, and there is no third generic shape the pipeline answers well.
 */
export const GENERIC_SUGGESTIONS: readonly string[] = [
  "Who should I reconnect with this week?",
  "Who have I not followed up with recently?",
];

/**
 * What the floating ask bar offers when it is opened on somebody's page.
 *
 * Here rather than inside the bar so it is testable next to everything else — and it needed
 * to be. "Suggest a warm follow-up angle" contained "follow-up", which fires
 * `isAttentionQuestion` and hands the model twelve overdue contacts on a question that is
 * scoped to one person. It never went through the audit the general set did.
 *
 * These reach the model through `focusContactId`, not `contextContactIds` — a stronger
 * path, since it also carries the contact's whole stored profile and twelve of their
 * interactions regardless of type. So they can ask things the general set cannot.
 */
export const CONTACT_PAGE_SUGGESTIONS: readonly string[] = [
  "What should I know before we talk?",
  "Summarize our relationship",
  "What have we talked about recently?",
  "What could I message them about?",
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

/** How much of a remembered conversation fits a tooltip before it stops being glanceable. */
const SUBJECT_MAX_LEN = 70;

/** "Follow-up due 6 days ago" plus what it was about, when the brief remembers. */
function withSubject(base: string, lastDiscussed?: string | null): string {
  const subject = sanitizeProfileLine(lastDiscussed ?? "");
  if (!subject) return base;
  const clipped =
    subject.length > SUBJECT_MAX_LEN ? `${subject.slice(0, SUBJECT_MAX_LEN - 1)}…` : subject;
  return `${base} · last talked about ${clipped}`;
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
      basis: withSubject(
        c.daysOverdue <= 0
          ? "Follow-up due today"
          : `Follow-up due ${c.daysOverdue} day${c.daysOverdue === 1 ? "" : "s"} ago`,
        c.lastDiscussed
      ),
      contactIds: [c.id],
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
      contactIds: [],
      interactionType: null,
      rank: 3,
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
      contactIds: [i.contactId],
      interactionType: i.interactionType,
      rank: 4,
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
      basis: withSubject(sanitizeProfileLine(c.reason) || "No contact in a while", c.lastDiscussed),
      contactIds: [c.id],
      interactionType: null,
      rank: 6,
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
      contactIds: [c.id],
      interactionType: null,
      rank: 7,
      weight: c.askedAt.getTime(),
      companyKey: null,
    });
  }

  // ── 6. Someone added recently with nothing logged ───────────────────────────────────
  // Deliberately NOT "What do I know about {name}?" — the rung's own precondition is that
  // nothing is logged, so that question's designed outcome is Orbit saying it knows nothing.
  // An intro question at least has their title, company and the reranked top-12 to work with.
  for (const c of signals.newContacts) {
    // Gated here rather than in SQL, because the same query feeds the `newest_contact`
    // starter, which wants the most recent person however well annotated they are.
    if (!c.notesEmpty || c.hasInteraction) continue;
    if (now - c.createdAt.getTime() > NEW_CONTACT_DAYS * DAY_MS) continue;
    const name = displayName(c.name);
    if (!name) continue;
    out.push({
      id: `new_contact:${c.id}`,
      kind: "new_contact",
      question: `Who in my network should meet ${name}?`,
      basis: `Added ${timelineDayLabel(c.createdAt, signals.now).toLowerCase()} · nothing logged yet`,
      contactIds: [c.id],
      interactionType: null,
      rank: 9,
      weight: c.createdAt.getTime(),
      companyKey: null,
    });
  }

  // ── A promise you made, with a date on it ───────────────────────────────────────────
  // The basis quotes the user's own note back at them, which is the most concrete reason
  // line anywhere in this feature.
  for (const c of signals.commitments) {
    const name = displayName(c.name);
    if (!name) continue;
    const phrase = sanitizeProfileLine(c.phrase).slice(0, 80);
    out.push({
      id: `commitment:${c.contactId}`,
      kind: "commitment",
      question: `What did I promise ${name}?`,
      basis: phrase ? `From your notes: "${phrase}"` : "A dated commitment in your notes",
      contactIds: [c.contactId],
      interactionType: null,
      rank: 2,
      weight: now,
      companyKey: null,
    });
  }

  // ── Someone who came up in a note about somebody else ───────────────────────────────
  // The only rung that attaches two people, because the question is about the pair and
  // neither timeline alone answers it.
  for (const m of signals.mentions) {
    const name = displayName(m.name);
    const other = displayName(m.inNoteAboutName);
    if (!name || !other || m.id === m.inNoteAboutId) continue;
    out.push({
      id: `mention:${m.id}:${m.inNoteAboutId}`,
      kind: "mention",
      question: `What's the connection between ${name} and ${other}?`,
      basis:
        m.times > 1
          ? `Came up in your notes about ${other}, ${m.times} times`
          : `Came up in your notes about ${other}`,
      contactIds: [m.id, m.inNoteAboutId],
      interactionType: null,
      rank: 5,
      weight: m.lastAt.getTime(),
      companyKey: null,
    });
  }

  // ── Someone who fits a goal you actually wrote down ─────────────────────────────────
  for (const g of signals.goalMatches) {
    if (g.score < MIN_GOAL_SCORE) continue;
    const name = displayName(g.name);
    const goal = sanitizeProfileLine(g.goal).slice(0, 80);
    if (!name || !goal) continue;
    out.push({
      id: `goal_match:${g.id}`,
      kind: "goal_match",
      // The goal is the user's own text landing inside a question, which is outside every
      // fence `buildChatPrompt` erects — hence the sanitize and the cap above. It is also
      // why the `isAttentionQuestion` guard below stopped being a wording discipline: a
      // goal like "reconnect with old colleagues" would trip it.
      question: `Could ${name} help me with ${goal}?`,
      basis: `Matches your goal: ${goal}`,
      contactIds: [g.id],
      interactionType: null,
      rank: 8,
      weight: g.score,
      companyKey: null,
    });
  }

  // ── The cold-start tier: grounded, but with no recency requirement ──────────────────
  // These fire when every windowed rung above came up empty, which is most of a new
  // account's life. A default that names a real person beats one that names AWS.
  // Two, not one: "who ELSE do I know at Linear?" when Linear is one person is a question
  // whose only honest answer is "nobody", and its basis would read "1 people work there".
  if (
    signals.biggestCompany &&
    signals.biggestCompany.total >= MIN_STARTER_COMPANY_SIZE &&
    isRosterMatchableOrg(signals.biggestCompany.company)
  ) {
    const company = displayName(signals.biggestCompany.company);
    if (company) {
      out.push({
        id: `starter_company:${companyKeyFor(signals.biggestCompany.company)}`,
        kind: "starter_company",
        question: `Who else do I know at ${company}?`,
        basis: `${signals.biggestCompany.total} people work there`,
        contactIds: [],
        interactionType: null,
        rank: STARTER_RANK,
        weight: signals.biggestCompany.total,
        companyKey: companyKeyFor(signals.biggestCompany.company),
      });
    }
  }
  const newest = [...signals.newContacts].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  )[0];
  if (newest) {
    const name = displayName(newest.name);
    if (name) {
      out.push({
        id: `newest_contact:${newest.id}`,
        kind: "newest_contact",
        question: `What should I ask ${name} next time we speak?`,
        basis: "The most recent person you added",
        contactIds: [newest.id],
        interactionType: null,
        rank: STARTER_RANK,
        weight: newest.createdAt.getTime(),
        companyKey: null,
      });
    }
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
    contactIds: [],
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
  const all = buildCandidates(signals)
    // The wording rule, enforced rather than remembered. `isAttentionQuestion` matches bare
    // substrings — "quiet", "cold", "this week", "who should i", "follow up" — and when it
    // fires the prompt gains twelve overdue contacts and an instruction to name them, which
    // fights the attached block on a question about one person. This stopped being a
    // discipline the moment `goal_match` shipped: the goal is the user's own text landing
    // inside the question, and a goal like "reconnect with old colleagues" trips it.
    // Generics are exempt — reaching the attention brief is exactly what they are for.
    .filter((c) => c.kind === "generic" || !isAttentionQuestion(c.question))
    .sort(compareCandidates);

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
  const perCategory = new Map<SuggestionCategory, number>();
  const usedPeople = new Set<string>();
  const usedCompanies = new Set<string>();

  // Two passes. The first takes at most one card per CATEGORY, which is the level a reader
  // notices repetition at — three "someone is waiting on you" cards read as one suggestion
  // printed three times, however different their rules are. The second pass then fills any
  // remaining slots up to `MAX_PER_KIND`, so a user whose only signal is eight overdue
  // contacts still gets a full row rather than one card and five fillers.
  const runPass = (categoryCap: number) => {
    let placed = true;
    while (chosen.length < limit && placed) {
      placed = false;
      for (const kind of kindOrder) {
        if (chosen.length >= limit) break;
        if ((perKind.get(kind) ?? 0) >= MAX_PER_KIND) continue;
        const category = CATEGORY_FOR[kind];
        if ((perCategory.get(category) ?? 0) >= categoryCap) continue;
        const bucket = buckets.get(kind)!;
        let i = cursor.get(kind) ?? 0;
        while (i < bucket.length) {
          const c = bucket[i]!;
          i++;
          // Every person on the card counts against the per-person cap, so a mention card
          // about A and B blocks a later card about either of them.
          if (c.contactIds.some((id) => usedPeople.has(id))) continue;
          if (c.companyKey && usedCompanies.has(c.companyKey)) continue;
          for (const id of c.contactIds) usedPeople.add(id);
          if (c.companyKey) usedCompanies.add(c.companyKey);
          chosen.push(strip(c));
          perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
          perCategory.set(category, (perCategory.get(category) ?? 0) + 1);
          placed = true;
          break;
        }
        cursor.set(kind, i);
      }
    }
  };
  runPass(MAX_PER_CATEGORY);
  runPass(Number.POSITIVE_INFINITY);

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
