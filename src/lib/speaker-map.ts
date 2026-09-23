/**
 * Deepgram tells us THAT two people spoke. It cannot tell us which one is the user, and for a
 * networking CRM that is the label that matters: what you promised versus what they said.
 *
 * The recorder already meters the microphone and the call audio separately, before they are
 * mixed. So we keep that as a timeline and ask, for each of Deepgram's speakers, how much of
 * their speech landed while the microphone was the loud one. One speaker crossing the
 * threshold is "you"; everyone else is numbered.
 */

export type LiveWord = { word: string; start: number; end: number; speaker: number | null };

export type LoudnessSample = { atMs: number; mic: number; call: number };

/** Below this, both sides are effectively silent and the comparison means nothing. */
const SILENCE = 0.02;
/** How long a meeting's samples are kept: three hours at ~32 ms. */
const MAX_SAMPLES = 340_000;

export class LoudnessTimeline {
  private samples: LoudnessSample[] = [];

  push(sample: LoudnessSample): void {
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** The share of samples in this span where the mic was louder. Null when nothing was recorded. */
  micDominantShare(startMs: number, endMs: number): number | null {
    let total = 0;
    let mic = 0;
    for (const s of this.samples) {
      if (s.atMs < startMs) continue;
      if (s.atMs > endMs) break;
      total++;
      if (s.mic > SILENCE && s.mic > s.call) mic++;
    }
    return total === 0 ? null : mic / total;
  }
}

export function labelSpeakers(
  words: readonly LiveWord[],
  timeline: { micDominantShare(startMs: number, endMs: number): number | null },
  opts: { minWords?: number; threshold?: number } = {},
): Map<number, string> {
  const minWords = opts.minWords ?? 20;
  const threshold = opts.threshold ?? 0.7;

  const order: number[] = [];
  const stats = new Map<number, { words: number; micWords: number }>();
  for (const w of words) {
    if (w.speaker === null) continue;
    if (!stats.has(w.speaker)) { stats.set(w.speaker, { words: 0, micWords: 0 }); order.push(w.speaker); }
    const stat = stats.get(w.speaker)!;
    stat.words++;
    const share = timeline.micDominantShare(w.start, w.end);
    if (share !== null && share >= 0.5) stat.micWords++;
  }

  let you: number | null = null;
  let best = 0;
  for (const [speaker, stat] of stats) {
    if (stat.words < minWords) continue;
    const share = stat.micWords / stat.words;
    if (share >= threshold && share > best) { you = speaker; best = share; }
  }

  const labels = new Map<number, string>();
  let n = 0;
  for (const speaker of order) {
    labels.set(speaker, speaker === you ? "you" : `speaker-${++n}`);
  }
  return labels;
}
