/**
 * How much of Cosmo's line the captions show right now. Providers give the whole text of a line,
 * not word timings, so words are revealed in step with how much of its audio has played.
 * Client-safe and pure (scripts/smoke-caption-pace.ts).
 */

/**
 * A turn as words, without the markdown a model sometimes writes despite the prompt: links keep
 * their text, and emphasis, code ticks, headings and list markers go. Display only; the prompt
 * is what keeps the symbols out of the speech itself.
 */
export function plainSpeech(text: string) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|\*|`)/g, "");
}

/** Seconds of the line's audio played so far and queued so far; `complete` once all of it has arrived. */
export type Playback = { played: number; queued: number; complete: boolean };

/** A typical speaking rate, used while the line's audio is still arriving and its length is unknown. */
export const SPEECH_WORDS_PER_SEC = 2.7;

const split = (text: string) => text.trim().split(/\s+/).filter(Boolean);

export function captionWordCount(text: string, { played, queued, complete }: Playback): number {
  const words = split(text);
  if (words.length === 0 || played <= 0) return 0;
  // Until all the audio is in, the bytes so far undercount the line: assume a speaking rate, so
  // the captions never run ahead of the voice.
  const duration = complete ? queued : Math.max(queued, words.length / SPEECH_WORDS_PER_SEC);
  if (duration <= 0) return words.length;
  return Math.min(words.length, Math.ceil((words.length * played) / duration));
}

/** The first `count` words, keeping only the last `max` of them so the newest are on screen. */
export function captionTail(text: string, count: number, max = 18): string {
  const shown = split(text).slice(0, count);
  if (shown.length === 0) return "";
  return shown.length > max ? `… ${shown.slice(-max).join(" ")}` : shown.join(" ");
}
