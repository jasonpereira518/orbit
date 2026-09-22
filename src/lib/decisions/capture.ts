import {
  MENTION_TUNING,
  MERGE_TARGET_TUNING,
  mergeTargetQuestion,
  whichContactQuestion,
} from "@/lib/decisions/catalog";
import { canAct, decide, type Engines } from "@/lib/decisions/engine";
import { mapPool } from "@/lib/decisions/jev";
import type { DuplicateSubject } from "@/lib/duplicates";
import type { ResolvedMention, UnresolvedMention } from "@/lib/mention-resolution";

/**
 * Who a note is about, decided with more than the name.
 *
 *  - MENTIONS. The rules link a one-word mention to the only contact with that first name,
 *    blind — "Sam from the gym" lands on your one Sam, the investor. And a name several
 *    contacts share is left unlinked. With engines, the sentence the name sits in is read:
 *    a guess the sentence contradicts is un-linked (Jev, or the person's own model — a veto
 *    is not an action), and an ambiguous name is linked only by a Jev answer above an `act`
 *    threshold that ships disabled.
 *  - MERGE TARGET. A card's default save target. Today any name match, even a bare 0.6 one,
 *    defaults to "update existing"; with Jev the default follows its pick, including "a new
 *    person". The person still confirms every card, so this sets a default and nothing more.
 */

function normalize(s: string | null | undefined) {
  return (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The sentence of the note that names the mention — the note's words, not a paraphrase. */
export function sentenceFor(corpus: string, name: string, fallback: string | null): string {
  const target = normalize(name);
  if (target) {
    for (const sentence of corpus.split(/(?<=[.!?\n])\s+/)) {
      if (normalize(sentence).includes(target)) return sentence.trim().slice(0, MENTION_TUNING.sentenceChars);
    }
  }
  return (fallback ?? name).slice(0, MENTION_TUNING.sentenceChars);
}

/** A candidate as the question describes it. Missing fields may be null or absent. */
export type CandidateCard = { fullName: string; title?: string | null; company?: string | null };

function describe(c: CandidateCard): string {
  const role = [c.title, c.company].filter(Boolean).join(" at ");
  return role ? `${c.fullName} — ${role}` : c.fullName;
}

/** Contacts a name could mean: the same full name, or — for one word — the same first name. */
function candidatesFor(subjects: readonly DuplicateSubject[], name: string): DuplicateSubject[] {
  const norm = normalize(name);
  if (!norm) return [];
  const oneWord = !norm.includes(" ");
  return subjects
    .filter((s) => {
      const full = normalize(s.fullName);
      return full === norm || (oneWord && full.split(" ")[0] === norm);
    })
    .slice(0, MENTION_TUNING.maxCandidates);
}

/** One engine's answer to "which of these contacts does this name mean?". */
export type WhichContact = {
  engine: "jev" | "llm";
  /** The candidate index, or "none". */
  choice: number | "none";
  /** P of the choice. */
  p: number;
  /** P of candidate i (0 when the engine gave no distribution for it). */
  pOf: (i: number) => number;
};

export async function whichContact(
  engines: Engines,
  mention: { text: string; context: string | null; nearPerson: string | null },
  candidates: readonly CandidateCard[],
  corpus: string,
): Promise<WhichContact | null> {
  const keys = candidates.map((_, i) => `c${String(i + 1).padStart(2, "0")}`);
  const decided = await decide(
    engines,
    { engines: ["jev", "llm"], budgetMs: MENTION_TUNING.budgetMs, jevMs: MENTION_TUNING.jevMs },
    {
      operation: "mentions.resolve",
      state: {
        mention: mention.text,
        sentence: sentenceFor(corpus, mention.text, mention.context),
        ...(mention.nearPerson ? { beside_participant: mention.nearPerson } : {}),
      },
      questions: {
        who: whichContactQuestion(Object.fromEntries(candidates.map((c, i) => [keys[i], describe(c)]))),
      },
    },
  );
  if (decided.engine === "rules") return null;
  const { choice, probabilities } = decided.answers.who;
  const index = keys.indexOf(choice);
  // An engine that returns only a pick (the person's own model) gives its pick all the weight.
  const pOf = (i: number) => probabilities[keys[i]] ?? (index === i ? 1 : 0);
  return {
    engine: decided.engine,
    choice: index >= 0 ? index : "none",
    p: probabilities[choice] ?? 1,
    pOf,
  };
}

export async function decideMentions(
  engines: Engines,
  input: {
    resolved: ResolvedMention[];
    unresolved: UnresolvedMention[];
    subjects: readonly DuplicateSubject[];
    corpus: string;
  },
): Promise<{ resolved: ResolvedMention[]; unresolved: UnresolvedMention[] }> {
  if (!engines.jev && !engines.llm) return { resolved: input.resolved, unresolved: input.unresolved };
  const byId = new Map(input.subjects.map((s) => [s.id, s]));

  // The rules' blind guesses (a unique first name) and the names they could not settle.
  const guesses = input.resolved.filter((m) => m.matchedBy === "first_name_unique");
  const ambiguous = input.unresolved
    .map((m) => ({ m, candidates: candidatesFor(input.subjects, m.text) }))
    .filter((x) => x.candidates.length > 0);
  if (guesses.length === 0 && ambiguous.length === 0) return { resolved: input.resolved, unresolved: input.unresolved };

  const [guessAnswers, ambiguousAnswers] = await Promise.all([
    mapPool(guesses, 3, (m) => {
      const contact = byId.get(m.contactId);
      return contact ? whichContact(engines, m, [contact], input.corpus) : Promise.resolve(null);
    }),
    mapPool(ambiguous, 3, ({ m, candidates }) => whichContact(engines, m, candidates, input.corpus)),
  ]);

  // A guess the sentence contradicts is un-linked. Vetoing is not acting: either engine may.
  const unlinked = new Set<ResolvedMention>();
  guesses.forEach((m, i) => {
    const r = guessAnswers[i];
    if (r && r.pOf(0) < MENTION_TUNING.vetoBelow) unlinked.add(m);
  });

  // An unsettled name is linked only by a calibrated Jev answer above `act` (off by default).
  const linked: ResolvedMention[] = [];
  const nowLinked = new Set<UnresolvedMention>();
  ambiguous.forEach(({ m, candidates }, i) => {
    const r = ambiguousAnswers[i];
    if (!r || r.choice === "none" || !canAct(r.engine, r.p, MENTION_TUNING.act)) return;
    linked.push({ ...m, contactId: candidates[r.choice].id, confidence: r.p, matchedBy: "decision" });
    nowLinked.add(m);
  });

  return {
    resolved: [...input.resolved.filter((m) => !unlinked.has(m)), ...linked],
    unresolved: [
      ...input.unresolved.filter((m) => !nowLinked.has(m)),
      ...[...unlinked].map((m) => ({ text: m.text, context: m.context, nearPerson: m.nearPerson })),
    ],
  };
}

export type MergeTargetInput = {
  person: { name: string | null; company: string | null; role: string | null; excerpt: string };
  duplicates: ReadonlyArray<{ id: string; fullName: string; company: string | null; title: string | null; confidence: number }>;
};

/**
 * The review card's default, per person: an existing contact's id, "new", or null (keep
 * today's default). Only asked where the rules have no confident answer (below 0.85) and
 * there is something to choose between. Jev only: this runs inside the parse the person is
 * waiting on, and a default is not worth a chat-model round.
 */
export async function decideMergeTargets(
  engines: Engines,
  people: readonly MergeTargetInput[],
): Promise<Array<string | "new" | null>> {
  if (!engines.jev) return people.map(() => null);
  return mapPool(people, 4, async ({ person, duplicates }) => {
    if (duplicates.length === 0 || duplicates[0].confidence >= 0.85) return null;
    const keys = duplicates.map((_, i) => `c${String(i + 1).padStart(2, "0")}`);
    const decided = await decide(
      { jev: engines.jev, llm: null },
      { engines: ["jev"], budgetMs: MERGE_TARGET_TUNING.budgetMs },
      {
        operation: "capture.merge_target",
        state: {
          person: {
            name: person.name,
            company: person.company,
            role: person.role,
            what_the_note_says: person.excerpt.slice(0, 600),
          },
        },
        questions: {
          which: mergeTargetQuestion(Object.fromEntries(duplicates.map((d, i) => [keys[i], describe(d)]))),
        },
      },
    );
    if (decided.engine !== "jev") return null;
    const { choice, probabilities } = decided.answers.which;
    if ((probabilities[choice] ?? 0) < MERGE_TARGET_TUNING.pickAbove) return null;
    if (choice === "new") return "new";
    const index = keys.indexOf(choice);
    return index >= 0 ? duplicates[index].id : null;
  });
}
