/**
 * The prompt behind Radar's optional one-line "why", built as a pure function so its bytes
 * can be pinned by `scripts/smoke-radar-score.ts` without a model or a database.
 *
 * What the model sees, and nothing more: the person's cleaned name, title and company, the
 * kind of recommendation, and the scorer's own reason and evidence lines — the facts that
 * already chose this row. Those lines can quote the user's notes (an open action item's
 * text), so they go inside a fence. No notes and no message bodies. A card built from the
 * user's email carries one model-written sentence about it inside the fence, and nothing
 * else from the mail: never a quote, an address or a message.
 */
import { createHash } from "node:crypto";
import { cleanSingleLine, fenceUntrusted } from "@/lib/ai-security";
import { KIND_LABELS, type RadarEvidence, type RadarReason, type RecommendationKind } from "@/lib/radar/types";

export const RADAR_WHY_SYSTEM = [
  "You help someone decide who in their professional network to contact this week.",
  "You are given one person and the factual reasons they were chosen.",
  "Write from those reasons only. Never invent a shared interest, a mutual contact,",
  "a job history, a date, or anything else you were not given.",
  'Reply as {"why": string, "opener": string}.',
  '"why" is one sentence, under 20 words, plain and specific.',
  '"opener" is one sentence the user could send as the first line of a message:',
  "warm, no flattery, no exclamation marks, no links, and never a question about something",
  "you were not told.",
  "Never state a number of days or weeks: the note is reused for days, so say recently,",
  "a while, or soon instead.",
].join(" ");

/** Reasons that argue against the recommendation; the "why" never repeats them. */
const PENALTY_CODES: ReadonlySet<string> = new Set(["touched_recently", "dismissed_recently", "already_scheduled"]);

export type RadarWhyInputs = {
  name: string;
  title: string | null;
  company: string | null;
  recommendation: string;
  facts: string[];
};

export function radarWhyInputs(rec: {
  contactName: string;
  title: string | null;
  company: string | null;
  kind: RecommendationKind;
  reasons: readonly RadarReason[];
  evidence: readonly RadarEvidence[];
}): RadarWhyInputs {
  const facts = [
    ...rec.reasons
      .filter((r) => r.points > 0 || r.code.startsWith("also:"))
      .filter((r) => !PENALTY_CODES.has(r.code))
      .map((r) => r.label),
    ...rec.evidence.map((e) => e.label),
  ]
    .map((line) => cleanSingleLine(line, 200))
    .filter((line): line is string => Boolean(line));
  return {
    name: cleanSingleLine(rec.contactName, 80) ?? "this person",
    title: cleanSingleLine(rec.title, 120),
    company: cleanSingleLine(rec.company, 120),
    recommendation: KIND_LABELS[rec.kind],
    facts,
  };
}

export function buildRadarWhyPrompt(inputs: RadarWhyInputs): { system: string; user: string } {
  const person = JSON.stringify({
    person: { name: inputs.name, title: inputs.title, company: inputs.company },
    recommendation: inputs.recommendation,
  });
  return {
    system: RADAR_WHY_SYSTEM,
    user: `${person}\n\nWhy they were chosen:\n${fenceUntrusted("FACTS", inputs.facts.join("\n"))}`,
  };
}

/**
 * The key an AI note is cached under. Built from the FACTS, not the wording: reason labels
 * say "9 days ago" and change every day, so hashing them would re-spend a model call on
 * every card every night. The codes, the dates the evidence is about, and who the person is
 * change only when something real changes. The prompt tells the model not to state day
 * counts, so a note written three days ago is still true.
 */
export function radarNoteKey(rec: {
  contactName: string;
  title: string | null;
  company: string | null;
  kind: RecommendationKind;
  reasons: readonly RadarReason[];
  evidence: readonly RadarEvidence[];
}): string {
  const key = {
    name: cleanSingleLine(rec.contactName, 80),
    title: cleanSingleLine(rec.title, 120),
    company: cleanSingleLine(rec.company, 120),
    kind: rec.kind,
    codes: rec.reasons
      .filter((r) => (r.points > 0 || r.code.startsWith("also:")) && !PENALTY_CODES.has(r.code))
      .map((r) => r.code)
      .sort(),
    evidence: rec.evidence.map((e) => e.at),
  };
  return createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 16);
}
