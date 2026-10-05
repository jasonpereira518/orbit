import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { DUPLICATE_TUNING, samePersonQuestion } from "@/lib/decisions/catalog";
import { decideEach, type DecidedItem, type Engines } from "@/lib/decisions/engine";
import type { NoulQuestion } from "@/lib/decisions/jev";

/**
 * "Same person?" — the one decision behind every name-evidence merge in Orbit.
 *
 * The matcher (`duplicates.ts`) scores by tier: a shared identifier is a fact, but a shared
 * name plus company (0.90) or title (0.85), or a fuzzy name, is evidence — and it merged two
 * different "Michael Chen, Software Engineer"s at different firms without asking. This asks
 * the decision model to look at both cards before any automatic merge or fold on NAME
 * evidence, and lets it:
 *
 *  - VETO (Jev only, probability ≤ `rejectAtOrBelow`): keep both, queue the pair for review;
 *  - RANK the review queue (Jev, or the person's own model — a hint, never a merge);
 *  - ACT on a bare shared-name pair (Jev only, above an `act` threshold that ships disabled).
 *
 * Without a TypeSafe key the write paths behave exactly as before.
 */

/** The facts two cards are compared on. An email's DOMAIN only — never the address. */
export type PersonCard = {
  name: string;
  title?: string | null;
  company?: string | null;
  school?: string | null;
  location?: string | null;
  email_domain?: string | null;
  summary?: string | null;
};

export function personCard(c: {
  fullName?: string | null;
  title?: string | null;
  company?: string | null;
  school?: string | null;
  location?: string | null;
  email?: string | null;
  aiSummary?: string | null;
}): PersonCard {
  const domain = c.email?.split("@")[1]?.trim().toLowerCase() || null;
  const card: PersonCard = { name: (c.fullName ?? "").trim() };
  if (c.title?.trim()) card.title = c.title.trim();
  if (c.company?.trim()) card.company = c.company.trim();
  if (c.school?.trim()) card.school = c.school.trim();
  if (c.location?.trim()) card.location = c.location.trim();
  if (domain) card.email_domain = domain;
  const summary = c.aiSummary?.replace(/\s+/g, " ").trim().slice(0, 160);
  if (summary) card.summary = summary;
  return card;
}

export type SamePersonAnswer = DecidedItem<NoulQuestion>;

/** P(same person) for each pair, in order, on whatever engines the policy allows. */
export function samePersonProbabilities(
  engines: Engines,
  pairs: ReadonlyArray<readonly [PersonCard, PersonCard]>,
  opts: { engines: ReadonlyArray<"jev" | "llm">; budgetMs: number },
): Promise<SamePersonAnswer[]> {
  if (pairs.length === 0) return Promise.resolve([]);
  return decideEach(
    engines,
    { engines: opts.engines, budgetMs: opts.budgetMs, cacheDays: DUPLICATE_TUNING.cacheDays },
    {
      operation: "duplicates.same_person",
      items: pairs,
      chunkSize: DUPLICATE_TUNING.chunkSize,
      concurrency: DUPLICATE_TUNING.concurrency,
      state: (chunk) => ({ pairs: Object.fromEntries(chunk.map(({ key, item: [a, b] }) => [key, { a, b }])) }),
      question: samePersonQuestion,
    },
  );
}

/** Whether a name-evidence merge must NOT happen automatically. Only Jev can veto. */
export function vetoesMerge(answer: SamePersonAnswer | undefined): boolean {
  return answer?.engine === "jev" && answer.answer.probability <= DUPLICATE_TUNING.jev.rejectAtOrBelow;
}

/**
 * Vetoes for a batch of pending name-evidence merges, Jev only, one deadline. The write
 * paths call this before their loop: `true` at index i means "do not merge pair i".
 */
export async function nameMergeVetoes(
  engines: Engines,
  pairs: ReadonlyArray<readonly [PersonCard, PersonCard]>,
  budgetMs: number,
): Promise<boolean[]> {
  if (!engines.jev || pairs.length === 0) return pairs.map(() => false);
  const answers = await samePersonProbabilities(engines, pairs, { engines: ["jev"], budgetMs });
  return answers.map(vetoesMerge);
}

/** Cards for a set of the account's contacts, in one read. Missing ids are simply absent. */
export async function loadPersonCards(userId: string, ids: readonly string[]): Promise<Map<string, PersonCard>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const db = await getDb();
  const rows = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      title: contacts.title,
      company: contacts.company,
      school: contacts.school,
      location: contacts.location,
      email: contacts.email,
      aiSummary: contacts.aiSummary,
    })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, unique)));
  return new Map(rows.map((r) => [r.id, personCard(r)]));
}

/**
 * The review queue's hint: P(same person) per pair, Jev or the person's own model, cached per
 * pair so a revisit costs nothing. Only ever a hint and an order — a merge from this list is
 * still the person's click.
 */
export async function rankDuplicatePairs(
  userId: string,
  engines: Engines,
  pairs: ReadonlyArray<{ a: string; b: string }>,
): Promise<Array<{ engine: "jev" | "llm"; sameProbability: number } | null>> {
  if (!engines.jev && !engines.llm) return pairs.map(() => null);
  const cards = await loadPersonCards(userId, pairs.flatMap((p) => [p.a, p.b]));
  const asked = pairs
    .map((p, i) => ({ i, a: cards.get(p.a), b: cards.get(p.b) }))
    .filter((x): x is { i: number; a: PersonCard; b: PersonCard } => Boolean(x.a && x.b))
    .slice(0, DUPLICATE_TUNING.reviewMaxPairs);
  const answers = await samePersonProbabilities(engines, asked.map((x) => [x.a, x.b] as const), {
    engines: ["jev", "llm"],
    budgetMs: DUPLICATE_TUNING.reviewBudgetMs,
  });
  const out: Array<{ engine: "jev" | "llm"; sameProbability: number } | null> = pairs.map(() => null);
  asked.forEach((x, j) => {
    const a = answers[j];
    if (a && a.engine !== "rules") out[x.i] = { engine: a.engine, sameProbability: a.answer.probability };
  });
  return out;
}

