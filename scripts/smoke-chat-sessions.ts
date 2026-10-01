/**
 * Session splitting: gap > 6h, 200 messages or 12k chars; transcript line format; the last
 * message decides direction; keys are stable across re-exports.
 * Run: npx tsx scripts/smoke-chat-sessions.ts
 */
import "./smoke/_env";
import { conversationKey, groupHeader, sessionExternalId, splitSessions } from "../src/lib/conversations/sessions";
import { clampCodePoints } from "../src/lib/conversations/clamp";
import { attributionLine, conversationToRows } from "../src/lib/conversations/to-rows";
import type { Conversation } from "../src/lib/conversations/types";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const t0 = new Date(2024, 2, 13, 9, 0, 0).getTime();
const at = (mins: number) => new Date(t0 + mins * 60_000).toISOString();
function conv(msgs: Array<[number, string, string]>, extra: Partial<Conversation> = {}): Conversation {
  return {
    source: "whatsapp", fileName: "x.txt", title: "Maya", isGroup: false,
    participants: [
      { key: "Maya", displayName: "Maya", phoneE164: null, email: null, isSelf: false },
      { key: "You", displayName: "You", phoneE164: null, email: null, isSelf: true },
    ],
    messages: msgs.map(([m, s, t]) => ({ senderKey: s, at: at(m), text: t })),
    dateOrderGuessed: false, skippedLines: 0, ...extra,
  };
}

const c = conv([[0, "Maya", "hi"], [5, "You", "hey"], [5 + 6 * 60, "Maya", "exactly 6h later"], [5 + 12 * 60 + 1, "Maya", "6h01 later"]]);
const s = splitSessions(c, "You");
check("gap: 6h exactly stays together, > 6h splits", s.length === 2, JSON.stringify(s.map((x) => x.messageCount)));
check("session 1 direction from last message", s[0].direction === "in");
check("transcript line format", s[0].transcript.split("\n")[0] === "[2024-03-13 09:00 Maya] hi", s[0].transcript);
check("self label rendered as Me", s[0].transcript.includes(" Me] hey"));
check("start/end", s[0].startAt === at(0) && s[0].endAt === at(5 + 6 * 60));
check("unknown owner → null direction", splitSessions(c, null)[0].direction === null);

const many = conv(Array.from({ length: 450 }, (_, i) => [i, "Maya", `m${i}`] as [number, string, string]));
const sm = splitSessions(many, "You");
check("200-message cap", sm.length === 3 && sm[0].messageCount === 200 && sm[2].messageCount === 50);

const long = conv(Array.from({ length: 30 }, (_, i) => [i, "Maya", "y".repeat(1_000)] as [number, string, string]));
check("12k-char cap", splitSessions(long, "You").every((x) => x.transcript.length <= 12_000));

check("key stable across content", conversationKey(c) === conversationKey(conv([[0, "Maya", "different text"]])));
check("key differs by title", conversationKey(c) !== conversationKey({ ...c, title: "Other" }));
check(
  "external id format",
  sessionExternalId("whatsapp", "abc", at(0), "11111111-1111-4111-8111-111111111111") ===
    `chat:whatsapp:abc:${Math.floor(t0 / 1000)}:11111111-1111-4111-8111-111111111111`
);
const g = conv([[0, "Ana", "hi"]], {
  isGroup: true, title: "Founders",
  participants: [
    { key: "Ana", displayName: "Ana", phoneE164: null, email: null, isSelf: false },
    { key: "Ben", displayName: "Ben", phoneE164: null, email: null, isSelf: false },
    { key: "You", displayName: "You", phoneE164: null, email: null, isSelf: true },
  ],
});
check("group header", groupHeader(g) === '# Group chat "Founders" with Ana, Ben');

// The owner chosen in the UI is a real name the parser could not mark as self.
const named = conv([[0, "Ana", "hi"], [1, "Jason P", "hello all"]], {
  isGroup: true, title: "Founders Club",
  participants: [
    { key: "Ana", displayName: "Ana", phoneE164: null, email: null, isSelf: false },
    { key: "Ben", displayName: "Ben", phoneE164: null, email: null, isSelf: false },
    { key: "Jason P", displayName: "Jason P", phoneE164: null, email: null, isSelf: false },
  ],
});
const namedRows = conversationToRows(named, "Jason P", { Ana: { contactId: null, create: true } });
const namedTranscript = namedRows[0]?.sessions[0]?.transcript ?? "";
check("toRows: only the linked member gets a row", namedRows.length === 1 && namedRows[0].participant.key === "Ana");
check(
  "toRows: group header leaves out the chosen owner",
  namedTranscript.split("\n")[0] === '# Group chat "Founders Club" with Ana, Ben',
  namedTranscript,
);
check("toRows: the chosen owner speaks as Me", namedTranscript.includes(" Me] hello all") && !namedTranscript.includes("Jason P]"), namedTranscript);
check("toRows: the parsed conversation is not mutated", named.participants.every((p) => !p.isSelf));

// ── Code-point-safe caps (I-2) ─────────────────────────────────────────────────────────
const hasLoneSurrogate = (t: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t);
check("clamp: short strings untouched", clampCodePoints("abc", 5) === "abc");
check("clamp: a cut inside an emoji drops its high half", clampCodePoints("ab\u{1F600}", 3) === "ab");
check("clamp: a cut after an emoji keeps it", clampCodePoints("ab\u{1F600}c", 4) === "ab\u{1F600}");
// An over-long single message whose cap lands inside an emoji.
const emojiLine = conv([[0, "Mia", "\u{1F600}".repeat(7_000)]]);
const emojiSessions = splitSessions(emojiLine, "You");
check(
  "sessions: an over-long line is never cut inside an emoji",
  emojiSessions.every((x) => !hasLoneSurrogate(x.transcript) && x.transcript.length <= 12_000),
);
// A group whose session sits right at the cap: header + attribution + transcript fits with no cut.
const tight = conv(
  Array.from({ length: 30 }, (_, i) => [i, i % 2 ? "Ana" : "Ben", `${"\u{1F600}".repeat(150)}${"z".repeat(99 + (i % 3))}`] as [number, string, string]),
  {
    isGroup: true, title: "Emoji \u{1F389} club",
    participants: [
      { key: "Ana", displayName: "Ana \u{1F33B}", phoneE164: null, email: null, isSelf: false },
      { key: "Ben", displayName: "Ben", phoneE164: null, email: null, isSelf: false },
      { key: "You", displayName: "You", phoneE164: null, email: null, isSelf: true },
    ],
  },
);
const tightRows = conversationToRows(tight, "You", { Ana: { contactId: null, create: true }, Ben: { contactId: null, create: true } });
const plainSessions = splitSessions(tight, "You");
check("toRows: every transcript within 12,000", tightRows.every((r) => r.sessions.every((x) => x.transcript.length <= 12_000)));
check("toRows: no lone surrogate anywhere", tightRows.every((r) => !hasLoneSurrogate(JSON.stringify(r))));
check(
  "toRows: no message is cut — every transcript ends on a whole line",
  tightRows.every((r) => r.sessions.every((x) => /z{99,101}$/.test(x.transcript))),
);
check("toRows: the split left room (more sessions than a header-less split)", tightRows[0].sessions.length >= plainSessions.length);

// ── Attribution line (I-5) ─────────────────────────────────────────────────────────────
const anaRow = tightRows.find((r) => r.participant.key === "Ana")!;
const benRow = tightRows.find((r) => r.participant.key === "Ben")!;
check(
  "attribution: the second line names the row's own sender",
  anaRow.sessions.every((x) => x.transcript.split("\n")[1] === attributionLine("Ana \u{1F33B}")) &&
    benRow.sessions.every((x) => x.transcript.split("\n")[1] === '# This contact appears as "Ben"'),
  anaRow.sessions[0].transcript.slice(0, 200),
);
const oneToOne = conversationToRows(c, "You", {});
check("attribution: a 1:1 has no header lines", oneToOne[0].sessions.every((x) => x.transcript.startsWith("[")));

// ── Large chats split into several rows (I-1) ──────────────────────────────────────────
const daily = conv(Array.from({ length: 120 }, (_, i) => [i * 24 * 60, "Maya", `day ${i}`] as [number, string, string]));
const dailyRows = conversationToRows(daily, "You", {});
check("rows: 120 sessions → 3 rows of ≤ 50", dailyRows.length === 3 && dailyRows.every((r) => r.sessions.length <= 50), dailyRows.map((r) => r.sessions.length).join(","));
check(
  "rows: one participant's rows share key, participant and decision",
  dailyRows.every((r) => r.conversationKey === dailyRows[0].conversationKey && r.participant.key === "Maya" && r.createIfUnmatched && r.resolvedContactId === null),
);
check("rows: sessions in order, none lost", dailyRows.flatMap((r) => r.sessions).map((x) => x.startAt).join() === splitSessions(daily, "You").map((x) => x.startAt).join());
// ~2.5 MB of transcript for one participant: 250 sessions of ~10k chars, under 50 per row by count.
const heavy = conv(Array.from({ length: 250 }, (_, i) => [i * 24 * 60, "Maya", "w".repeat(10_000)] as [number, string, string]));
const heavyRows = conversationToRows(heavy, "You", {});
const heavyTotal = heavyRows.reduce((n, r) => n + JSON.stringify(r).length, 0);
check("rows: a 2.5 MB participant splits into ≥ 3 rows", heavyTotal > 2_500_000 && heavyRows.length >= 3, `${heavyRows.length} rows, ${heavyTotal} chars`);
check("rows: each row ≤ 1,000,000 chars of JSON", heavyRows.every((r) => JSON.stringify(r).length <= 1_000_000), heavyRows.map((r) => JSON.stringify(r).length).join(","));

console.log("\nsmoke-chat-sessions: all checks passed");
