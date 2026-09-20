/**
 * Turns a meeting transcript into what the capture flow can use: a call-level digest
 * (summary, decisions, action items, blockers, open questions, who was there) and a short
 * first-person "corpus" for the existing people/dates extraction to read.
 *
 * WHY NOT HAND THE TRANSCRIPT STRAIGHT TO `parseBulkCaptureNotes`. Three reasons, all
 * found by reading that pipeline rather than guessed:
 *
 *   1. Length. An hour is ~55k characters. The two-pass people parse sends the whole note
 *      once per batch of four people, sequentially, each under the 45s deadline — a long
 *      call times out on slower models.
 *   2. Voice. Its prompts assume one writer saying "I". A transcript is several people
 *      saying "I", with no labels, so every first person is ambiguous.
 *   3. Dates. `fetchRawCommitments` reads the first 60k characters and swallows a
 *      truncated JSON answer as "no dates" — silently, by design.
 *
 * So this module reads the transcript once (map-reduce when it is long), and the parse
 * reads the digest's first-person notes instead, plus the verbatim quotes that carry dates.
 *
 * TRUST. The model only proposes. Every quote, excerpt and due phrase it returns is kept
 * only if it actually appears in the transcript (`groundDigest`), and dated commitments
 * are validated against the transcript, not the corpus, in `parseBulkCaptureNotes` — so a
 * date the digest invented cannot become a reminder.
 */
import { z } from "zod";
import type { MeetingDigest } from "@/db/schema";

/** Above this, one call is too slow and too lossy; split and merge instead. */
export const MAP_THRESHOLD_CHARS = 30_000;
/** One map piece. Small enough to answer well inside the 45s completion deadline. */
export const MAP_PIECE_CHARS = 20_000;
/** Parallel map calls. BYO keys include free tiers with low per-minute limits. */
const MAP_CONCURRENCY = 3;
/** What `parseBulkCaptureNotes` gets. Under its two-pass threshold's reach many times over. */
export const CORPUS_MAX_CHARS = 20_000;

const LIST_CAPS = {
  keyPoints: 12,
  decisions: 12,
  actionItems: 25,
  blockers: 15,
  openQuestions: 15,
  participants: 25,
  datedQuotes: 20,
} as const;

// ── Schema ────────────────────────────────────────────────────────────────────────────
//
// Tolerant on purpose, the same way `datedCommitmentsSchema` is: a model that omits one
// key or sends null for a list must cost that field, never the whole digest.

const str = z
  .string()
  .nullish()
  .transform((v) => v?.replace(/\s+/g, " ").trim() || null);

/** Anything that is not an array — null, a string, an object — is an empty list. */
const list = <T extends z.ZodTypeAny>(item: T) =>
  // `.optional()` is load-bearing in zod 4: without it a missing key is an error before the
  // transform ever runs, and one omitted list would sink the whole digest.
  z.unknown().optional().transform((v) =>
    (Array.isArray(v) ? v : []).flatMap((entry) => {
      const parsed = item.safeParse(entry);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    })
  );

export const meetingDigestSchema = z.object({
  title: str,
  summary: str,
  key_points: list(z.string()),
  decisions: list(z.string()),
  action_items: list(
    z.object({
      text: z.string().min(1),
      owner: str,
      due_phrase: str,
      source_excerpt: str,
    })
  ),
  blockers: list(z.object({ text: z.string().min(1), owner: str, source_excerpt: str })),
  open_questions: list(z.object({ text: z.string().min(1), asked_by: str, source_excerpt: str })),
  participants: list(
    z.object({
      name: z.string().min(1),
      present: z
        .boolean()
        .nullish()
        .transform((v) => v ?? true),
      context: str,
    })
  ),
  dated_quotes: list(z.string()),
  notes: str,
});

export type RawMeetingDigest = z.output<typeof meetingDigestSchema>;

/** Model output (snake_case, loose) → the stored shape (camelCase, capped, cleaned). */
export function normalizeDigest(raw: RawMeetingDigest, fallbackTitle: string): MeetingDigest {
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const uniq = (items: string[], cap: number) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items.map(clean)) {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= cap) break;
    }
    return out;
  };
  const owner = (o: string | null) => {
    if (!o) return null;
    const t = o.trim();
    return /^(unclear|unknown|n\/a|none|null|someone)$/i.test(t) ? null : t;
  };
  return {
    title: raw.title || fallbackTitle,
    summary: raw.summary || "",
    keyPoints: uniq(raw.key_points, LIST_CAPS.keyPoints),
    decisions: uniq(raw.decisions, LIST_CAPS.decisions),
    actionItems: raw.action_items.slice(0, LIST_CAPS.actionItems).map((a) => ({
      text: clean(a.text),
      owner: owner(a.owner),
      duePhrase: a.due_phrase,
      sourceExcerpt: a.source_excerpt,
    })),
    blockers: raw.blockers.slice(0, LIST_CAPS.blockers).map((b) => ({
      text: clean(b.text),
      owner: owner(b.owner),
      sourceExcerpt: b.source_excerpt,
    })),
    openQuestions: raw.open_questions.slice(0, LIST_CAPS.openQuestions).map((q) => ({
      text: clean(q.text),
      askedBy: owner(q.asked_by),
      sourceExcerpt: q.source_excerpt,
    })),
    participants: dedupeParticipants(raw.participants).slice(0, LIST_CAPS.participants),
    datedQuotes: uniq(raw.dated_quotes, LIST_CAPS.datedQuotes),
    notes: raw.notes || "",
  };
}

function dedupeParticipants(people: RawMeetingDigest["participants"]): MeetingDigest["participants"] {
  const byName = new Map<string, MeetingDigest["participants"][number]>();
  for (const p of people) {
    const name = p.name.replace(/\s+/g, " ").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const prev = byName.get(key);
    // Present anywhere wins: a map piece where they only came up does not demote someone
    // another piece heard speaking.
    byName.set(key, {
      name: prev?.name ?? name,
      present: Boolean(prev?.present || p.present),
      context: prev?.context || p.context,
    });
  }
  return [...byName.values()];
}

// ── Grounding ─────────────────────────────────────────────────────────────────────────

/**
 * Loose enough to survive the punctuation and casing a model changes when it quotes,
 * strict enough that an invented sentence does not match: letters and digits only.
 */
export function normalizeForContainment(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();
}

export function appearsIn(haystackNormalized: string, needle: string | null): boolean {
  if (!needle) return false;
  const n = normalizeForContainment(needle);
  return n.length > 0 && haystackNormalized.includes(n);
}

/**
 * Keep only what the transcript actually says. An excerpt or due phrase that is not in
 * the transcript is cleared (the item itself stays — the summary of a task can be right
 * even when its "quote" was paraphrased); a dated quote that is not in it is dropped,
 * because the quote IS the item and it exists only to carry a real date downstream.
 */
export function groundDigest(digest: MeetingDigest, transcript: string): MeetingDigest {
  const hay = normalizeForContainment(transcript);
  const keep = (s: string | null) => (appearsIn(hay, s) ? s : null);
  return {
    ...digest,
    actionItems: digest.actionItems.map((a) => ({
      ...a,
      duePhrase: keep(a.duePhrase),
      sourceExcerpt: keep(a.sourceExcerpt),
    })),
    blockers: digest.blockers.map((b) => ({ ...b, sourceExcerpt: keep(b.sourceExcerpt) })),
    openQuestions: digest.openQuestions.map((q) => ({ ...q, sourceExcerpt: keep(q.sourceExcerpt) })),
    datedQuotes: digest.datedQuotes.filter((q) => appearsIn(hay, q)),
  };
}

/**
 * The user is on every call they record; they are never a contact to create. Matched on
 * the full name and on the first name alone, since the model often has only what was said.
 */
export function isSelf(name: string, self: { firstName?: string | null; lastName?: string | null }): boolean {
  const n = name.replace(/\s+/g, " ").trim().toLowerCase();
  if (n === "me" || n === "i" || n === "myself") return true;
  const first = self.firstName?.trim().toLowerCase();
  const last = self.lastName?.trim().toLowerCase();
  if (!n || !first) return false;
  if (n === first) return true;
  return Boolean(last && n === `${first} ${last}`);
}

// ── Splitting ─────────────────────────────────────────────────────────────────────────

/**
 * Pack transcript paragraphs (one per recorded chunk) into pieces of at most `maxChars`,
 * never splitting a paragraph unless it alone is over the limit — then at sentence ends.
 */
export function splitTranscript(paragraphs: string[], maxChars = MAP_PIECE_CHARS): string[] {
  const pieces: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };
  for (const raw of paragraphs) {
    const para = raw.trim();
    if (!para) continue;
    const units = para.length > maxChars ? splitLongParagraph(para, maxChars) : [para];
    for (const unit of units) {
      if (current && current.length + unit.length + 2 > maxChars) push();
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  push();
  return pieces;
}

function splitLongParagraph(text: string, maxChars: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (current) out.push(current.trim());
      current = "";
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars).trim());
      continue;
    }
    if (current.length + s.length > maxChars) {
      out.push(current.trim());
      current = "";
    }
    current += s;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

// ── The corpus the people/dates parse reads ────────────────────────────────────────────

export type MeetingMeta = {
  title: string | null;
  startedAtIso: string;
  userName: string | null;
  /** Everyone known to have been on the call, from the user's list and the digest. */
  presentNames: string[];
};

/**
 * First-person meeting notes, shaped like the pastes `parseMultiPersonNotesWithAI` was
 * written for: who was there, what was discussed with whom, what was agreed, and the
 * verbatim lines that carry dates (so `fetchRawCommitments` finds real phrasing to quote).
 * The header states who "I" is, which is the one thing the transcript never says.
 */
export function buildMeetingCorpus(digest: MeetingDigest, meta: MeetingMeta): string {
  const date = new Date(meta.startedAtIso);
  const dateLabel = Number.isNaN(date.getTime())
    ? meta.startedAtIso
    : date.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
  const header = [
    `Video call${meta.title ? ` — "${meta.title}"` : ""} on ${dateLabel}.`,
    meta.userName ? `I am ${meta.userName}; these are my notes.` : "These are my notes.",
    meta.presentNames.length ? `On the call: ${meta.presentNames.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const sections: string[] = [header];
  if (digest.notes) sections.push(digest.notes);
  if (digest.actionItems.length) {
    sections.push(
      "Next steps:\n" +
        digest.actionItems
          .map((a) => `- ${a.text}${a.owner ? ` (${a.owner === "me" ? "me" : a.owner})` : ""}`)
          .join("\n")
    );
  }
  if (digest.datedQuotes.length) {
    sections.push("Said on the call:\n" + digest.datedQuotes.map((q) => `"${q}"`).join("\n"));
  }

  let corpus = sections.join("\n\n");
  if (corpus.length > CORPUS_MAX_CHARS) corpus = corpus.slice(0, CORPUS_MAX_CHARS);
  return corpus;
}

// ── The model calls ───────────────────────────────────────────────────────────────────

export type CompleteJsonFn = (
  userId: string,
  input: { system: string; user: string; maxOutputTokens?: number; operation?: string; temperature?: number }
) => Promise<string>;

export type AnalyzeInput = {
  /** One entry per recorded chunk, in order. Empty chunks already removed. */
  paragraphs: string[];
  title: string | null;
  startedAtIso: string;
  userName: string | null;
  attendees: string[];
};

const SHAPE = `{
  "title": string,                 // short meeting title; reuse the given one if there is one
  "summary": string,               // 3-6 sentences: purpose, what happened, outcome
  "key_points": string[],
  "decisions": string[],           // things actually agreed, not merely discussed
  "action_items": [{ "text": string, "owner": string | null, "due_phrase": string | null, "source_excerpt": string | null }],
  "blockers": [{ "text": string, "owner": string | null, "source_excerpt": string | null }],
  "open_questions": [{ "text": string, "asked_by": string | null, "source_excerpt": string | null }],
  "participants": [{ "name": string, "present": boolean, "context": string | null }],
  "dated_quotes": string[],
  "notes": string
}`;

function systemPrompt(input: AnalyzeInput, part: { index: number; total: number } | null): string {
  const who = input.userName ? `${input.userName} (called "the user" below)` : "the user";
  return [
    `You are reading the transcript of a video call (Zoom or Google Meet) that ${who} recorded for their personal networking CRM.`,
    `How the transcript was made — this matters: it is machine speech-to-text of ONE mixed audio stream, the user's microphone plus everyone else's audio. There are NO speaker labels and turns are not marked. Paragraph breaks are roughly one-minute recording chunks, not changes of speaker. Names may be misspelled.`,
    part
      ? `This is part ${part.index} of ${part.total} of the transcript. Extract only what is in this part.`
      : "",
    "Return JSON of exactly this shape:",
    SHAPE,
    "Rules:",
    `- action_items: concrete next steps someone committed to or was asked to do. "owner" is "me" ONLY when it is clear the user took it on (e.g. they are addressed by name and agree); a person's name when it was said out loud; otherwise null. Never guess an owner from who probably spoke.`,
    `- due_phrase: the exact words from the transcript that say when ("by Friday", "next week", "September 30"), or null.`,
    `- blockers: things stopping progress or waiting on someone/something — an approval, a dependency, missing information.`,
    `- open_questions: questions raised that were NOT answered by the end of the call.`,
    `- participants: people who were on the call ("present": true — they spoke or were spoken to) and people only mentioned ("present": false). Include what you learned about each in "context" (role, company, what they talked about). Do not include the user.`,
    `- dated_quotes: sentences copied EXACTLY from the transcript that mention a date, day or deadline. At most ${LIST_CAPS.datedQuotes}.`,
    `- source_excerpt: a short quote (under 25 words) copied EXACTLY from the transcript, or null.`,
    `- notes: the user's own meeting notes, written in the first person as they would jot them down after the call — who was there, what was discussed with whom, what each person cares about or offered, what was agreed, and every follow-up with its timing in the transcript's words. 150-600 words. Plain prose, no headings.`,
    "- Never invent names, dates, numbers or commitments. Use [] or null when there is nothing.",
  ]
    .filter(Boolean)
    .join("\n");
}

function userPrompt(input: AnalyzeInput, transcript: string): string {
  const context = [
    input.title ? `Meeting title: ${input.title}` : "",
    `Date: ${input.startedAtIso.slice(0, 10)}`,
    input.attendees.length ? `Attendees the user listed: ${input.attendees.join(", ")}` : "",
  ].filter(Boolean);
  return `${context.join("\n")}\n\nTRANSCRIPT:\n${transcript}`;
}

function reducePrompt(input: AnalyzeInput) {
  return [
    `You are merging partial analyses of one long video call, each made from a consecutive part of its transcript, into a single analysis of the whole call.`,
    input.userName ? `The user who recorded it is ${input.userName}.` : "",
    "Return JSON of exactly this shape:",
    SHAPE,
    "Rules:",
    "- Merge duplicates (the same task, question or person named in several parts) into one entry, keeping the most specific wording.",
    "- An open question answered in a later part is no longer open — drop it. A blocker resolved later is no longer a blocker.",
    "- Keep every source_excerpt, due_phrase and dated_quote exactly as given; do not rewrite quotes.",
    "- A participant who is present in any part is present.",
    "- Rewrite summary and notes to cover the whole call in order; notes stay in the user's first person, 200-700 words.",
    "- Never add anything that is not in the partial analyses.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function callDigest(
  complete: CompleteJsonFn,
  parseJson: (raw: string) => unknown,
  userId: string,
  system: string,
  user: string,
  operation: string
): Promise<RawMeetingDigest> {
  const raw = await complete(userId, {
    system,
    user,
    maxOutputTokens: 6000,
    temperature: 0.2,
    operation,
  });
  const parsed = meetingDigestSchema.safeParse(parseJson(raw));
  if (!parsed.success) throw new Error("The AI's meeting summary was unreadable — try again");
  return parsed.data;
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Analyze a whole meeting. One call when it is short; otherwise one call per ~20k-char
 * piece (at most three at a time) and one more to merge them. Grounded against the full
 * transcript before it is returned.
 */
export async function analyzeMeetingTranscript(
  userId: string,
  input: AnalyzeInput,
  deps: { complete: CompleteJsonFn; parseJson: (raw: string) => unknown }
): Promise<MeetingDigest> {
  const transcript = input.paragraphs.map((p) => p.trim()).filter(Boolean).join("\n\n");
  if (!transcript) throw new Error("Nothing was transcribed in that meeting");
  const fallbackTitle = input.title || "Meeting";

  let raw: RawMeetingDigest;
  if (transcript.length <= MAP_THRESHOLD_CHARS) {
    raw = await callDigest(
      deps.complete,
      deps.parseJson,
      userId,
      systemPrompt(input, null),
      userPrompt(input, transcript),
      "meeting.digest"
    );
  } else {
    const pieces = splitTranscript(input.paragraphs);
    const partials = await mapLimited(pieces, MAP_CONCURRENCY, (piece, i) =>
      callDigest(
        deps.complete,
        deps.parseJson,
        userId,
        systemPrompt(input, { index: i + 1, total: pieces.length }),
        userPrompt(input, piece),
        "meeting.digest.map"
      )
    );
    raw = await callDigest(
      deps.complete,
      deps.parseJson,
      userId,
      reducePrompt(input),
      partials.map((p, i) => `PART ${i + 1}:\n${JSON.stringify(p)}`).join("\n\n"),
      "meeting.digest.reduce"
    );
  }

  return groundDigest(normalizeDigest(raw, fallbackTitle), transcript);
}
