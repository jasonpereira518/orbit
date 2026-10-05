/**
 * imessage-exporter `--format txt` (github.com/ReagentX/imessage-exporter, txt templates):
 *   <timestamp>[ (Read by <who> after <duration>)]     "May 17, 2022  5:29:42 PM"
 *   <sender>                                           "Me" for the owner, else a contact name or handle
 *   [This message was deleted from the conversation!]
 *   <body line(s), then attachment file paths>
 *   [Tapbacks:\n    <Kind> by <who> …]                 nested reactions, NOT separate messages
 *   [This message responded to an earlier message.]
 * Replies are rendered nested, indented four spaces, with their own header. Group/system events are a
 * single line "<timestamp> <who> <action>." with no sender line. Tapbacks, deleted messages, announcements,
 * attachment-only paths and the reply trailer are dropped. The file name is the chat's participant list
 * ("A, B, and 2 others.txt"), its group name ("Name - 12.txt") or the single handle.
 * Line-scanned rather than blank-line split, because bodies may contain blank lines.
 */
import { normalizePhoneLoose } from "@/lib/conversations/phone";
import type { ChatMessage, ChatParticipant, Conversation } from "@/lib/conversations/types";

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// \s covers U+00A0 and U+202F, which macOS 14+ puts before AM/PM.
export const IMESSAGE_HEADER_RE = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s?([AP]M)\b/;
/** Legacy/inline tapback text ("Loved “…”"); current exports nest tapbacks under "Tapbacks:". */
const TAPBACK_RE = /^(?:Loved|Liked|Disliked|Laughed at|Emphasized|Questioned|Removed an? [a-z]+ from) [\u201c"]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ATTACHMENT_PATH_RE = /^(?:~|\/|[A-Za-z]:\\).*\.[A-Za-z0-9]{2,5}$/;
const REPLY_TRAILER = "This message responded to an earlier message.";
const DELETED = "This message was deleted from the conversation!";

type Draft = { at: Date; sender: string | null; lines: string[]; skip: boolean; inTapbacks: boolean };

export function parseIMessageExport(text: string, fileName: string): Conversation {
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  const messages: ChatMessage[] = [];
  const counts = new Map<string, number>();
  let skippedLines = 0;
  let cur: Draft | null = null;

  const flush = () => {
    if (!cur) return;
    const body = cur.lines.join("\n").trim();
    if (cur.sender && body && !cur.skip && !TAPBACK_RE.test(body)) {
      messages.push({ senderKey: cur.sender, at: cur.at.toISOString(), text: body });
      counts.set(cur.sender, (counts.get(cur.sender) ?? 0) + 1);
    }
    cur = null;
  };

  for (const raw of rows) {
    const line = raw.trim();
    const h = line.match(IMESSAGE_HEADER_RE);
    if (h && MONTHS[h[1]] != null) {
      const rest = line.slice(h[0].length).trim();
      flush();
      // Announcements ("<date> Me named the conversation X") carry trailing text that is not a receipt.
      if (rest && !rest.startsWith("(")) continue;
      let hour = Number(h[4]);
      if (h[7] === "PM" && hour < 12) hour += 12;
      if (h[7] === "AM" && hour === 12) hour = 0;
      cur = { at: new Date(Number(h[3]), MONTHS[h[1]], Number(h[2]), hour, Number(h[5]), Number(h[6])), sender: null, lines: [], skip: false, inTapbacks: false };
      continue;
    }
    if (!cur) {
      if (line) skippedLines += 1;
      continue;
    }
    if (cur.sender === null) {
      if (!line) continue;
      cur.sender = line;
      continue;
    }
    if (cur.inTapbacks) continue; // reactions until the next header
    if (line === "Tapbacks:") {
      cur.inTapbacks = true;
      continue;
    }
    if (line === REPLY_TRAILER) continue;
    if (line === DELETED) {
      cur.skip = true;
      continue;
    }
    if (ATTACHMENT_PATH_RE.test(line)) continue;
    cur.lines.push(line);
  }
  flush();
  messages.sort((x, y) => x.at.localeCompare(y.at));

  const participants: ChatParticipant[] = [...counts.keys()].map((key) => ({
    key,
    displayName: key,
    phoneE164: normalizePhoneLoose(key),
    email: EMAIL_RE.test(key) ? key.toLowerCase() : null,
    isSelf: key === "Me",
  }));
  const title = fileName.replace(/^.*[\\/]/, "").replace(/\.txt$/i, "");
  const handlesInName = title.split(",").map((s) => s.trim()).filter(Boolean);
  const others = participants.filter((p) => !p.isSelf);
  return {
    source: "imessage",
    fileName,
    title,
    isGroup: handlesInName.length > 1 || others.length > 1,
    participants,
    messages,
    dateOrderGuessed: false,
    skippedLines,
  };
}
