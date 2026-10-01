/**
 * Chat export parsers. Fixtures are written inline in the shapes the apps produce.
 * Run: npx tsx scripts/smoke-chat-parsers.ts
 */
import "./smoke/_env";
import { parseWhatsAppExport } from "../src/lib/conversations/whatsapp";
import { parseIMessageExport } from "../src/lib/conversations/imessage";
import { fnv1a64 } from "../src/lib/conversations/hash";
import { normalizePhoneLoose } from "../src/lib/conversations/phone";
import { normalizePhone } from "../src/lib/duplicates";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

check("hash: stable", fnv1a64("abc") === fnv1a64("abc") && fnv1a64("abc") !== fnv1a64("abd"));
check("hash: 16 hex chars", /^[0-9a-f]{16}$/.test(fnv1a64("x")));
for (const p of ["+1 (415) 555-0134", "415-555-0134", "14155550134", "+44 20 7946 0958", "12345", "Maya"]) {
  check(`phone twin agrees: ${p}`, (normalizePhoneLoose(p) ?? "") === normalizePhone(p), `${normalizePhoneLoose(p)} vs ${normalizePhone(p)}`);
}

// iOS, day-first (13 proves it), seconds, LRM marks, multi-line, media + system lines.
const ios = [
  "[13/03/2024, 09:15:02] Messages and calls are end-to-end encrypted. No one outside of this chat can read them.",
  "[13/03/2024, 09:15:02] Maya Chen: Hey! Are you free next Tuesday?",
  "[13/03/2024, 09:16:40] Jason Pereira: Yes — lunch at 1?",
  "Also bring the deck",
  "[13/03/2024, 09:17:05] Maya Chen: ‎image omitted",
  "[13/03/2024, 09:18:00] Maya Chen: This message was deleted",
  "[14/03/2024, 18:00:00] Maya Chen: Perfect, see you then",
].join("\n");
const a = parseWhatsAppExport(ios, "WhatsApp Chat with Maya Chen.txt", { localeDayFirst: false });
check("ios: title from file name", a.title === "Maya Chen");
check("ios: 1:1", a.isGroup === false && a.participants.length === 2);
check("ios: system + media + deleted dropped", a.messages.length === 3, JSON.stringify(a.messages.map((m) => m.text)));
check("ios: continuation joined", a.messages[1].text === "Yes — lunch at 1?\nAlso bring the deck");
check("ios: day-first proven", a.dateOrderGuessed === false && new Date(a.messages[0].at).getDate() === 13);

// Android, 12-hour with narrow no-break space, month-first (second field 13 proves it).
const android = [
  "3/13/24, 2:05 PM - Diego: Can you intro me to Priya?",
  "3/13/24, 2:07 PM - You: Sure, Friday",
  "3/14/24, 9:00 AM - Diego: Thanks!",
].join("\n");
const b = parseWhatsAppExport(android, "WhatsApp Chat with Diego.txt");
check("android: 3 messages", b.messages.length === 3);
check("android: month-first proven", new Date(b.messages[0].at).getDate() === 13);
check("android: PM to 24h", new Date(b.messages[0].at).getHours() === 14);
check("android: 'You' is self", b.participants.find((p) => p.key === "You")?.isSelf === true);

// Ambiguous dates (all fields <= 12) -> locale decides, flagged.
const amb = "01/02/2024, 10:00 - Sam: hi there\n01/02/2024, 10:01 - Ana: hello";
const c1 = parseWhatsAppExport(amb, "chat.txt", { localeDayFirst: true });
const c2 = parseWhatsAppExport(amb, "chat.txt", { localeDayFirst: false });
check("ambiguous: flagged", c1.dateOrderGuessed && c2.dateOrderGuessed);
check("ambiguous: day-first -> 1 Feb", new Date(c1.messages[0].at).getMonth() === 1);
check("ambiguous: month-first -> 2 Jan", new Date(c2.messages[0].at).getMonth() === 0);

// Group: > 2 distinct senders; raw phone sender becomes phoneE164; "added" notice dropped.
const group = [
  "13/03/2024, 10:00 - Ana: Welcome everyone",
  "13/03/2024, 10:01 - +1 (415) 555-0134: Hi all",
  "13/03/2024, 10:02 - Ben: hey",
  "13/03/2024, 10:03 - Ana added Carla",
].join("\n");
const g = parseWhatsAppExport(group, "WhatsApp Chat with Founders Club.txt");
check("group: detected", g.isGroup === true && g.title === "Founders Club");
check("group: phone sender normalized", g.participants.some((p) => p.phoneE164 === "+14155550134"));
check("group: 'added' notice dropped", g.messages.length === 3);

const junk = parseWhatsAppExport("hello world\nnot a chat", "notes.txt");
check("junk: empty, not thrown", junk.messages.length === 0);

// ---- iMessage (imessage-exporter --format txt, layout verified against the project source) ----
// Real layout: "<date>[ (Read by you after N)]", sender, body; tapbacks are a nested "Tapbacks:" block
// of indented "<Kind> by <who>" lines; a reply parent ends with "This message responded to an earlier
// message."; attachments are bare file paths; announcements are one line "<date> <who> <action>.".
const im = [
  "Mar 05, 2024  2:03:45 PM",
  "+14155550134",
  "Are we still on for Thursday?",
  "",
  "Mar 05, 2024  2:05:01 PM (Read by them after 2 minutes)",
  "Me",
  "Yes! 6pm at Tartine",
  "",
  "Can't wait",
  "Tapbacks:",
  "    Loved by +14155550134",
  "",
  "",
  "Mar 06, 2024  9:00:00 AM",
  "+14155550134",
  "Loved \u201cYes! 6pm at Tartine\u201d",
  "",
  "Mar 06, 2024  9:01:00 AM",
  "+14155550134",
  "/Users/x/Library/Messages/Attachments/ab/IMG_0001.heic",
  "",
  "Mar 06, 2024  9:02:00 AM Me named the conversation Dinner",
  "",
  "Mar 06, 2024  9:03:00 AM",
  "Me",
  "Replying here",
  "This message responded to an earlier message.",
  "",
  "    Mar 06, 2024  9:04:00 AM",
  "    +14155550134",
  "    nested reply",
  "",
].join("\n");
const i1 = parseIMessageExport(im, "+14155550134.txt");
check("imessage: real messages only", i1.messages.length === 4, JSON.stringify(i1.messages));
check("imessage: multi-line body keeps blank, drops Tapbacks block", i1.messages[1].text === "Yes! 6pm at Tartine\n\nCan't wait", JSON.stringify(i1.messages[1]));
check("imessage: reply trailer stripped, nested reply kept", i1.messages[2].text === "Replying here" && i1.messages[3].text === "nested reply");
check("imessage: Me is self", i1.participants.find((p) => p.key === "Me")?.isSelf === true);
check("imessage: handle phone", i1.participants.find((p) => !p.isSelf)?.phoneE164 === "+14155550134");
check("imessage: title from file", i1.title === "+14155550134" && i1.isGroup === false);
check("imessage: PM", new Date(i1.messages[0].at).getHours() === 14);

// Legacy inline tapback lines are dropped too.
const legacy = parseIMessageExport("Mar 06, 2024  9:00:00 AM\n+14155550134\nLoved \u201chi\u201d\n", "x.txt");
check("imessage: inline tapback dropped", legacy.messages.length === 0);

// macOS 14+ puts U+202F before AM/PM.
const nnbsp = parseIMessageExport("Jan 02, 2025  10:00:00\u202fPM\nAna\nhi\n", "Ana.txt");
check("imessage: narrow nbsp before PM", new Date(nnbsp.messages[0]?.at).getHours() === 22);

const email = parseIMessageExport("Jan 02, 2025  10:00:00 AM\nana@example.com\nhi there\n", "ana@example.com.txt");
check("imessage: email handle", email.participants.find((p) => !p.isSelf)?.email === "ana@example.com");

const grp = parseIMessageExport(
  "Jan 02, 2025  10:00:00 AM\n+14155550134\nhey all\n\nJan 02, 2025  10:01:00 AM\n+14155550199\nhi\n",
  "+14155550134, +14155550199.txt"
);
check("imessage: group from file name", grp.isGroup === true);
check("imessage: junk is empty", parseIMessageExport("hello\nworld", "n.txt").messages.length === 0);

console.log("\nsmoke-chat-parsers: all checks passed");
process.exit(0);
