/**
 * WhatsApp "Export chat" text. Two families of line, each in 12/24-hour and locale variants:
 *   iOS:     [13/03/2024, 09:15:02] Maya Chen: text
 *   Android: 13/03/2024, 09:15 - Maya Chen: text
 * A line that does not start with a timestamp continues the previous message. Lines without
 * "Name: " after the timestamp are system notices and are dropped, as are media/deleted stubs.
 * Day/month order is decided per file: any first field > 12 -> day-first; any second field > 12
 * -> month-first; otherwise the caller's locale decides and the result is flagged.
 */
import { normalizePhoneLoose } from "@/lib/conversations/phone";
import type { ChatMessage, ChatParticipant, Conversation } from "@/lib/conversations/types";

export const WHATSAPP_LINE_RE =
  /^[\u200e\u200f]?\[?(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[\s\u202f\u00a0]*([AaPp])\.?\s?[Mm]\.?)?\]?\s*(?:-\s)?(.*)$/;
const SENDER_RE = /^([^:]{1,80}):\s([\s\S]*)$/;
const DROP_BODY_RE =
  /^[\u200e\u200f]?(?:<Media omitted>|<attached: .*>|(?:image|video|audio|sticker|GIF|document|Contact card) omitted|This message was deleted|You deleted this message|Missed (?:voice|video) call|null)$/i;
const MARKS_RE = /^[\u200e\u200f]+/;
const SELF_LABELS = new Set(["you", "me"]);
/**
 * System notices only a group has. Checked on notice lines (no "Name: "), except the ones
 * whose own text can carry a colon ("changed the subject to \"Re: x\""), which are spotted
 * before the sender split by their verb coming before the first colon.
 */
const GROUP_NOTICE_RE =
  /^[^:]{1,80}?\s(?:created group|added|removed|left|joined using this group[\u0027\u2019]s invite link|changed this group[\u0027\u2019]s|changed the group)\b/i;
const GROUP_COLON_NOTICE_RE = /^[^:]{1,80}?\s(?:created group|changed the subject|changed the group description)\b/i;

type Raw = { d1: number; d2: number; y: number; h: number; mi: number; s: number; ampm: string | null; rest: string };

function titleFromFileName(fileName: string): string | null {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.(txt|zip)$/i, "");
  const m = base.match(/^WhatsApp Chat (?:with|-)\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

function normTitle(v: string): string {
  return v.replace(/\s+/g, " ").trim().toLowerCase();
}

export function parseWhatsAppExport(
  text: string,
  fileName: string,
  opts: { localeDayFirst?: boolean } = {}
): Conversation {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const raws: Raw[] = [];
  let skippedLines = 0;
  for (const line of lines) {
    const m = line.match(WHATSAPP_LINE_RE);
    if (m) {
      raws.push({
        d1: Number(m[1]), d2: Number(m[2]), y: Number(m[3]), h: Number(m[4]), mi: Number(m[5]),
        s: m[6] ? Number(m[6]) : 0, ampm: m[7] ? m[7].toLowerCase() : null, rest: m[8] ?? "",
      });
    } else if (raws.length && line.trim()) {
      raws[raws.length - 1].rest += `\n${line}`;
    } else if (line.trim()) {
      skippedLines += 1;
    }
  }

  let dayFirst: boolean;
  let dateOrderGuessed = false;
  if (raws.some((r) => r.d1 > 12)) dayFirst = true;
  else if (raws.some((r) => r.d2 > 12)) dayFirst = false;
  else {
    dayFirst = opts.localeDayFirst ?? true;
    dateOrderGuessed = raws.length > 0;
  }

  const messages: ChatMessage[] = [];
  const counts = new Map<string, number>();
  let groupNotice = false;
  for (const r of raws) {
    const rest = r.rest.replace(MARKS_RE, "");
    if (GROUP_COLON_NOTICE_RE.test(rest)) {
      groupNotice = true;
      continue;
    }
    const sm = r.rest.match(SENDER_RE);
    if (!sm) {
      // System notice ("X added Y", encryption banner).
      if (GROUP_NOTICE_RE.test(rest)) groupNotice = true;
      continue;
    }
    const sender = sm[1].replace(MARKS_RE, "").trim();
    const body = sm[2].replace(MARKS_RE, "").trim();
    if (!body || DROP_BODY_RE.test(body)) continue;
    let hour = r.h;
    if (r.ampm === "p" && hour < 12) hour += 12;
    if (r.ampm === "a" && hour === 12) hour = 0;
    const year = r.y < 100 ? 2000 + r.y : r.y;
    const day = dayFirst ? r.d1 : r.d2;
    const month = dayFirst ? r.d2 : r.d1;
    const at = new Date(year, month - 1, day, hour, r.mi, r.s);
    if (Number.isNaN(at.getTime()) || at.getMonth() !== month - 1) {
      skippedLines += 1;
      continue;
    }
    messages.push({ senderKey: sender, at: at.toISOString(), text: body });
    counts.set(sender, (counts.get(sender) ?? 0) + 1);
  }

  const participants: ChatParticipant[] = [...counts.keys()].map((key) => ({
    key,
    displayName: key,
    phoneE164: normalizePhoneLoose(key),
    email: null,
    isSelf: SELF_LABELS.has(key.toLowerCase()),
  }));
  const others = participants.filter((p) => !p.isSelf);
  const fileTitle = titleFromFileName(fileName);
  return {
    source: "whatsapp",
    fileName,
    title: fileTitle ?? (others.length === 1 ? others[0].displayName : fileName.replace(/\.(txt|zip)$/i, "")),
    titleFromFile: fileTitle != null,
    // Two speakers can still be a group (the owner stayed silent): a group notice says so, and
    // so does a file title naming neither speaker, since a 1:1 is titled after the other one.
    isGroup:
      participants.length > 2 ||
      groupNotice ||
      (fileTitle != null &&
        participants.length === 2 &&
        !participants.some((p) => normTitle(p.displayName) === normTitle(fileTitle))),
    participants,
    messages,
    dateOrderGuessed,
    skippedLines,
  };
}
