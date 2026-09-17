/**
 * Wispr Flow transcription.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE WIRE FORMAT BELOW IS UNVERIFIED. Read this before debugging a failure.
 *
 * `api-docs.wisprflow.ai` was unreachable from the environment this was written in, so
 * every constant in the "Wire format" section is reconstructed from documentation
 * excerpts, not read off the live spec. Two things follow:
 *
 *   1. Check `WISPR_ENDPOINT`, `authHeaders` and `buildTranscribeBody` against the live
 *      docs before trusting a failure. They are deliberately grouped at the top of this
 *      file, with nothing else to change if they are wrong.
 *   2. Wispr's API is reportedly limited to existing partners rather than open signup, so
 *      most installs will never have a key. That is a supported state, not a degraded
 *      one: `transcribeAudioWithAI` falls through to Whisper and then Gemini, and both
 *      get the same vocabulary bias from `transcription-vocabulary.ts`.
 *
 * Nothing here throws a failure the user sees. A bad key, a changed schema or an outage
 * returns null, and the caller moves down the chain.
 * ─────────────────────────────────────────────────────────────────────────────────────
 */

import {
  MAX_VOCABULARY_TERMS,
  loadNetworkVocabulary,
} from "@/lib/transcription-vocabulary";

// ── Wire format (unverified — see the header) ─────────────────────────────────────────

/**
 * The API-key endpoint. Wispr also documents a `/client_api` variant that authenticates
 * from the browser; deliberately not used, because it would mean shipping the key to the
 * client, and the whole reason this runs server-side is to avoid that.
 */
export const WISPR_ENDPOINT = "https://platform-api.wisprflow.ai/api/v1/dash/api";

/** Documented as base64 16 kHz WAV, ≤25 MB or ≤6 minutes. Both enforced before we call. */
export const WISPR_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Past this the request is not worth holding a capture open for. */
const REQUEST_TIMEOUT_MS = 60_000;

function authHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

export type WisprContext = {
  /** Uncommon names and words to bias toward. The reason this integration exists. */
  dictionary_context: string[];
  app: { name: string; type: "email" | "ai" | "other" };
  user_first_name?: string;
  user_last_name?: string;
};

export type WisprTranscribeInput = {
  /** Raw base64, no `data:` prefix. */
  audioBase64: string;
  /** ISO 639-1 codes. A single entry forces that language; empty means autodetect. */
  languages?: string[];
  context: WisprContext;
};

/** The request body, isolated so a spec correction is a one-function change. */
export function buildTranscribeBody(input: WisprTranscribeInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    audio: input.audioBase64,
    context: {
      app: input.context.app,
      dictionary_context: input.context.dictionary_context,
      // Documented alongside `dictionary_context`. Sent empty rather than omitted: there
      // is no surrounding textbox in this flow, and an explicit empty says so.
      textbox_contents: { before_text: "", selected_text: "", after_text: "" },
      ...(input.context.user_first_name
        ? { user_first_name: input.context.user_first_name }
        : {}),
      ...(input.context.user_last_name
        ? { user_last_name: input.context.user_last_name }
        : {}),
    },
  };
  if (input.languages?.length) body.language = input.languages;
  return body;
}

/**
 * Pull the transcript out of a response.
 *
 * Tolerant on purpose: the documented shape is `{ text, detected_language, … }`, but the
 * REST and WebSocket surfaces differ (the socket nests under `body`), and this could not
 * be checked against the live spec. Accepting both costs three lines and turns a schema
 * surprise into a working transcript instead of a silent fallback to Whisper.
 */
export function parseTranscribeResponse(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;

  const direct = typeof root.text === "string" ? root.text : null;
  const nested =
    root.body && typeof root.body === "object"
      ? ((root.body as Record<string, unknown>).text as unknown)
      : null;

  const text = direct ?? (typeof nested === "string" ? nested : null);
  if (text === null) return null;
  const trimmed = text.trim();
  // An empty transcript is a successful call that heard nothing. Null, so the caller tries
  // the next engine rather than saving a blank note.
  return trimmed.length > 0 ? trimmed : null;
}

// ── Call ──────────────────────────────────────────────────────────────────────────────

/**
 * Transcribe one recording, or return null.
 *
 * Never throws. Every failure — no key, a 4xx, a timeout, a shape we do not recognise — is
 * the same outcome from the caller's point of view: try the next engine.
 */
export async function transcribeWithWispr(
  apiKey: string,
  input: WisprTranscribeInput,
): Promise<string | null> {
  if (!apiKey.trim()) return null;

  // base64 is 4 bytes per 3, so this is the decoded size the endpoint will see.
  const decodedBytes = Math.floor((input.audioBase64.length * 3) / 4);
  if (decodedBytes > WISPR_MAX_AUDIO_BYTES) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(WISPR_ENDPOINT, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(buildTranscribeBody(input)),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseTranscribeResponse(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Assemble the context for one user: their network as vocabulary, plus their own name so
 * the transcriber gets first-person references right.
 *
 * `app.type` is "other". The documented set is {email, ai, other} and a capture note is
 * neither an email nor a chat with a model — it is someone talking to themselves about a
 * meeting.
 */
export async function buildWisprContext(
  userId: string,
  user?: { firstName?: string | null; lastName?: string | null },
): Promise<WisprContext> {
  const dictionary = await loadNetworkVocabulary(userId, MAX_VOCABULARY_TERMS);
  return {
    dictionary_context: dictionary,
    app: { name: "Orbit", type: "other" },
    ...(user?.firstName ? { user_first_name: user.firstName } : {}),
    ...(user?.lastName ? { user_last_name: user.lastName } : {}),
  };
}
