import { triageName } from "@/lib/imports/drive-triage";

/**
 * Does a doc look like notes from a meeting or event, or a chat? Rules on the name and the
 * first lines — free and instant, so a scan never spends AI on a doc the rules can call.
 * `maybe` is what the rules cannot call; the scan asks the decision engine about those.
 */

export type NoteVerdict = {
  verdict: "yes" | "no" | "maybe";
  reason: string;
  /** For a maybe: what to do when no engine can answer. Named like notes = offer it; a date alone = don't. */
  offerWithoutEngine?: boolean;
};

/** How much of the doc the rules (and the decision engine) read. */
export const HEAD_CHARS = 1_500;

const STRONG: [RegExp, string][] = [
  [/\bnotes by gemini\b|\bmeeting notes\b|\bmeeting summary\b|\bmeeting recap\b/i, "Reads like meeting notes"],
  [/^\s*(transcript|meeting transcript|call transcript)\b/im, "Reads like a call transcript"],
  [/^\s*(attendees|participants|present|invitees|people)\s*:/im, "Lists who was there"],
  [/^\s*(agenda|action items?|next steps|follow[- ]?ups?|takeaways|key points|decisions)\b\s*:?\s*$/im, "Has an agenda or action items"],
  [/^\s*(agenda|action items?|next steps)\s*:/im, "Has an agenda or action items"],
];

/** `Name: words`, optionally after a timestamp — a chat export or a transcript. */
const SPEAKER_LINE = /^\s*(\[?\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\]?\s*[-–]?\s*)?[A-Z][\w.'’-]+( [A-Z][\w.'’-]+){0,2}\s*:\s+\S/;
const TIMESTAMP_LINE = /^\s*\[?\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\]?\s+[A-Z]/i;

const DATE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b(,?\s+\d{4})?|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i;

/** `Name <> Name` or `Name / Name` at the top of the doc. */
const PAIR = /^\s*\S[^\n]{0,40}\s(<>|\/|x)\s\S[^\n]{0,40}$/m;

export function classifyNoteDoc(input: { name: string; head: string }): NoteVerdict {
  const name = triageName(input.name);
  if (name.verdict === "no" && name.why !== "The name gives nothing to go on") return { verdict: "no", reason: name.why };

  const head = input.head.slice(0, HEAD_CHARS);
  const lines = head.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { verdict: "no", reason: "The doc is empty" };

  for (const [re, reason] of STRONG) if (re.test(head)) return { verdict: "yes", reason };
  const speakerLines = lines.filter((l) => SPEAKER_LINE.test(l) || TIMESTAMP_LINE.test(l)).length;
  if (speakerLines >= 3) return { verdict: "yes", reason: "Reads like a chat or transcript" };

  const topLines = lines.slice(0, 5).join("\n");
  const datedTop = DATE.test(topLines);
  const pairTop = PAIR.test(topLines);
  if (name.verdict === "yes" && (datedTop || pairTop)) return { verdict: "yes", reason: name.why };
  if (pairTop && datedTop) return { verdict: "yes", reason: "Named after two people, with a date" };
  if (name.verdict === "yes") return { verdict: "maybe", reason: name.why, offerWithoutEngine: true };
  if (datedTop || pairTop) {
    return { verdict: "maybe", reason: datedTop ? "Starts with a date" : "Named after two people", offerWithoutEngine: false };
  }
  return { verdict: "no", reason: "Nothing says meeting notes" };
}
