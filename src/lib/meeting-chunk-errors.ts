import {
  MISSING_AI_API_KEY_MESSAGE,
  classifyAiError,
  friendlyError,
  isMissingAiApiKeyError,
} from "@/lib/errors";

/**
 * The response for a chunk that could not be transcribed.
 *
 * 422 is terminal to the recorder: no key, a rejected key, an empty balance or a missing
 * model fail every later chunk identically, and six retries per chunk of an hour-long call
 * is hundreds of wasted provider calls. Everything else (timeouts, rate limits, outages) is
 * 502, which the recorder retries with backoff.
 */
export type ChunkFailure = { status: 422 | 502; body: { error: string; code?: string } };

const KEY_PROBLEM_FALLBACK = {
  auth: "Your transcription provider didn’t accept your API key — check it in Settings",
  quota: "Your transcription provider says your account is out of credit — top up with them, then try again",
  model_unavailable: "That transcription model isn’t available — pick another in Settings",
} as const;

export function chunkFailureResponse(err: unknown): ChunkFailure {
  const message = err instanceof Error ? err.message : "";
  if (isMissingAiApiKeyError(message)) {
    return { status: 422, body: { error: MISSING_AI_API_KEY_MESSAGE, code: "no-transcription-key" } };
  }
  const kind = classifyAiError(err);
  if (kind === "auth" || kind === "quota" || kind === "model_unavailable") {
    return {
      status: 422,
      body: { error: friendlyError(err, KEY_PROBLEM_FALLBACK[kind]), code: `transcription-${kind}` },
    };
  }
  return { status: 502, body: { error: friendlyError(err, "Couldn’t transcribe that part of the meeting") } };
}
