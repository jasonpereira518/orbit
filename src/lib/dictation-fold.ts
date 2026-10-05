/**
 * Folds Deepgram's incremental results into a running (committed, interim) pair.
 *
 * Pulled out of `use-dictation.ts` into its own module, free of React and the DOM, so
 * `scripts/smoke-dictation-deepgram.ts` can exercise it under plain node — same split as
 * `dictation.ts` / `use-dictation.ts`.
 *
 * Deepgram is NOT the browser `SpeechRecognition` API: it never replays a growing results
 * list, it sends one final or interim transcript per utterance window. So instead of
 * recomputing the whole span from scratch on every event (what `use-dictation.ts` does for
 * the browser engine), this just folds each new result into what came before it — a final
 * joins the committed span with a single space, an interim replaces whatever interim was
 * showing.
 */
import type { LiveResult } from "@/lib/deepgram-live";

export type FoldState = { committed: string; interim: string };

export const EMPTY_FOLD: FoldState = { committed: "", interim: "" };

export function foldResults(prev: FoldState, r: LiveResult): FoldState {
  const text = r.text.trim();

  if (r.final) {
    if (!text) return { committed: prev.committed, interim: "" };
    const committed = prev.committed ? `${prev.committed} ${text}` : text;
    return { committed, interim: "" };
  }

  return { committed: prev.committed, interim: text };
}
