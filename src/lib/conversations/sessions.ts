/**
 * A chat becomes "sessions": runs of messages with no gap over 6 hours, split further at 200
 * messages or 12,000 characters. One session is one timeline entry, so a 10,000-message chat
 * is a few hundred rows, not 10,000. Transcript times are rendered in the local zone the
 * parser read them in.
 */
import { fnv1a64 } from "@/lib/conversations/hash";
import {
  SESSION_GAP_MS, SESSION_MAX_CHARS, SESSION_MAX_MESSAGES,
  type ChatSession, type ChatSource, type Conversation,
} from "@/lib/conversations/types";

export function conversationKey(c: Conversation): string {
  const keys = c.participants.map((p) => p.key).sort().join("\u001f");
  return fnv1a64(`${c.source}\u001f${c.title}\u001f${keys}`);
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

export function splitSessions(c: Conversation, selfKey: string | null): ChatSession[] {
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
    if (l.length > SESSION_MAX_CHARS) l = l.slice(0, SESSION_MAX_CHARS);
    const gap = t - prevAt > SESSION_GAP_MS;
    if (!cur || gap || cur.count >= SESSION_MAX_MESSAGES || cur.chars + l.length + 1 > SESSION_MAX_CHARS) {
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
