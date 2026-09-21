/**
 * Whether a question gets one pass or a research loop.
 *
 * Most questions are one lookup — "who do I know at Stripe", "who's overdue" — and the
 * retrieval that already ran answers them. A research loop on those would add a model round
 * (seconds, and money on the user's own key) to find what is already in the prompt. So the
 * loop is reserved for questions whose SHAPE says one retrieval cannot answer them:
 *
 *   - what was said or discussed, and when — those live in the notes, not on a contact row;
 *   - an introduction or a path to someone — a person, then who connects to them;
 *   - a date or period — "in March", "last month" — which the passage index can scope and
 *     contact retrieval cannot;
 *   - a follow-up that refers back with a pronoun — "what did she say about it?" — where the
 *     retrieval ran against the bare follow-up and likely found the wrong people.
 *
 * Rules only, deliberately. A classifier call on every question would put a model round in
 * front of the fast path this exists to protect. If the eval shows questions the rules miss,
 * the fix is a rule, or a narrowly-scoped classifier on the residue — not a round on
 * everything.
 *
 * Pure: `scripts/smoke-chat-depth.ts` drives it directly.
 */

export type ChatDepth = "single" | "research";

export type DepthDecision = {
  depth: ChatDepth;
  /** Which rule fired, for the step label and for debugging a surprising choice. */
  reason: string;
};

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

const RULES: Array<{ reason: string; test: (q: string, ctx: DepthContext) => boolean }> = [
  {
    reason: "asks what was said",
    // Pronouns ("what did she…") AND names: "what did James say", "what did Raj ask us" are
    // the same question about a note. Only speech verbs count — "what did Ada work on before
    // Stripe" is a profile question, and retrieval already has her career line.
    test: (q) =>
      /\bwhat did (\S+ ){1,3}?(say|tell|mention|ask|promise|offer|suggest|want|think)\b/.test(q) ||
      /\b(what did (we|i|they|he|she)|discuss(ed)?|talk(ed)? (about|to|with)|(spoke|spoken) (to|with)|mention(ed)?|said about|told me|we spoke|conversation with|my notes?|i wrote|i noted)\b/.test(
        q
      ),
  },
  {
    reason: "asks for a path to someone",
    test: (q) =>
      /\b(intro(duce|duction)?s?|warm (path|intro)|connect me|get (me )?(in|to) (touch|front)|who (could|can|might) (help|connect|introduce))\b/.test(
        q
      ),
  },
  {
    // The PAST only. "This week" looks forward — "who should I reconnect with this week?" is
    // one of Orbit's own suggested questions, the attention brief answers it, and routing it
    // here would put a research round on the product's most-clicked prompt.
    reason: "asks about a time",
    test: (q) =>
      new RegExp(
        `\\b(in|during|since|before|after|last|this|early|late) (${MONTHS})\\b|\\b(last|past) (week|month|quarter|year)\\b|\\b(when did|how long ago|last time)\\b`
      ).test(q),
  },
  {
    reason: "follows up on the last answer",
    test: (q, ctx) =>
      ctx.hasPriorTurns &&
      /\b(she|he|they|her|him|them|their|that person|those people|the first one|the second one)\b/.test(q),
  },
];

export type DepthContext = {
  hasPriorTurns: boolean;
};

export function chooseDepth(question: string, ctx: DepthContext): DepthDecision {
  const q = question.toLowerCase().replace(/\s+/g, " ").trim();
  // A bare name or a two-word query is a lookup, whatever words it happens to contain.
  if (q.split(" ").filter(Boolean).length <= 2) return { depth: "single", reason: "short lookup" };
  for (const rule of RULES) {
    if (rule.test(q, ctx)) return { depth: "research", reason: rule.reason };
  }
  return { depth: "single", reason: "one retrieval answers it" };
}
