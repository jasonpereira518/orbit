/**
 * One parsed conversation → the job rows the browser stages for it, after the preview has
 * decided who each participant is. Pure and browser-safe (no @/db, node:*, or next/*).
 */
import { conversationKey, groupHeader, splitSessions } from "@/lib/conversations/sessions";
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

export function conversationToRows(
  c: Conversation,
  selfKey: string | null,
  decisions: Record<string, ParticipantDecision>,
): ChatConversationRow[] {
  // Rule: split and key once per conversation — every participant's row shares them.
  const sessions = splitSessions(c, selfKey);
  const key = conversationKey(c);
  // Rule: group transcripts carry one header line, and the transcript's TAIL is cut so
  // header + transcript stays within the session cap the server enforces.
  const header = c.isGroup ? `${groupHeader(c).slice(0, MAX_HEADER)}\n` : "";
  const shaped = sessions.map((s) => ({
    startAt: s.startAt,
    endAt: s.endAt,
    messageCount: s.messageCount,
    direction: s.direction,
    transcript: header ? (header + s.transcript).slice(0, SESSION_MAX_CHARS) : s.transcript,
  }));

  const rows: ChatConversationRow[] = [];
  for (const p of c.participants) {
    // Rule: the owner never gets a row.
    if (p.isSelf || (selfKey != null && p.key === selfKey)) continue;
    // Rule: absent a decision, a 1:1 creates its contact and a group member is skipped —
    // unmatched group members are never auto-created.
    const decision = decisions[p.key] ?? (c.isGroup ? { contactId: null, create: false } : { contactId: null, create: true });
    if (!decision.contactId && !decision.create) continue;
    rows.push({
      kind: "chat_conversation",
      source: c.source,
      conversationKey: key,
      isGroup: c.isGroup,
      title: c.title.slice(0, MAX_TITLE),
      participant: {
        key: p.key.slice(0, MAX_KEY),
        displayName: p.displayName.slice(0, MAX_NAME),
        phoneE164: p.phoneE164,
        email: p.email,
      },
      resolvedContactId: decision.contactId,
      createIfUnmatched: decision.create,
      sessions: shaped,
    });
  }
  return rows;
}
