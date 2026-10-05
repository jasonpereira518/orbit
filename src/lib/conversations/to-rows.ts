/**
 * One parsed conversation → the job rows the browser stages for it, after the preview has
 * decided who each participant is. Pure and browser-safe (no @/db, node:*, or next/*).
 */
import { conversationKey, groupHeader, splitSessions } from "@/lib/conversations/sessions";
import { clampCodePoints } from "@/lib/conversations/clamp";
import { SESSION_MAX_CHARS, type Conversation } from "@/lib/conversations/types";

/**
 * `ChatConversationRowPayload` (src/db/schema.ts), restated: this directory may not import
 * @/db, even for a type. `src/lib/chat-import-preview.ts` asserts the two stay identical.
 */
export type ChatConversationRow = {
  kind: "chat_conversation";
  source: "whatsapp" | "imessage";
  conversationKey: string;
  isGroup: boolean;
  title: string;
  participant: { key: string; displayName: string; phoneE164: string | null; email: string | null };
  resolvedContactId?: string | null;
  createIfUnmatched: boolean;
  sessions: { startAt: string; endAt: string; messageCount: number; direction: "in" | "out" | null; transcript: string }[];
};

/** What the person decided for one participant: a contact to pin, and/or permission to create. */
export type ParticipantDecision = { contactId: string | null; create: boolean };

/** The server's own row bounds (`appendStagedRows`), applied here so a long label never fails the upload. */
const MAX_TITLE = 200;
const MAX_NAME = 200;
const MAX_KEY = 300;
/**
 * A group header names every member, so a very large group could otherwise spend the whole
 * 12,000-char session budget on names and leave no transcript.
 */
const MAX_HEADER = 1_000;
/**
 * One staged row's bounds. A long chat would otherwise be one row of thousands of sessions —
 * megabytes the upload batches, the engine's chunk read and its interaction insert all have
 * to carry at once. Rows of one participant share everything but their sessions, and each
 * session's external id is its own, so splitting changes nothing the engine writes.
 */
export const MAX_ROW_SESSIONS = 50;
export const MAX_ROW_JSON_CHARS = 1_000_000;

/** The second group header line: which sender this contact's row is about. */
export function attributionLine(displayName: string): string {
  return `# This contact appears as "${displayName}"`;
}

type RowSession = ChatConversationRow["sessions"][number];

/** Consecutive runs of sessions, each within the session-count and JSON-size bounds. */
function packSessions(baseChars: number, sessions: RowSession[]): RowSession[][] {
  const out: RowSession[][] = [];
  let cur: RowSession[] = [];
  let chars = baseChars;
  for (const s of sessions) {
    const size = JSON.stringify(s).length + 1;
    if (cur.length && (cur.length >= MAX_ROW_SESSIONS || chars + size > MAX_ROW_JSON_CHARS)) {
      out.push(cur);
      cur = [];
      chars = baseChars;
    }
    cur.push(s);
    chars += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function conversationToRows(
  c: Conversation,
  selfKey: string | null,
  decisions: Record<string, ParticipantDecision>,
  /** Every label the preview recognised as the owner; none of them gets a row. */
  ownerKeys: readonly string[] = [],
): ChatConversationRow[] {
  // Rule: the owner the person picked is often a real name the parser could not mark as
  // self; the header names everyone BUT them. A copy — the caller's parse stays untouched.
  const owners = new Set(ownerKeys);
  if (selfKey != null) owners.add(selfKey);
  const owned = owners.size
    ? { ...c, participants: c.participants.map((p) => (owners.has(p.key) ? { ...p, isSelf: true } : p)) }
    : c;

  // Who gets rows. Rule: the owner never gets a row; absent a decision, a 1:1 creates its
  // contact and a group member is skipped — unmatched group members are never auto-created.
  const members = owned.participants.flatMap((p) => {
    if (p.isSelf) return [];
    const decision = decisions[p.key] ?? (c.isGroup ? { contactId: null, create: false } : { contactId: null, create: true });
    if (!decision.contactId && !decision.create) return [];
    return [{ p, decision, displayName: clampCodePoints(p.displayName, MAX_NAME) }];
  });
  if (members.length === 0) return [];

  // Rule: group transcripts start with the group header, then a line naming the sender this
  // row is about. Their room is reserved when the sessions are split, so nothing is cut after.
  const header = c.isGroup ? clampCodePoints(groupHeader(owned), MAX_HEADER) : "";
  const prefixOf = (displayName: string) => (header ? `${header}\n${attributionLine(displayName)}` : "");
  const prefixChars = Math.max(0, ...members.map((m) => prefixOf(m.displayName).length));
  // Rule: split and key once per conversation — every participant's rows share them.
  const sessions = splitSessions(c, selfKey, { prefixChars });
  const key = conversationKey(owned, selfKey);
  const title = clampCodePoints(c.title, MAX_TITLE);

  const rows: ChatConversationRow[] = [];
  for (const { p, decision, displayName } of members) {
    const prefix = prefixOf(displayName);
    const shaped: RowSession[] = sessions.map((s) => ({
      startAt: s.startAt,
      endAt: s.endAt,
      messageCount: s.messageCount,
      direction: s.direction,
      // Defensive only: the split already left room for the prefix.
      transcript: prefix ? clampCodePoints(`${prefix}\n${s.transcript}`, SESSION_MAX_CHARS) : s.transcript,
    }));
    const base: ChatConversationRow = {
      kind: "chat_conversation",
      source: c.source,
      conversationKey: key,
      isGroup: c.isGroup,
      title,
      participant: {
        key: clampCodePoints(p.key, MAX_KEY),
        displayName,
        phoneE164: p.phoneE164,
        email: p.email,
      },
      resolvedContactId: decision.contactId,
      createIfUnmatched: decision.create,
      sessions: [],
    };
    const baseChars = JSON.stringify(base).length;
    for (const part of packSessions(baseChars, shaped)) rows.push({ ...base, sessions: part });
  }
  return rows;
}
