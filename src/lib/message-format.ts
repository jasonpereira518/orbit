/**
 * The house format for every message Orbit drafts for someone to send: one strict shape per
 * channel, one voice, one list of habits that are never allowed through.
 *
 * Every draft generator (outreach, follow-ups, recruiter emails, chat drafts) takes its
 * channel, length and sign-off rules from `formatRules` and runs its output through
 * `scrubDraft`, so they cannot drift apart again. They had: three LinkedIn limits, follow-up
 * emails with no subject, three different sign-off rules, five wordings of "no slop".
 *
 * Hard bans are enforced here in code, not only asked for in a prompt: em and en dashes and
 * exclamation marks are rewritten (`scrubPunctuation`); flattery/hype words are flagged so the
 * generator retries once (`draftWithFormat`). Stock openers and filler asks are only
 * discouraged (`SOFT_RULES`): the user's own voice may use them.
 *
 * Pure, no DB, no React: the chat editor imports `LINKEDIN_NOTE_MAX` from here.
 */

export type MessageKind =
  | "email_cold"
  | "email_warm"
  | "email_followup"
  | "linkedin_note"
  | "linkedin_dm"
  | "sms";

/**
 * LinkedIn's connection-note limit for a FREE account (Premium gets 300). One limit for
 * everyone, so a note never gets cut off for the people who have the smaller one.
 */
export const LINKEDIN_NOTE_MAX = 200;
export const LINKEDIN_DM_MAX = 600;
export const SMS_MAX = 160;

/** The most a draft of each kind may be, in code points; email has no hard cap. */
export const HARD_LIMIT: Record<MessageKind, number | null> = {
  email_cold: null,
  email_warm: null,
  email_followup: null,
  linkedin_note: LINKEDIN_NOTE_MAX,
  linkedin_dm: LINKEDIN_DM_MAX,
  sms: SMS_MAX,
};

/** The voice used until Orbit knows how the user writes. */
export const FALLBACK_VOICE =
  "Default voice, when the sender's writing preferences say nothing else: warm and professional. Friendly and polite, a little context, plain words, contractions are fine, no fluff. It should read like a thoughtful person wrote it, not a template.";

/** Prompt-only: discouraged, never stripped. */
export const SOFT_RULES =
  'Avoid stock openers ("I hope this finds you well", "I wanted to reach out", "I came across your profile") and filler asks ("just checking in", "circling back", "pick your brain", "hop on a quick call").';

/** The hard bans as the model is told them; the code enforces them either way. */
export const HARD_BANS =
  'Never use em dashes or en dashes (use a comma, a period or parentheses). No exclamation marks. No flattery or hype ("amazing", "incredible", "thrilled", "really impressed", "huge fan", "passionate").';

/**
 * Phrases that read as flattery or hype. A hit means one regeneration with a note naming it,
 * never a silent edit: deleting a word mid-sentence breaks the sentence.
 */
export const HYPE_WORDS = [
  "amazing",
  "incredible",
  "incredibly",
  "awesome",
  "thrilled",
  "super excited",
  "so excited",
  "really excited",
  "passionate",
  "game-changer",
  "game changer",
  "groundbreaking",
  "revolutionary",
  "world-class",
  "really impressed",
  "so impressed",
  "deeply impressed",
  "huge fan",
  "big fan",
  "truly inspiring",
  "blown away",
  "rockstar",
  "visionary",
];

const HYPE_RE = new RegExp(`\\b(${HYPE_WORDS.join("|")})\\b`, "gi");

/** A tone picked for one campaign: a nudge on the user's voice, not a costume. */
export function toneNudge(tone: string | null | undefined): string | null {
  const t = tone?.trim().toLowerCase();
  return t ? `Tone: shift the voice slightly toward ${t} for this message; the format does not change.` : null;
}

export type FormatOptions = {
  /** The sender's full name for an email sign-off; without it there is no sign-off at all. */
  senderFullName?: string | null;
  /** Last step of a sequence: offer an easy out. */
  lastStep?: boolean;
};

function signOff(name: string | null | undefined): string {
  const n = name?.trim();
  return n
    ? `Sign off with "Best," or "Thanks," ("Thanks," when the email asks for something) on its own line, then "${n}" on the next line.`
    : "End on the final sentence: no sign-off, no signature, no placeholder name.";
}

/**
 * Described, not quoted: with an example sentence in the prompt, every email in the eval
 * ended on that exact sentence, which reads as a template and, across a campaign, is the
 * same line to everyone.
 */
const MEETING_ASK =
  "When the ask is a meeting or call, offer two time windows (two weekdays and a part of the day, how long it takes) in your own words. Never invent a specific date.";

const SUBJECT_BANNED = 'Never "Following up", "Quick question", "Hello", "Introduction" or "Checking in".';

const NO_ATTACHMENTS = "Never say something is attached, enclosed or linked unless the context says the user added it.";

/**
 * The format lines for one kind of message, as prompt bullets. Each generator keeps its own
 * job context (who, why, history) and takes these instead of its own channel, length and
 * sign-off rules.
 */
export function formatRules(kind: MessageKind, opts: FormatOptions = {}): string {
  const lines: string[] = [];
  switch (kind) {
    case "email_cold":
      lines.push(
        "Format: an email with a subject line.",
        `Subject: 3 to 7 words, specific to this person, sentence case. ${SUBJECT_BANNED}`,
        'Greeting: "Hi <their first name>," on its own line.',
        "First sentence: who the sender is, in one line, tied to why it matters to the reader.",
        "Then one short paragraph: why this person (one concrete detail from the context) and what the sender wants.",
        `End with one easy ask. ${MEETING_ASK}`,
        signOff(opts.senderFullName),
        "60 to 120 words in the body, at most three short paragraphs. No links unless the context gives one.",
        NO_ATTACHMENTS
      );
      break;
    case "email_warm":
      lines.push(
        "Format: an email with a subject line.",
        `Subject: 3 to 7 words, specific to what you share, sentence case. ${SUBJECT_BANNED}`,
        'Greeting: "Hi <their first name>," on its own line.',
        "They already know the sender, so no self-introduction: open with the shared context (where you last talked, what they said or did).",
        `One purpose, one ask. ${MEETING_ASK}`,
        signOff(opts.senderFullName),
        "40 to 90 words in the body. No links unless the context gives one.",
        NO_ATTACHMENTS
      );
      break;
    case "email_followup":
      lines.push(
        "Format: a reply in the same email thread as the earlier message; the subject stays the earlier one.",
        'Greeting: "Hi <their first name>," on its own line.',
        "2 to 4 sentences. Add one new reason or detail; do not recap the earlier email.",
        opts.lastStep
          ? "This is the last message: close with an easy out (\"If now isn't the right time, no worries\")."
          : "End with the same ask, lighter.",
        signOff(opts.senderFullName)
      );
      break;
    case "linkedin_note":
      lines.push(
        `Format: a LinkedIn connection note, at most ${LINKEDIN_NOTE_MAX} characters including spaces. Count them.`,
        "No subject line, no sign-off, no signature.",
        'Start with "Hi <their first name>,", then who the sender is in a few words, then why connecting (one concrete detail), then a light question.',
        `Drop the greeting only if the note would not fit in ${LINKEDIN_NOTE_MAX} characters with it.`
      );
      break;
    case "linkedin_dm":
      lines.push(
        `Format: a direct message (LinkedIn DM or text) to someone already connected: 2 to 4 short lines, at most ${LINKEDIN_DM_MAX} characters.`,
        "No subject line, no sign-off, no signature.",
        "If there is shared history, open with it instead of introducing the sender.",
        "End with one question."
      );
      break;
    case "sms":
      lines.push(`Format: a text message under ${SMS_MAX} characters.`, "No subject line, no sign-off. One clear ask.");
      break;
  }
  lines.push(HARD_BANS, SOFT_RULES);
  return lines.map((l) => `- ${l}`).join("\n");
}

/* ------------------------------------------------------------------- the scrub ---- */

/**
 * Dashes and exclamation marks out, deterministically.
 *
 * - A dash between digits is a range: "9–5" becomes "9-5".
 * - A dash that starts a line is dropped ("— Jason" becomes "Jason").
 * - A dash that ends a line becomes a period.
 * - Any other em or en dash becomes ", " (an aside, the commonest model use).
 * - "!" becomes "." and "?!" becomes "?".
 *
 * ponytail: a comma is the safe replacement, not always the best one. If the format eval
 * shows it reading badly, retry with a note instead of rewriting.
 */
export function scrubPunctuation(text: string): string {
  return text
    .replace(/(\d)[ \t]*[–—][ \t]*(\d)/g, "$1-$2")
    .replace(/^([ \t]*)[–—]+[ \t]*/gm, "$1")
    .replace(/[ \t]*[–—]+[ \t]*(?=\n|$)/g, ".")
    .replace(/[ \t]*[–—]+[ \t]*/g, ", ")
    .replace(/,[ \t]*([,.;:?])/g, "$1")
    .replace(/\?!+/g, "?")
    .replace(/!+\?/g, "?")
    .replace(/!+/g, ".")
    .replace(/(?<!\.)\.\.(?!\.)/g, ".");
}

/** Every flattery/hype phrase in the text, lowercased, once each. */
export function hypeHits(text: string): string[] {
  return [...new Set((text.match(HYPE_RE) ?? []).map((h) => h.toLowerCase()))];
}

/** Code points, as LinkedIn and SMS count them. */
export function charLength(text: string): number {
  return Array.from(text.trim()).length;
}

/**
 * "I've attached my resume" when nothing is: a draft is text, the person adds files in the
 * send dialog. The model invents it when the history mentions sending something (about 1 in 3
 * drafts in the eval), and a prompt rule alone did not stop it.
 */
const ATTACHMENT_CLAIM = /\b(attached|enclosed|attaching)\b/i;

export function claimsAttachment(text: string): boolean {
  return ATTACHMENT_CLAIM.test(text);
}

export type ScrubResult = {
  text: string;
  /** Hype phrases still in the text: worth one regeneration. */
  hype: string[];
  /** An email that says something is attached: worth one regeneration. */
  attachment: boolean;
  /** Characters past the kind's hard limit, 0 when within it. */
  over: number;
};

/** The hard bans applied, and what is left that only the model can fix. */
export function scrubDraft(text: string, kind: MessageKind): ScrubResult {
  const clean = scrubPunctuation(text).trim();
  const limit = HARD_LIMIT[kind];
  return {
    text: clean,
    hype: hypeHits(clean),
    attachment: kind.startsWith("email") && claimsAttachment(clean),
    over: limit === null ? 0 : Math.max(0, charLength(clean) - limit),
  };
}

/** What to tell the model on its one retry, or null when the draft passes. */
export function retryNote(result: ScrubResult, kind: MessageKind): string | null {
  const notes: string[] = [];
  if (result.hype.length) notes.push(`remove these flattery/hype words: ${result.hype.join(", ")}`);
  if (result.attachment) notes.push("it says something is attached, but nothing is; drop that and offer to send it instead");
  if (result.over > 0) notes.push(`it is ${result.over} characters over the ${HARD_LIMIT[kind]}-character limit, so cut it`);
  return notes.length
    ? `Your previous draft broke the format: ${notes.join("; ")}. Write it again, and reply in exactly the same JSON shape as before.`
    : null;
}

/**
 * Draft, scrub, and when the draft still breaks a rule only the model can fix, draft ONCE
 * more with a note saying which. The second draft is kept whatever it holds (the quality
 * check flags what is left): a third call costs more than a stray hype word does.
 */
export async function draftWithFormat<T extends { body: string; subject?: string | null }>(
  kind: MessageKind,
  run: (retry: string | null) => Promise<T>
): Promise<T> {
  const first = await run(null);
  const scrubbed = scrubDraft(first.body, kind);
  const note = retryNote(scrubbed, kind);
  if (!note) return cleaned(first, scrubbed.text);
  try {
    const second = await run(note);
    return cleaned(second, scrubDraft(second.body, kind).text);
  } catch {
    // The retry is an improvement, never a requirement: a failed one keeps the first draft.
    return cleaned(first, scrubbed.text);
  }
}

function cleaned<T extends { body: string; subject?: string | null }>(draft: T, body: string): T {
  return typeof draft.subject === "string"
    ? { ...draft, body, subject: scrubPunctuation(draft.subject).replace(/\.+$/, "").trim() }
    : { ...draft, body };
}

/* ---------------------------------------------------- live chat stream scrubbing ---- */

const DRAFT_OPEN = /^[ \t]*```[ \t]*draft[ \t:]+(email|linkedin)\b/i;
const FENCE = /^[ \t]*```/;

/**
 * `scrubPunctuation` applied to the draft blocks of a chat answer WHILE it streams, so the text
 * the editor starts from (and copies or sends) is already clean, not only the stored copy.
 * Prose outside a draft block passes through untouched: the bans are for messages the user
 * sends, not for Orbit's own answers.
 *
 * Line by line. Prose streams as it arrives, except a line that starts with a backtick, which
 * is held until its newline because it may be a fence. Inside a draft block each line is held
 * until it is whole and scrubbed as one.
 *
 * ponytail: a draft line streams in one piece rather than word by word; a LinkedIn note is
 * one line, so it appears all at once. Hold at the last word instead if that feels slow.
 */
export function createDraftStreamScrubber() {
  let line = "";
  /** How much of `line` already went out (prose only; a held line has 0). */
  let sent = 0;
  let inDraft = false;

  const finish = (whole: string): string => {
    if (inDraft) {
      if (FENCE.test(whole)) {
        inDraft = false;
        return whole;
      }
      return scrubPunctuation(whole);
    }
    if (DRAFT_OPEN.test(whole)) inDraft = true;
    return whole;
  };

  return {
    /** Feed a delta; returns what may be shown now (possibly empty). */
    push(delta: string): string {
      line += delta;
      let out = "";
      let nl: number;
      while ((nl = line.indexOf("\n")) !== -1) {
        out += finish(line.slice(0, nl + 1)).slice(sent);
        line = line.slice(nl + 1);
        sent = 0;
      }
      const lead = line.trimStart();
      if (!inDraft && lead && !lead.startsWith("`")) {
        out += line.slice(sent);
        sent = line.length;
      }
      return out;
    },
    /** The held tail, once the stream has ended. */
    flush(): string {
      const out = line ? finish(line).slice(sent) : "";
      line = "";
      sent = 0;
      return out;
    },
  };
}
