/**
 * Session splitting: gap > 6h, 200 messages or 12k chars; transcript line format; the last
 * message decides direction; keys are stable across re-exports.
 * Run: npx tsx scripts/smoke-chat-sessions.ts
 */
import "./smoke/_env";
import { conversationKey, groupHeader, sessionExternalId, splitSessions } from "../src/lib/conversations/sessions";
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

console.log("\nsmoke-chat-sessions: all checks passed");
