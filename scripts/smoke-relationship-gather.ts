/**
 * The window builder: oldest-first lines, a 20k-character chunk, backlog truncation to the
 * newest 3 chunks' worth, and the watermark target being the window's last message.
 *
 * Run: npx tsx scripts/smoke-relationship-gather.ts
 */
import "./smoke/_env";
import { MAX_CHUNKS, WINDOW_CHARS, buildWindow, formatMessageLine, speakerFor } from "../src/lib/relationship-engine/gather";
import type { WindowMessage } from "../src/lib/relationship-engine/types";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function msg(i: number, text: string, dayOffset = i): WindowMessage {
  return {
    interactionId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    at: new Date(Date.UTC(2026, 0, 1 + dayOffset)),
    direction: i % 2 ? "out" : "in",
    speaker: i % 2 ? "Me" : "Maya",
    text,
  };
}

check("speaker: out → Me", speakerFor("out", "Maya Chen") === "Me");
check("speaker: in → first name", speakerFor("in", "Maya Chen") === "Maya");
check("speaker: null → ?", speakerFor(null, "Maya Chen") === "?");
check("speaker: chat session → Chat", speakerFor("out", "Maya Chen", "message") === "Chat" && speakerFor(null, "Maya Chen", "message") === "Chat");
check("speaker: linkedin_message unchanged", speakerFor("in", "Maya Chen", "linkedin_message") === "Maya");
check("line format", formatMessageLine(msg(0, "hi  there\nsecond line")) === "[2026-01-01 Maya] hi there second line");

check("empty rows → null", buildWindow("c1", [], ["linkedin"]) === null);

const small = buildWindow("c1", [msg(0, "one"), msg(1, "two")], ["linkedin"])!;
check("small: all messages", small.messages.length === 2);
check("small: last is newest", small.last.interactionId === msg(1, "").interactionId);
check("small: not truncated", small.truncatedBefore === null);
check("small: text lines", small.text === "[2026-01-01 Maya] one\n[2026-01-02 Me] two");

// 10 messages of ~9k chars: 90k total > 3 × 20k, so the oldest are dropped.
const big = Array.from({ length: 10 }, (_, i) => msg(i, "x".repeat(9_000)));
const w = buildWindow("c1", big, ["linkedin"])!;
check("big: window within WINDOW_CHARS", w.text.length <= WINDOW_CHARS, String(w.text.length));
check("big: truncated", w.truncatedBefore !== null);
const keptFrom = big.findIndex((m) => m.interactionId === w.messages[0].interactionId);
const keptChars = big.slice(keptFrom).reduce((n, m) => n + formatMessageLine(m).length + 1, 0);
check("big: kept backlog fits MAX_CHUNKS", keptChars <= MAX_CHUNKS * WINDOW_CHARS, String(keptChars));
check("big: truncatedBefore = first kept message", w.truncatedBefore!.getTime() === big[keptFrom].at.getTime());
check("big: window starts at oldest kept", w.messages[0].interactionId === big[keptFrom].interactionId);

// A single message longer than a window is clipped, never dropped (the watermark must move).
const huge = buildWindow("c1", [msg(0, "y".repeat(50_000))], ["linkedin"])!;
check("huge single message: one message, clipped", huge.messages.length === 1 && huge.text.length <= WINDOW_CHARS);

console.log("\nsmoke-relationship-gather: all checks passed");
