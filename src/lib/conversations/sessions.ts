/**
 * A chat becomes "sessions": runs of messages with no gap over 6 hours, split further at 200
 * messages or 12,000 characters. One session is one timeline entry, so a 10,000-message chat
 * is a few hundred rows, not 10,000. Transcript times are rendered in the local zone the
 * parser read them in.
 */
import { clampCodePoints } from "@/lib/conversations/clamp";
import { fnv1a64 } from "@/lib/conversations/hash";
import {
  SESSION_GAP_MS, SESSION_MAX_CHARS, SESSION_MAX_MESSAGES,
  type ChatSession, type ChatSource, type Conversation,
} from "@/lib/conversations/types";

/** What a key is computed from — the preview has these fields without the messages. */
export type ConversationKeyInput = {
  source: ChatSource;
  title: string;
  isGroup: boolean;
  participants: ReadonlyArray<{ key: string; isSelf?: boolean }>;
};

/** Titles that name no particular group: the export's own placeholders. */
const GENERIC_TITLE_RE = /^(?:_?chat|whatsapp chat)$/i;

/**
 * The same chat exported again must keep its key, or its sessions land twice and the preview
 * cannot find who it went to last time. So the key leaves out whatever a re-export changes:
 * - a group is its title (members come and go); a placeholder title falls back to the
 *   sorted participant labels;
 * - a 1:1 is the other person's label (the file name and the owner's own label vary).
 *   With no single other person (owner unknown) it falls back to the participant labels.
 * The kind is part of the hash, so a group titled "Maya" is not Maya's 1:1.
 */
export function conversationKey(c: ConversationKeyInput, selfKey: string | null): string {
  const all = c.participants.map((p) => p.key).sort().join("\u001f");
  if (c.isGroup) {
    const title = c.title.replace(/\s+/g, " ").trim();
    return title && !GENERIC_TITLE_RE.test(title)
      ? fnv1a64(`${c.source}\u001fgroup\u001f${title}`)
      : fnv1a64(`${c.source}\u001fgroup-members\u001f${all}`);
  }
  const others = c.participants.filter((p) => !p.isSelf && p.key !== selfKey);
  return others.length === 1
    ? fnv1a64(`${c.source}\u001fdm\u001f${others[0].key}`)
    : fnv1a64(`${c.source}\u001fdm-members\u001f${all}`);
}

export function sessionExternalId(source: ChatSource, key: string, startAtIso: string, contactId: string): string {
  return `chat:${source}:${key}:${Math.floor(new Date(startAtIso).getTime() / 1000)}:${contactId}`;
}

export function groupHeader(c: Conversation): string {
  const names = c.participants.filter((p) => !p.isSelf).map((p) => p.displayName);
  return `# Group chat "${c.title}" with ${names.join(", ")}`;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function line(atIso: string, speaker: string, text: string): string {
  const d = new Date(atIso);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `[${stamp} ${speaker}] ${text.replace(/\s*\n\s*/g, " / ")}`;
}

/**
 * `prefixChars`: room to keep free in every session for header lines the caller prepends
 * (plus the newline joining them), so prefix + transcript never exceeds SESSION_MAX_CHARS and
 * nothing has to be cut afterwards.
 */
export function splitSessions(
  c: Conversation,
  selfKey: string | null,
  opts: { prefixChars?: number } = {},
): ChatSession[] {
  const prefix = opts.prefixChars ? opts.prefixChars + 1 : 0;
  // Never below a sliver: a caller's header is capped well under the session size.
  const budget = Math.max(1_000, SESSION_MAX_CHARS - prefix);
  const sessions: ChatSession[] = [];
  type Cur = { lines: string[]; chars: number; start: string; end: string; count: number; lastSender: string };
  let cur: Cur | null = null;
  const flush = () => {
    if (!cur) return;
    sessions.push({
      startAt: cur.start,
      endAt: cur.end,
      messageCount: cur.count,
      direction: selfKey == null ? null : cur.lastSender === selfKey ? "out" : "in",
      transcript: cur.lines.join("\n"),
    });
    cur = null;
  };
  let prevAt = -Infinity;
  for (const m of c.messages) {
    const t = new Date(m.at).getTime();
    const speaker = selfKey != null && m.senderKey === selfKey ? "Me" : m.senderKey;
    let l = line(m.at, speaker, m.text);
    if (l.length > budget) l = clampCodePoints(l, budget);
    const gap = t - prevAt > SESSION_GAP_MS;
    if (!cur || gap || cur.count >= SESSION_MAX_MESSAGES || cur.chars + l.length + 1 > budget) {
      flush();
      cur = { lines: [], chars: 0, start: m.at, end: m.at, count: 0, lastSender: m.senderKey };
    }
    cur.lines.push(l);
    cur.chars += l.length + 1;
    cur.end = m.at;
    cur.count += 1;
    cur.lastSender = m.senderKey;
    prevAt = t;
  }
  flush();
  return sessions;
}
