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

/**
 * The shape of the cost, not just the answers.
 *
 * `labelSpeakers` runs synchronously inside the live socket's `onmessage`, on the thread that
 * also downsamples audio and posts batches, and the hook re-labels the WHOLE word list every
 * ten seconds. The first version rescanned the sample array from index 0 for every word, so
 * one pass cost 85 ms at 30 minutes but 3.36 s at three hours — a tab that freezes for over a
 * second, every ten seconds, for the back half of a long meeting.
 *
 * This replays a three-hour meeting the way the hook drives it: samples pushed as captured,
 * a relabel every ten seconds over the one growing array. Quadratic behaviour blows the
 * budget by orders of magnitude (the old code needs minutes for the 1,080 passes below), so
 * the exact number matters far less than that it is a small constant.
 */
console.log("\ncost at three hours");
{
  const HOURS = 3;
  const TOTAL_MS = HOURS * 60 * 60_000;
  const SAMPLE_EVERY_MS = 32;
  const WORD_EVERY_MS = 400; // ~2.5 words/s, a brisk conversation
  const RELABEL_EVERY_MS = 10_000;
  const BUDGET_MS = 1_500;

  const timeline = new LoudnessTimeline();
  const words: { word: string; start: number; end: number; speaker: number | null }[] = [];
  let nextSample = 0;
  let nextWord = 0;
  let passes = 0;

  const started = Date.now();
  for (let now = 0; now <= TOTAL_MS; now += RELABEL_EVERY_MS) {
    for (; nextSample <= now; nextSample += SAMPLE_EVERY_MS) {
      // Two people taking turns a minute at a time, so both cross `minWords` and the mic
      // share is a real mix rather than a constant.
      const mine = Math.floor(nextSample / 60_000) % 2 === 0;
      timeline.push({ atMs: nextSample, mic: mine ? 0.6 : 0.01, call: mine ? 0.02 : 0.7 });
    }
    for (; nextWord <= now; nextWord += WORD_EVERY_MS) {
      words.push({ word: "w", start: nextWord, end: nextWord + 300, speaker: Math.floor(nextWord / 60_000) % 2 });
    }
    labelSpeakers(words, timeline);
    passes++;
  }
  const elapsed = Date.now() - started;

  check(`${passes} passes over ${words.length} words stay under ${BUDGET_MS}ms`, elapsed < BUDGET_MS, `took ${elapsed}ms`);
  check("…and the labels are still right", (() => {
    const map = labelSpeakers(words, timeline);
    return map.get(0) === "you" && map.get(1) === "speaker-1";
  })());

  // The direct canary: ONE pass over three hours of words, from a cold tally.
  const cold = words.map((w) => ({ ...w }));
  const onePassStarted = Date.now();
  labelSpeakers(cold, timeline);
  const onePass = Date.now() - onePassStarted;
  check(`one cold pass over ${cold.length} words stays under 250ms`, onePass < 250, `took ${onePass}ms`);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll speaker mapping checks passed");
process.exit(0);
