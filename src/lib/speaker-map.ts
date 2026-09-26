/**
 * Deepgram tells us THAT two people spoke. It cannot tell us which one is the user, and for a
 * networking CRM that is the label that matters: what you promised versus what they said.
 *
 * The recorder already meters the microphone and the call audio separately, before they are
 * mixed. So we keep that as a timeline and ask, for each of Deepgram's speakers, how much of
 * their speech landed while the microphone was the loud one. One speaker crossing the
 * threshold is "you"; everyone else is numbered.
 *
 * BOTH HALVES ARE INCREMENTAL, and that is not an optimisation — it is what keeps a long
 * meeting usable. All of this runs synchronously inside the live socket's `onmessage`, on the
 * thread that also downsamples audio and posts batches, and `labelSpeakers` is re-run over the
 * whole word list every ten seconds. The first version rescanned the sample array from index 0
 * for every word: 85 ms at 30 minutes, but 3.36 s at three hours, i.e. a frozen tab every ten
 * seconds. So:
 *
 *   - `LoudnessTimeline` keeps a running count of mic-dominant samples, and answers a span by
 *     binary-searching its (monotonic) times — O(log n), whatever the span covers.
 *   - `labelSpeakers` remembers, per word array, how far it already folded, and scores only
 *     the words added since. A pass costs time proportional to the NEW words.
 */

export type LiveWord = { word: string; start: number; end: number; speaker: number | null };

export type LoudnessSample = { atMs: number; mic: number; call: number };

/** Below this, both sides are effectively silent and the comparison means nothing. */
const SILENCE = 0.02;
/** How long a meeting's samples are kept: three hours at ~32 ms. */
const MAX_SAMPLES = 340_000;
/**
 * How many of the oldest samples go at once once the cap is reached. Dropping one per push
 * (`Array.shift()`) is O(n) per sample — 340k elements copied thirty times a second — so the
 * cost is paid in rare batches instead, which is O(1) amortised per sample.
 */
const DROP_BATCH = 16_384;

export class LoudnessTimeline {
  /** Sample times, in push order, which the recorder guarantees is non-decreasing. */
  private at: number[] = [];
  /**
   * `micCount[i]` is how many of the samples before index `i` were mic-dominant, counted from
   * an arbitrary origin. Only DIFFERENCES are ever read, so dropping the head of both arrays
   * keeps every remaining value correct without a rescan. Length is always `at.length + 1`.
   */
  private micCount: number[] = [0];

  push(sample: LoudnessSample): void {
    const mic = sample.mic > SILENCE && sample.mic > sample.call ? 1 : 0;
    this.at.push(sample.atMs);
    this.micCount.push(this.micCount[this.micCount.length - 1] + mic);
    if (this.at.length > MAX_SAMPLES) {
      this.at.splice(0, DROP_BATCH);
      this.micCount.splice(0, DROP_BATCH);
    }
  }

  /** The share of samples in this span where the mic was louder. Null when nothing was recorded. */
  micDominantShare(startMs: number, endMs: number): number | null {
    // `[lo, hi)` is exactly the old linear scan's window: skip everything before `startMs`,
    // stop at the first sample past `endMs`. Both ends inclusive, as before.
    const lo = lowerBound(this.at, startMs);
    const hi = upperBound(this.at, endMs);
    const total = hi - lo;
    if (total <= 0) return null;
    return (this.micCount[hi] - this.micCount[lo]) / total;
  }
}

/** First index whose value is >= `value`, in a non-decreasing array. */
function lowerBound(values: readonly number[], value: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is > `value`, in a non-decreasing array. */
function upperBound(values: readonly number[], value: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type SpeakerStat = { words: number; micWords: number };

type Tally = {
  /** The timeline these counts were measured against; a different one invalidates them. */
  timeline: object;
  /** How many entries of the word array are already folded in. */
  processed: number;
  /** The last word folded in, so a rewritten prefix is caught rather than trusted. */
  lastWord: LiveWord | undefined;
  /** Speakers in order of first appearance — what the numbering follows. */
  order: number[];
  stats: Map<number, SpeakerStat>;
};

/**
 * Per word array, how far it has been folded. Keyed by the array itself and held weakly, so a
 * meeting that ends (or a reconnect, which replaces the array) takes its tally with it.
 *
 * The live hook appends to one array and calls this repeatedly, so resuming is the normal
 * case. Resuming is only safe while the array has grown by appending — a caller that rewrote
 * or truncated the prefix would get counts for words that are no longer there — so the length
 * and the identity of the last folded word are both checked, and anything unexpected falls
 * back to a full recount.
 *
 * A word is scored against the timeline once, when it is first folded, rather than re-scored
 * on every pass. That is not a compromise: the recorder meters loudness as the audio is
 * captured, and Deepgram returns a word a second or so after it was spoken, so the samples
 * covering a word's span are always already there. A timeline handed in fresh (a different
 * object) invalidates the tally anyway.
 */
const TALLIES = new WeakMap<readonly LiveWord[], Tally>();

export function labelSpeakers(
  words: readonly LiveWord[],
  timeline: { micDominantShare(startMs: number, endMs: number): number | null },
  opts: { minWords?: number; threshold?: number } = {},
): Map<number, string> {
  const minWords = opts.minWords ?? 20;
  const threshold = opts.threshold ?? 0.7;

  let tally = TALLIES.get(words);
  const resumable =
    tally !== undefined &&
    tally.timeline === timeline &&
    tally.processed <= words.length &&
    (tally.processed === 0 || words[tally.processed - 1] === tally.lastWord);
  if (!tally || !resumable) {
    tally = { timeline, processed: 0, lastWord: undefined, order: [], stats: new Map() };
    TALLIES.set(words, tally);
  }

  for (let i = tally.processed; i < words.length; i++) {
    const w = words[i];
    if (w.speaker === null) continue;
    let stat = tally.stats.get(w.speaker);
    if (!stat) {
      stat = { words: 0, micWords: 0 };
      tally.stats.set(w.speaker, stat);
      tally.order.push(w.speaker);
    }
    stat.words++;
    const share = timeline.micDominantShare(w.start, w.end);
    if (share !== null && share >= 0.5) stat.micWords++;
  }
  tally.processed = words.length;
  tally.lastWord = words.length ? words[words.length - 1] : undefined;

  // Decided fresh every call, not accumulated: `minWords`/`threshold` are the caller's and a
  // speaker who was too quiet to claim ten seconds ago may qualify now.
  let you: number | null = null;
  let best = 0;
  for (const [speaker, stat] of tally.stats) {
    if (stat.words < minWords) continue;
    const share = stat.micWords / stat.words;
    if (share >= threshold && share > best) { you = speaker; best = share; }
  }

  const labels = new Map<number, string>();
  let n = 0;
  for (const speaker of tally.order) {
    labels.set(speaker, speaker === you ? "you" : `speaker-${++n}`);
  }
  return labels;
}
