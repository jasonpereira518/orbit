/**
 * Did a chat answer actually answer?
 *
 * Every stored assistant turn is labelled `answered`, `partial` or `abstained`, so the share
 * of "I don't know" answers is a number the admin product page can show rather than an
 * impression. Nothing else in the product measured it: thumbs are rare, and the admin
 * feedback view deliberately never reads answer text.
 *
 * Rule-based on purpose. The label is computed on every answer, in the request, after the
 * stream has ended — a model call here would add latency and cost to every turn to produce a
 * metric. The phrase list is the whole classifier; `scripts/smoke-chat-abstention.ts` pins it,
 * and a phrase that mislabels real answers is fixed there, not tuned away in the report.
 *
 * Pure.
 */
import { splitDirectives } from "@/lib/chat-directives";

export type AnswerOutcome = "answered" | "partial" | "abstained";

/**
 * Phrases that say the records did not have it. Lower-case, straight apostrophes; answers are
 * normalised to match. Deliberately absent: "no one", "nobody", "none" — "nobody is overdue"
 * is a real answer from a complete section, not an abstention.
 */
export const ABSTAIN_PHRASES: readonly string[] = [
  "i don't know",
  "i do not know",
  "i don't have",
  "i do not have",
  "i couldn't find",
  "i could not find",
  "i can't find",
  "i can't tell",
  "i cannot tell",
  "i'm not sure",
  "no record of",
  "not in your records",
  "nothing in your",
  "doesn't say",
  "don't say",
  "don't see",
  "do not see",
  "isn't recorded",
  "wasn't recorded",
  "not recorded",
  "you haven't logged",
  "you haven't recorded",
  "no information",
  "no details",
];

function normalise(text: string): string {
  return text.toLowerCase().replace(/[‘’ʼ]/g, "'");
}

/** The prose with citation markers and block directives taken out, as sentences. */
function sentencesOf(prose: string): string[] {
  return prose
    .replace(/\[e\d+\]/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function hasAbstainPhrase(text: string): boolean {
  const t = normalise(text);
  return ABSTAIN_PHRASES.some((p) => t.includes(p));
}

/**
 * Label one answer.
 *
 * - No abstain phrase anywhere → `answered`.
 * - An abstain phrase, but the answer also cites a record or shows people or a list →
 *   `partial`: it answered some of it from the records and said what was missing.
 * - An abstain phrase in the first two sentences of an ungrounded answer → `abstained`.
 * - An abstain phrase later in an ungrounded answer → `partial`: it gave something first.
 */
export function labelAnswer(answer: string, meta: { citedCount: number }): AnswerOutcome {
  const segments = splitDirectives(answer);
  let blocks = 0;
  const prose: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") prose.push(segment.text);
    else blocks++;
  }
  const sentences = sentencesOf(prose.join("\n"));
  if (!sentences.some(hasAbstainPhrase)) return "answered";
  if (meta.citedCount > 0 || blocks > 0) return "partial";
  return sentences.slice(0, 2).some(hasAbstainPhrase) ? "abstained" : "partial";
}
