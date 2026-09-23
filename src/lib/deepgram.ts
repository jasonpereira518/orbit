/**
 * Deepgram — Orbit's own speech-to-text key.
 *
 * THIS IS THE ONLY FILE THAT READS `DEEPGRAM_API_KEY`. The browser never sees it: live
 * transcription runs on 30-second grant tokens minted here (`mintStreamToken`), which are
 * good for opening one connection and nothing else.
 *
 * Deliberately NOT part of `ai-access.ts`. That gate arbitrates LLM provider keys, where the
 * rule is bring-your-own and Orbit's managed keys are Lifetime-only and currently switched
 * off. Deepgram is a hosted service Orbit pays for on every plan, like hosted Apollo
 * enrichment: entitlement plus quota, checked by the caller, recorded in `speech_usage`.
 */
import { listenParams } from "@/lib/deepgram-params";
import { UserFacingError } from "@/lib/errors";

const GRANT_URL = "https://api.deepgram.com/v1/auth/grant";
const LISTEN_URL = "https://api.deepgram.com/v1/listen";
const DEFAULT_TTL_SECONDS = 30;
const FILE_TIMEOUT_MS = 90_000;

function apiKey(): string | null {
  return process.env.DEEPGRAM_API_KEY?.trim() || null;
}

export function deepgramConfigured(): boolean {
  return Boolean(apiKey());
}

/** The kill switch: `ORBIT_DEEPGRAM=off` reverts every surface to the Whisper/Gemini chain. */
export function deepgramEnabled(): boolean {
  if (process.env.ORBIT_DEEPGRAM?.trim().toLowerCase() === "off") return false;
  return deepgramConfigured();
}

function requireKey(): string {
  const key = apiKey();
  if (!key) throw new UserFacingError("Transcription isn't configured on this deployment.");
  return key;
}

export async function mintStreamToken(
  opts: { ttlSeconds?: number } = {},
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(GRANT_URL, {
    method: "POST",
    headers: { Authorization: `Token ${requireKey()}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl_seconds: opts.ttlSeconds ?? DEFAULT_TTL_SECONDS }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Deepgram grant failed: ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Deepgram grant returned no token");
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? DEFAULT_TTL_SECONDS };
}

export type DeepgramFileResult = { text: string; seconds: number; requestId: string | null };

export async function transcribeFile(
  audio: { bytes: Uint8Array; mimeType: string },
  opts: { keyterms?: readonly string[] } = {},
): Promise<DeepgramFileResult> {
  const params = listenParams({ live: false, keyterms: opts.keyterms });
  const res = await fetch(`${LISTEN_URL}?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${requireKey()}`, "content-type": audio.mimeType || "audio/wav" },
    body: audio.bytes as unknown as BodyInit,
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Deepgram transcription failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    metadata?: { duration?: number; request_id?: string };
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  return {
    text: body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "",
    seconds: Math.ceil(body.metadata?.duration ?? 0),
    requestId: body.metadata?.request_id ?? null,
  };
}
