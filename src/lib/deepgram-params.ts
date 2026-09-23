/**
 * How Orbit asks Deepgram to listen — as pure data, so the live path (browser)
 * and the file path (server) cannot drift apart.
 *
 * Keyterm prompting is the reason names come back spelled right. Deepgram caps a
 * request at 500 tokens across all keyterms and recommends 20-50 terms; we cut whole
 * terms rather than sending a truncated name, which would bias toward a word nobody said.
 */

export const DEEPGRAM_MODEL = "nova-3";
export const MAX_KEYTERMS = 50;
export const KEYTERM_TOKEN_BUDGET = 500;

/** Deepgram counts tokens, not characters. Four characters per token, rounded up, is the usual approximation. */
function tokenCost(term: string): number {
  return Math.ceil(term.length / 4);
}

export function keytermsFor(terms: readonly string[]): string[] {
  const out: string[] = [];
  let spent = 0;
  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;
    if (out.length >= MAX_KEYTERMS) break;
    const cost = tokenCost(term);
    if (spent + cost > KEYTERM_TOKEN_BUDGET) break;
    out.push(term);
    spent += cost;
  }
  return out;
}

export type ListenOptions = {
  /** A websocket request; a file request otherwise. */
  live: boolean;
  diarize?: boolean;
  keyterms?: readonly string[];
  /** Rides into Deepgram's usage records, so a nightly job can reconcile one meeting. */
  tag?: string;
};

export function listenParams(opts: ListenOptions): URLSearchParams {
  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    smart_format: "true",
    punctuate: "true",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
  });
  if (opts.live) {
    params.set("interim_results", "true");
    params.set("utterance_end_ms", "1000");
    params.set("vad_events", "true");
  }
  if (opts.diarize) params.set("diarize", "true");
  for (const term of keytermsFor(opts.keyterms ?? [])) params.append("keyterm", term);
  if (opts.tag) params.set("tag", opts.tag);
  // Deepgram's Model Improvement Program is opt-OUT by default, which means audio and
  // transcripts are retained to train their models unless a request says otherwise. Deepgram
  // documents this flag as zero data retention: nothing is stored after the response. Private
  // meeting audio is not ours to donate to a vendor's training set, so every request — live and
  // file — carries this, unconditionally.
  params.set("mip_opt_out", "true");
  return params;
}
