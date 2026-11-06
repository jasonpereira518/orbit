/**
 * Deepgram tells us THAT two people spoke. It cannot tell us which one is the user, and for a
 * networking CRM that is the label that matters: what you promised versus what they said.
 *
 * The recorder already meters the microphone and the call audio separately, before they are
 * mixed. So we keep that as a timeline and ask, for each of Deepgram's speakers, how much of
 * their speech landed while the microphone was the loud one. One speaker crossing the
 * threshold is "you"; everyone else is numbered.
 *
 * With NO call audio at all (an in-person meeting, recorded on the laptop's own mic), every
 * voice comes in through the mic, so mic-versus-call says nothing. Then "you" is the voice that
 * is clearly the loudest at the mic — the one sitting at the laptop — and nobody when no voice
 * stands out (a phone in the middle of a table).
 *
 * LABELS ARE STABLE. Each Deepgram speaker gets `speaker-N` the first time they are heard, by
 * order of appearance, and keeps it: a label is never renumbered when "you" is decided, because
 * sentences already posted carry it. "You" is pinned once decided; `claimedYou` names the
 * stable label it replaced, so the server can relabel the sentences posted before it was
 * known. Display numbering (Speaker 1, 2, ... skipping you) is `speakerDisplayNames`'s job.
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
  /** Running sum of the mic level, with the same origin rule as `micCount`. */
  private micSum: number[] = [0];
  /** Whether the call side was ever audible: false means a mic-only, in-person recording. */
  private heardCall = false;
  /**
   * `micCount[i]` is how many of the samples before index `i` were mic-dominant, counted from
   * an arbitrary origin. Only DIFFERENCES are ever read, so dropping the head of both arrays
   * keeps every remaining value correct without a rescan. Length is always `at.length + 1`.
   */
  private micCount: number[] = [0];

  push(sample: LoudnessSample): void {
    const mic = sample.mic > SILENCE && sample.mic > sample.call ? 1 : 0;
    if (sample.call > SILENCE) this.heardCall = true;
    this.at.push(sample.atMs);
    this.micCount.push(this.micCount[this.micCount.length - 1] + mic);
    this.micSum.push(this.micSum[this.micSum.length - 1] + Math.max(0, sample.mic));
    if (this.at.length > MAX_SAMPLES) {
      this.at.splice(0, DROP_BATCH);
      this.micCount.splice(0, DROP_BATCH);
      this.micSum.splice(0, DROP_BATCH);
    }
  }

  /** False until the call side has been audible at least once. */
  callHeard(): boolean {
    return this.heardCall;
  }

  /** The mean mic level over a span. Null when nothing was recorded. */
  micLevel(startMs: number, endMs: number): number | null {
    const lo = lowerBound(this.at, startMs);
    const hi = upperBound(this.at, endMs);
    const total = hi - lo;
    if (total <= 0) return null;
    return (this.micSum[hi] - this.micSum[lo]) / total;
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

type SpeakerStat = { words: number; micWords: number; levelSum: number; levelWords: number };

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
  /** The speaker decided to be "you", pinned for the rest of this word array. */
  you: number | null;
  /** The numbering offset this tally was built with. */
  offset: number;
};

/** What `labelSpeakers` reads from the recorder's timeline. The last two are optional for old callers. */
export type SpeakerTimeline = {
  micDominantShare(startMs: number, endMs: number): number | null;
  micLevel?(startMs: number, endMs: number): number | null;
  callHeard?(): boolean;
};

/** In a mic-only recording, how much louder "you" must be than the next voice. */
const LOUDEST_MARGIN = 1.25;

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
  timeline: SpeakerTimeline,
  opts: {
    minWords?: number;
    threshold?: number;
    /**
     * Added to every number. A reconnect starts a new Deepgram connection, which numbers its
     * speakers from 0 again; offsetting by the speakers already heard keeps a new voice from
     * inheriting an old one's label. Splitting one person across two labels is the safe error;
     * merging two people under one label would put words in the wrong mouth.
     */
    offset?: number;
  } = {},
): Map<number, string> {
  const minWords = opts.minWords ?? 20;
  const threshold = opts.threshold ?? 0.7;
  const offset = opts.offset ?? 0;

  let tally = TALLIES.get(words);
  const resumable =
    tally !== undefined &&
    tally.timeline === timeline &&
    tally.offset === offset &&
    tally.processed <= words.length &&
    (tally.processed === 0 || words[tally.processed - 1] === tally.lastWord);
  if (!tally || !resumable) {
    tally = { timeline, processed: 0, lastWord: undefined, order: [], stats: new Map(), you: null, offset };
    TALLIES.set(words, tally);
  }

  for (let i = tally.processed; i < words.length; i++) {
    const w = words[i];
    if (w.speaker === null) continue;
    let stat = tally.stats.get(w.speaker);
    if (!stat) {
      stat = { words: 0, micWords: 0, levelSum: 0, levelWords: 0 };
      tally.stats.set(w.speaker, stat);
      tally.order.push(w.speaker);
    }
    stat.words++;
    const share = timeline.micDominantShare(w.start, w.end);
    if (share !== null && share >= 0.5) stat.micWords++;
    const level = timeline.micLevel?.(w.start, w.end) ?? null;
    if (level !== null) {
      stat.levelSum += level;
      stat.levelWords++;
    }
  }
  tally.processed = words.length;
  tally.lastWord = words.length ? words[words.length - 1] : undefined;

  // Pinned once decided: a speaker's sentences are already posted under their label, and the
  // server relabels them to "you" on the claim (`claimedYou`). Flip-flopping would need every
  // one of those rewrites undone.
  if (tally.you === null) tally.you = decideYou(tally.stats, timeline, minWords, threshold);

  const labels = new Map<number, string>();
  tally.order.forEach((speaker, i) => {
    labels.set(speaker, speaker === tally.you ? "you" : stableLabel(offset, i));
  });
  return labels;
}

function stableLabel(offset: number, index: number): string {
  return `speaker-${offset + index + 1}`;
}

function decideYou(
  stats: ReadonlyMap<number, SpeakerStat>,
  timeline: SpeakerTimeline,
  minWords: number,
  threshold: number,
): number | null {
  const qualified = [...stats].filter(([, stat]) => stat.words >= minWords);
  // Mic-only: everyone is "mic-dominant", so compare loudness at the mic instead, and only
  // claim a voice that is clearly the loudest. Two voices are needed to compare at all.
  if (timeline.callHeard?.() === false) {
    const levels = qualified
      .filter(([, stat]) => stat.levelWords > 0)
      .map(([speaker, stat]) => [speaker, stat.levelSum / stat.levelWords] as const)
      .sort((a, b) => b[1] - a[1]);
    if (levels.length < 2) return null;
    return levels[0][1] >= levels[1][1] * LOUDEST_MARGIN ? levels[0][0] : null;
  }
  let you: number | null = null;
  let best = 0;
  for (const [speaker, stat] of qualified) {
    const share = stat.micWords / stat.words;
    if (share >= threshold && share > best) { you = speaker; best = share; }
  }
  return you;
}

/**
 * The stable label "you" replaced in this word array — what the server rewrites to "you" in
 * the sentences already posted — or null while nobody is "you". Reads the tally
 * `labelSpeakers` left, so call it after that.
 */
export function claimedYou(words: readonly LiveWord[]): string | null {
  const tally = TALLIES.get(words);
  if (!tally || tally.you === null) return null;
  const index = tally.order.indexOf(tally.you);
  return index < 0 ? null : stableLabel(tally.offset, index);
}
