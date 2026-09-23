/**
 * "You" is decided locally: Deepgram says WHICH speaker, the mic says WHO.
 * Run: npx tsx scripts/smoke-speaker-map.ts
 */
import { LoudnessTimeline, labelSpeakers } from "../src/lib/speaker-map";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

function word(w: string, start: number, speaker: number | null) {
  return { word: w, start, end: start + 300, speaker };
}

console.log("\nLoudnessTimeline");
{
  const t = new LoudnessTimeline();
  for (let ms = 0; ms < 2_000; ms += 32) t.push({ atMs: ms, mic: 0.6, call: 0.05 });
  for (let ms = 2_000; ms < 4_000; ms += 32) t.push({ atMs: ms, mic: 0.03, call: 0.7 });
  check("mic-dominant stretch reads as 1", t.micDominantShare(0, 1_900) === 1);
  check("call-dominant stretch reads as 0", t.micDominantShare(2_100, 3_900) === 0);
  check("a half-and-half span is in between", Math.abs((t.micDominantShare(0, 4_000) ?? 0) - 0.5) < 0.1);
  check("a span with no samples is unknown", t.micDominantShare(60_000, 61_000) === null);
  check("silence on both sides is not mic-dominant", (() => {
    const q = new LoudnessTimeline();
    for (let ms = 0; ms < 1_000; ms += 32) q.push({ atMs: ms, mic: 0.001, call: 0.001 });
    return q.micDominantShare(0, 900) === 0;
  })());
}

console.log("\nlabelSpeakers");
{
  const mine = { micDominantShare: () => 1 };
  const theirs = { micDominantShare: () => 0 };
  const words = Array.from({ length: 25 }, (_, i) => word("hello", i * 400, 0));
  check("a consistently mic-dominant speaker is you", labelSpeakers(words, mine).get(0) === "you");
  check("a call-dominant speaker is numbered", labelSpeakers(words, theirs).get(0) === "speaker-1");
  check("too few words means no claim", labelSpeakers(words.slice(0, 5), mine).get(0) === "speaker-1");

  const mixed = [...Array.from({ length: 25 }, (_, i) => word("a", i * 400, 0)), ...Array.from({ length: 25 }, (_, i) => word("b", 10_000 + i * 400, 1))];
  const map = labelSpeakers(mixed, { micDominantShare: (start) => (start < 10_000 ? 1 : 0) });
  check("only one speaker becomes you", [...map.values()].filter((v) => v === "you").length === 1);
  check("the other keeps a number", map.get(1) === "speaker-1");
  check("numbering follows order of appearance", labelSpeakers(mixed, theirs).get(0) === "speaker-1" && labelSpeakers(mixed, theirs).get(1) === "speaker-2");
  check("unknown loudness never claims you", labelSpeakers(words, { micDominantShare: () => null }).get(0) === "speaker-1");
  check("words with no speaker are ignored", labelSpeakers([word("x", 0, null)], mine).size === 0);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll speaker mapping checks passed");
process.exit(0);
