/**
 * Conversation starters for the browser extension.
 *
 * Two halves, and the order they were built in matters: `heuristicStarters` is
 * pure, synchronous, needs no AI key and no extra queries, and is good enough
 * to ship on its own. It is the instant-paint layer in the popup, the fallback
 * whenever a model call fails, and the *entire* experience for anyone who has
 * not configured a provider key — which on Vercel is every user who hasn't
 * opted in, since env keys are ignored there.
 *
 * The AI half only ever replaces heuristic output; it never gates it.
 *
 * Nothing here invents facts. Every heuristic template interpolates values that
 * are present in the context, and every AI starter must carry a `basis` naming
 * the specific fact it came from or it is dropped — an ungrounded suggestion is
 * worse than none, because it teaches the user to stop trusting the feature.
 */

import type {
  ConversationStarter,
  FieldChange,
  PageContext,
  StarterKind,
  StarterMode,
} from "@/lib/extension/contract";
import { daysAgo } from "@/lib/duplicates";

export type StarterContact = {
  id: string;
  fullName: string;
  preferredName?: string | null;
  company?: string | null;
  title?: string | null;
  school?: string | null;
  keyFacts?: string[] | null;
  sharedInterests?: string[] | null;
  opportunities?: string[] | null;
  lastInteractionAt?: Date | string | null;
};

export type StarterInteraction = {
  interactionType: string;
  interactionDate: Date | string | null;
  aiSummary: string | null;
  rawNotes: string | null;
  topics: string[];
  actionItems: string[];
};

export type StarterContext = {
  mode: StarterMode;
  page: PageContext;
  contact: StarterContact | null;
  tags: string[];
  recentInteractions: StarterInteraction[];
  openReminders: { title: string; dueDate: Date | string | null }[];
  userGoals: string[];
  /**
   * Companies and schools from the rest of the user's network that this person
   * also belongs to. The thing that makes a cold starter feel like *Orbit*
   * rather than a generic AI plugin.
   */
  networkOverlap: { companies: string[]; schools: string[] };
  /** Field-level disagreements between the page and the stored record. */
  changes: FieldChange[];
};

const DEFAULT_LIMIT = 3;
/** Rank of the last-resort generic rung in both ladders. */
const GENERIC_RANK = 10;

type Ranked = { rank: number; starter: Omit<ConversationStarter, "id" | "source"> };

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

export function pageValue(
  field: PageContext["identity"][keyof PageContext["identity"]]
): string | null {
  const value = field?.value?.trim();
  return value ? value : null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function firstNonEmpty(values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }
  return null;
}

/** "3 weeks" / "5 months" / "over a year" — never an ISO date, in any copy. */
function humanGap(days: number): string | null {
  if (!Number.isFinite(days) || days < 14) return null;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  return "over a year";
}

/**
 * Prepare a stored value for mid-sentence use.
 *
 * Only lowercases the first letter when the phrase is plain sentence case —
 * no acronyms, no internal capitals. Stored values are frequently proper nouns
 * ("VP Engineering", "Osaka marathon"), and lowercasing those reads far worse
 * than leaving a capital alone. Templates that commonly receive proper nouns
 * are instead written so the value can lead a clause.
 */
function fragment(value: string): string {
  const trimmed = value.trim().replace(/[.!?]+$/, "");
  const [first, ...rest] = trimmed.split(/\s+/);
  if (!first) return trimmed;
  const hasInternalCapital = rest.some((word) => /^[A-Z]/.test(word));
  const isAcronym = /^[A-Z0-9&.-]+$/.test(first);
  if (hasInternalCapital || isAcronym) return trimmed;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/**
 * Capitalize a stored value that begins a sentence. Always safe — unlike
 * lowercasing, raising the first letter never mangles a proper noun.
 */
function leadWith(value: string): string {
  const trimmed = value.trim().replace(/[.!?]+$/, "");
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * A headline that is just "<title> at <company>" carries nothing the title and
 * company fields don't already say, and quoting it back produces nonsense like
 * "Your work on Product Manager at Stripe caught my eye".
 */
function headlineAddsNothing(
  clause: string,
  title: string | null,
  company: string | null
): boolean {
  const normalized = clause.toLowerCase().replace(/\s+/g, " ").trim();
  const t = title?.toLowerCase().trim();
  const c = company?.toLowerCase().trim();
  if (t && normalized === t) return true;
  if (t && c && normalized === `${t} at ${c}`) return true;
  // Nothing beyond the title and company plus filler.
  if (t && c) {
    const remainder = normalized
      .replace(t, "")
      .replace(c, "")
      .replace(/\b(at|@|\||,|-)\b/g, "")
      .trim();
    if (remainder.length <= 3) return true;
  }
  return false;
}

/**
 * A headline is usually a title-and-company string ("VP Eng at Stripe |
 * ex-Google | speaker"). Take the first clause that reads like a claim about
 * their work, so we quote something specific rather than the whole soup.
 */
function headlineClause(headline: string | null): string | null {
  if (!headline) return null;
  const clause = headline
    .split(/[|·•—–]|(?:\s+\/\s+)/)[0]
    ?.trim()
    .replace(/\s+/g, " ");
  if (!clause || clause.length < 12 || clause.length > 120) return null;
  return clause;
}

function goalMatch(text: string | null, goals: string[]): string | null {
  if (!text) return null;
  const haystack = text.toLowerCase();
  for (const goal of goals) {
    const words = goal
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 4);
    if (words.some((word) => haystack.includes(word))) return goal;
  }
  return null;
}

function dedupeByText(items: Ranked[]): Ranked[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.starter.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* The ladders                                                                */
/* -------------------------------------------------------------------------- */

function warmLadder(ctx: StarterContext): Ranked[] {
  const out: Ranked[] = [];
  const contact = ctx.contact;
  if (!contact) return out;

  const push = (
    rank: number,
    kind: StarterKind,
    text: string,
    basis: string
  ) => {
    out.push({ rank, starter: { text, kind, basis } });
  };

  // Their profile now says something different from what Orbit has. The single
  // highest-value thing the extension can notice about someone you know.
  const roleChange = ctx.changes.find(
    (c) => c.field === "company" || c.field === "title"
  );
  if (roleChange) {
    const company = ctx.changes.find((c) => c.field === "company")?.to;
    const title = ctx.changes.find((c) => c.field === "title")?.to;
    if (company && title) {
      push(
        100,
        "congrats",
        `Congrats on the move to ${company} — how's the ${fragment(title)} role treating you?`,
        `Their profile now says ${title} at ${company}`
      );
    } else if (company) {
      push(
        100,
        "congrats",
        `Congrats on the move to ${company} — how's it going so far?`,
        `Their profile now says ${company}, your notes say ${roleChange.from ?? "something else"}`
      );
    } else if (title) {
      push(
        99,
        "congrats",
        `Congrats on the step up to ${title} — how's the new scope?`,
        `Their profile now says ${title}`
      );
    }
  }

  // Something you said you'd do and haven't closed out.
  const openItem = ctx.recentInteractions
    .flatMap((i) => i.actionItems ?? [])
    .map(clean)
    .find(Boolean);
  if (openItem) {
    push(
      95,
      "offer",
      `${leadWith(openItem)} — still useful? Happy to make that happen.`,
      "Open item from your last conversation"
    );
  }

  const reminder = ctx.openReminders.map((r) => clean(r.title)).find(Boolean);
  if (reminder) {
    push(90, "nudge", leadWith(reminder), "You set a reminder for this");
  }

  // Long gap, but we know what you last talked about — so reconnect on that,
  // not on the gap itself.
  const gap = humanGap(daysAgo(contact.lastInteractionAt));
  const topic = ctx.recentInteractions
    .flatMap((i) => i.topics ?? [])
    .map(clean)
    .find(Boolean);
  if (gap && topic) {
    push(
      80,
      "reconnect",
      `It's been ${gap}. ${leadWith(topic)} — where did that land?`,
      `Last spoke ${gap} ago about ${topic}`
    );
  }

  const opportunity = (contact.opportunities ?? []).map(clean).find(Boolean);
  if (opportunity) {
    push(
      70,
      "question",
      `You flagged ${opportunity} — still on the table?`,
      "An opportunity you noted"
    );
  }

  const interest = (contact.sharedInterests ?? []).map(clean).find(Boolean);
  if (interest) {
    push(
      60,
      "offer",
      `${leadWith(interest)} — came across something on this recently, worth sending your way?`,
      `Shared interest: ${interest}`
    );
  }

  const fact = (contact.keyFacts ?? []).map(clean).find(Boolean);
  if (fact) {
    push(
      50,
      "question",
      `You mentioned ${fact} — how's that going?`,
      `From your notes: ${fact}`
    );
  }

  const taggedGoal = goalMatch(ctx.tags.join(" "), ctx.userGoals);
  if (taggedGoal) {
    push(
      40,
      "question",
      `${leadWith(taggedGoal)} is on my mind at the moment and you came to mind with it — open to a quick chat?`,
      `Matches your goal: ${taggedGoal}`
    );
  }

  const company = clean(contact.company);
  push(
    10,
    "reconnect",
    company
      ? `It's been a while — how are things at ${company}?`
      : `It's been a while — what are you working on these days?`,
    gap ? `Last spoke ${gap} ago` : "General reconnect"
  );

  return out;
}

function coldLadder(ctx: StarterContext): Ranked[] {
  const out: Ranked[] = [];
  const push = (
    rank: number,
    kind: StarterKind,
    text: string,
    basis: string
  ) => {
    out.push({ rank, starter: { text, kind, basis } });
  };

  const id = ctx.page.identity;
  const company = firstNonEmpty([pageValue(id.company)]);
  const title = firstNonEmpty([pageValue(id.title)]);
  const school = firstNonEmpty([pageValue(id.school)]);
  const headline = headlineClause(pageValue(id.headline));

  if (company && ctx.networkOverlap.companies.includes(company.toLowerCase())) {
    push(
      90,
      "opener",
      `I noticed you're at ${company} — I know a few people on that side. How long have you been there?`,
      `Others in your network are at ${company}`
    );
  }

  if (school && ctx.networkOverlap.schools.includes(school.toLowerCase())) {
    push(
      85,
      "opener",
      company
        ? `Fellow ${school} — what took you to ${company}?`
        : `Fellow ${school} — what are you working on these days?`,
      `Others in your network went to ${school}`
    );
  }

  const goal = goalMatch(`${title ?? ""} ${headline ?? ""}`, ctx.userGoals);
  if (goal) {
    push(
      75,
      "question",
      `${leadWith(goal)} is on my list at the moment — would you be open to comparing notes?`,
      `Matches your goal: ${goal}`
    );
  }

  if (headline && !headlineAddsNothing(headline, title, company)) {
    push(
      60,
      "question",
      `${leadWith(headline)} — what's the hardest part of that right now?`,
      "From their profile headline"
    );
  }

  if (title && company) {
    push(
      50,
      "question",
      `Curious what ${title} looks like day to day at ${company}.`,
      `They're ${title} at ${company}`
    );
  }

  push(
    10,
    "opener",
    `Would love to connect — what are you working on these days?`,
    "No strong signal on this page yet"
  );

  return out;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic, AI-free starters. Always returns at least one, so the popup
 * never renders an empty suggestions section.
 */
export function heuristicStarters(
  ctx: StarterContext,
  limit: number = DEFAULT_LIMIT
): ConversationStarter[] {
  const ladder = ctx.mode === "warm" ? warmLadder(ctx) : coldLadder(ctx);
  const ranked = dedupeByText(ladder).sort((a, b) => b.rank - a.rank);

  // The bottom rung is a true last resort: it is generic, and worse, it leans on
  // stored fields that the page may have just contradicted ("how are things at
  // Acme?" for someone who now works at Stripe). Only surface it when nothing
  // grounded fired.
  const grounded = ranked.filter((item) => item.rank > GENERIC_RANK);
  const selected = grounded.length > 0 ? grounded : ranked;

  return selected.slice(0, Math.max(1, limit)).map((item, i) => ({
    id: `h${i}-${item.rank}`,
    text: item.starter.text,
    kind: item.starter.kind,
    basis: item.starter.basis,
    source: "heuristic" as const,
  }));
}

/**
 * True when the only thing we could produce was the bottom-of-ladder generic,
 * so the UI can say "add some notes to get better starters" rather than
 * implying this is the best Orbit can do.
 */
export function startersAreLowSignal(starters: ConversationStarter[]): boolean {
  return (
    starters.length > 0 &&
    starters.every((s) => s.id.endsWith(`-${GENERIC_RANK}`))
  );
}
