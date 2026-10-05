/**
 * The rules for revealing streamed text smoothly, kept apart from React and timers so they can
 * be tested exactly.
 *
 * A model's answer reaches the browser in network-sized lumps, so the raw stream reads as
 * bursts: nothing, then a sentence, then nothing. Easing the reveal makes it read as typing —
 * but only if two things hold, and both are rules rather than feel:
 *
 *   - It must never fall far behind. A reveal that lags the stream by seconds is worse than
 *     bursts, so the rate rises with the backlog and the backlog is capped outright.
 *   - It must never cut a token in half. A citation marker (`[e7]`, coming with source chips)
 *     that flashes as a raw `[e` for a frame reads as a bug, and so does half an emoji.
 */

/** How quickly a backlog is worked off; a smaller value is snappier. */
export const DRAIN_TAU_MS = 120;

/** Never trail the stream by more than this many characters, whatever the rate says. */
export const MAX_BACKLOG_CHARS = 240;

/**
 * How many characters to reveal this frame.
 *
 * Exponential catch-up: each frame reveals the fraction of the backlog that `dtMs` covers at a
 * time constant of `DRAIN_TAU_MS`. A small backlog therefore trickles out a character or two per
 * frame (typing), a large one drains fast, and there is always at least one character while
 * anything is waiting so the reveal can never stall.
 */
export function drainCount(backlog: number, dtMs: number): number {
  if (backlog <= 0) return 0;
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 16;
  const eased = Math.ceil(backlog * (1 - Math.exp(-dt / DRAIN_TAU_MS)));
  // The hard cap: whatever the easing says, do not leave more than MAX_BACKLOG_CHARS waiting.
  const mustRelease = Math.max(0, backlog - MAX_BACKLOG_CHARS);
  return Math.min(backlog, Math.max(1, eased, mustRelease));
}

/** A marker that has started at the very end of the text but not closed: "[", "[e", "[e12". */
const UNFINISHED_TAIL = /\[(?:e\d*)?$/;
const COMPLETE_MARKER = /\[e\d+\]/g;

/**
 * Where to end this frame's reveal, as an absolute index into `text`.
 *
 * `from` is what has been shown so far and `want` how many more characters the rate allows.
 * The cut is moved off anything that must not be split, in the direction that keeps the reveal
 * moving:
 *
 *   - A cut inside a marker (`[e7]`) or a surrogate pair that is COMPLETE in `text` moves
 *     FORWARD to its end, so it is shown whole. Going back instead would make no progress when
 *     the per-frame allowance is smaller than the token, and a reveal that cannot advance while
 *     text is waiting is a stall.
 *   - A marker that has started at the very END of `text` but not closed yet ("…[e1"), or a high
 *     surrogate whose partner has not arrived, moves BACK: the rest of it is not here yet, and
 *     showing half of it is the very thing this exists to avoid.
 *
 * The one case that returns `from` (reveal nothing this frame) is that unfinished tail. It is
 * only ever a pause: more text releases it, and the caller flushes everything when the stream
 * ends, so a marker that never closes is shown then rather than held forever.
 */
export function safeCut(text: string, from: number, want: number): number {
  let end = Math.min(text.length, from + Math.max(0, want));

  // Half an emoji: the unit before the cut is a high surrogate.
  const before = text.charCodeAt(end - 1);
  if (end > from && before >= 0xd800 && before <= 0xdbff) {
    end = end < text.length ? end + 1 : end - 1;
  }

  // Inside a marker that is complete in the text: reveal it whole.
  if (end > from && end < text.length) {
    const lo = Math.max(0, end - 12);
    const local = text.slice(lo, Math.min(text.length, end + 12));
    for (const m of local.matchAll(COMPLETE_MARKER)) {
      const start = lo + (m.index ?? 0);
      const stop = start + m[0].length;
      if (start < end && end < stop) {
        end = stop;
        break;
      }
    }
  }

  // An unfinished marker at the end of the text: wait for the rest of it.
  const tail = UNFINISHED_TAIL.exec(text);
  if (tail && end > tail.index) end = tail.index;

  return Math.max(from, end);
}
