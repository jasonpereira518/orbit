/**
 * A drafted message inside a chat answer, as a fenced block the person can edit in place:
 *
 *   ```draft email to=<contact id>        ```draft linkedin to=<contact id>
 *   Subject: Quick intro                  Hi Priya, I enjoyed your talk on ...
 *
 *   Hi Priya, ...
 *   ```
 *
 * The block is the draft's whole storage: it lives in the saved answer's text, so an edit is a
 * rewrite of that text (`replaceDraftBlock`) — no second model call, it survives a reload, and
 * the next turn reads the EDITED draft from the thread like any other part of the answer.
 * `to=` is optional and only ever a contact id the server offered this answer
 * (`normalizeDraftBlocks`); the send path still re-checks the contact is the user's own.
 *
 * Pure — no React, no DB — so the route, the renderer, the save action and the smoke share it.
 */
import { DRAFT_MAX_CHARS, sanitizeDraft } from "@/lib/chat-draft";
import { LINKEDIN_NOTE_MAX, scrubPunctuation } from "@/lib/message-format";

export type DraftChannel = "email" | "linkedin";

/** LinkedIn's limit on a connection note (the free-account one), from the house format. */
export { LINKEDIN_NOTE_MAX };
/** A subject is one line; the send path's own cap (`SEND_SUBJECT_MAX`). */
export const DRAFT_SUBJECT_MAX = 200;
/**
 * The most a LinkedIn note may be STORED at. Past the limit is allowed on purpose — typing or
 * pasting over it must not silently truncate — and flagged where it is edited and copied.
 */
export const LINKEDIN_NOTE_STORE_MAX = 1000;

export type DraftParts = {
  channel: DraftChannel;
  /** The contact it is for, when the answer named one. */
  contactId: string | null;
  /** Email only. */
  subject: string;
  body: string;
};

const OPEN = /^[ \t]*```[ \t]*draft[ \t:]+(email|linkedin)\b([^\n]*)$/i;
const CLOSE = /^[ \t]*```[ \t]*$/;
const ANY_FENCE = /^[ \t]*```/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function openOf(line: string): { channel: DraftChannel; contactId: string | null } | null {
  const m = OPEN.exec(line);
  if (!m) return null;
  const to = /\bto=([^\s]+)/i.exec(m[2] ?? "")?.[1] ?? null;
  return { channel: m[1].toLowerCase() as DraftChannel, contactId: to && UUID.test(to) ? to.toLowerCase() : null };
}

/** The subject line and body of an email block's inner lines; a LinkedIn note is all body. */
function partsOf(channel: DraftChannel, inner: string[]): { subject: string; body: string } {
  if (channel === "linkedin") return { subject: "", body: inner.join("\n").trim() };
  const first = inner.findIndex((l) => l.trim() !== "");
  const m = first >= 0 ? /^[ \t]*subject[ \t]*:[ \t]*(.*)$/i.exec(inner[first]) : null;
  if (!m) return { subject: "", body: inner.join("\n").trim() };
  return { subject: m[1].replace(/\s+/g, " ").trim(), body: inner.slice(first + 1).join("\n").trim() };
}

export type DraftFence = DraftParts & {
  /** The block as it stands in the text, closing line included when there is one. */
  raw: string;
  /** False while the closing fence has not arrived (a streaming answer, or a cut-off one). */
  closed: boolean;
  /** Index of the line after the block. */
  next: number;
};

/**
 * The draft block that opens at `lines[at]`, or null if that line does not open one.
 * Reads to the closing fence, or to the end of the text when it has not arrived.
 */
export function readDraftFence(lines: readonly string[], at: number): DraftFence | null {
  const open = openOf(lines[at] ?? "");
  if (!open) return null;
  let end = at + 1;
  while (end < lines.length && !CLOSE.test(lines[end])) end++;
  const closed = end < lines.length;
  const { subject, body } = partsOf(open.channel, lines.slice(at + 1, end));
  return {
    ...open,
    subject,
    body,
    raw: lines.slice(at, closed ? end + 1 : end).join("\n"),
    closed,
    next: closed ? end + 1 : end,
  };
}

/** One block as text, canonical: the form the stored answer carries. */
export function formatDraftBlock(d: DraftParts): string {
  // A fence line inside the text would close the block early.
  const clean = (t: string) => t.replace(/`{3,}/g, "");
  const head = `\`\`\`draft ${d.channel}${d.contactId ? ` to=${d.contactId}` : ""}`;
  const subject = d.channel === "email" && d.subject.trim() ? `Subject: ${clean(d.subject).replace(/\s+/g, " ").trim()}\n\n` : "";
  return `${head}\n${subject}${clean(d.body).trim()}\n\`\`\``;
}

/** Every draft block in the text, in order, skipping any inside another code fence. */
export function draftBlocksIn(text: string): Array<DraftFence & { index: number; start: number }> {
  const lines = text.split("\n");
  const out: Array<DraftFence & { index: number; start: number }> = [];
  let fenced = false;
  for (let i = 0; i < lines.length; ) {
    if (!fenced) {
      const block = readDraftFence(lines, i);
      if (block) {
        out.push({ ...block, index: out.length, start: i });
        i = block.next;
        continue;
      }
    }
    if (ANY_FENCE.test(lines[i])) fenced = !fenced;
    i++;
  }
  return out;
}

/** The contact ids the answer's draft blocks name — what the send path may mail. */
export function draftContactIdsIn(text: string): string[] {
  return [...new Set(draftBlocksIn(text).flatMap((b) => (b.contactId ? [b.contactId] : [])))];
}

/**
 * Every draft block rewritten to its canonical form, with a `to=` the server never offered
 * dropped (the block stays; only the recipient goes) and an unfinished block closed. The
 * stored answer goes through this, so a reload shows only recipients that were real.
 *
 * Model text only, so the house bans apply: dashes and "!" are scrubbed here as they were in
 * the live stream (`createDraftStreamScrubber`). A person's own edit never passes through
 * this (`cleanDraftEdit`), so their punctuation is theirs.
 */
export function normalizeDraftBlocks(text: string, knownPeople: ReadonlySet<string>): string {
  const lines = text.split("\n");
  const blocks = draftBlocksIn(text);
  if (!blocks.length) return text;
  const out: string[] = [];
  let at = 0;
  for (const b of blocks) {
    out.push(...lines.slice(at, b.start));
    out.push(
      formatDraftBlock({
        channel: b.channel,
        contactId: b.contactId && knownPeople.has(b.contactId) ? b.contactId : null,
        subject: scrubPunctuation(b.subject),
        body: scrubPunctuation(b.body),
      })
    );
    at = b.next;
  }
  out.push(...lines.slice(at));
  return out.join("\n");
}

/** What an edit may be stored as, or null when it should not be stored at all. */
export function cleanDraftEdit(channel: DraftChannel, edit: { subject?: unknown; body: unknown }): { subject: string; body: string } | null {
  const body = sanitizeDraft(edit.body);
  if (!body) return null;
  const cap = channel === "linkedin" ? LINKEDIN_NOTE_STORE_MAX : DRAFT_MAX_CHARS;
  const subject =
    channel === "email" && typeof edit.subject === "string"
      ? (sanitizeDraft(edit.subject) ?? "").replace(/\s+/g, " ").trim()
      : "";
  return {
    subject: Array.from(subject).slice(0, DRAFT_SUBJECT_MAX).join(""),
    body: Array.from(body).slice(0, cap).join("").trim(),
  };
}

/**
 * The text with the `index`th draft block's subject and body replaced; null when there is no
 * such block or the edit is empty. Recipient and channel stay as they were — an edit changes
 * words, never who a message is for.
 */
export function replaceDraftBlock(
  text: string,
  index: number,
  edit: { subject?: unknown; body: unknown }
): string | null {
  const target = draftBlocksIn(text)[index];
  if (!target) return null;
  const cleaned = cleanDraftEdit(target.channel, edit);
  if (!cleaned) return null;
  const lines = text.split("\n");
  const next = formatDraftBlock({ channel: target.channel, contactId: target.contactId, ...cleaned });
  return [...lines.slice(0, target.start), next, ...lines.slice(target.next)].join("\n");
}

/* --------------------------------------------------------------- LinkedIn limit ---- */

/** Characters as LinkedIn counts them: code points, newlines included. */
export function noteLength(note: string): number {
  return Array.from(note.trim()).length;
}

export type NoteStatus = {
  length: number;
  limit: number;
  /** Characters left; negative when over. */
  remaining: number;
  over: boolean;
};

export function noteStatus(note: string, limit = LINKEDIN_NOTE_MAX): NoteStatus {
  const length = noteLength(note);
  return { length, limit, remaining: limit - length, over: length > limit };
}

/** The sentence a screen reader hears about the counter. */
export function noteStatusText(s: NoteStatus): string {
  return s.over
    ? `${-s.remaining} over LinkedIn’s ${s.limit}-character limit`
    : `${s.remaining} of ${s.limit} characters left`;
}

/**
 * Whether a note may be copied or sent as it stands. An over-limit note needs an explicit
 * go-ahead (`acknowledged`), because LinkedIn cuts it off or refuses it.
 */
export function mayUseNote(note: string, acknowledged: boolean): { ok: true } | { ok: false; over: number } {
  const s = noteStatus(note);
  return s.over && !acknowledged ? { ok: false, over: -s.remaining } : { ok: true };
}
