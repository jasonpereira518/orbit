import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { AI_PROVIDERS, DEFAULT_MODELS, type AiProvider } from "@/lib/ai-providers";
import { isAiKeyRejectedError } from "@/lib/errors";

/**
 * One cheap, read-only provider call that answers "does this key work", made when a key is
 * saved. Saving `AIzaSy-INVALID-…` used to say "AI settings saved" and "Your key is saved",
 * and the first question then failed with copy telling the person to add a key (audit A9).
 *
 * Three verdicts, not two: a refusal (401/403, or a refused-key body) blocks the save; a
 * network error, timeout or 5xx saves anyway with a note, because a provider outage must
 * never stop someone saving a good key.
 *
 * Server-only: imported by `src/actions/settings.ts`. No `@/db`, no `next/server`.
 */
export type KeyCheckVerdict = "accepted" | "rejected" | "unverified";
export type KeyProbe = (apiKey: string, signal: AbortSignal) => Promise<void>;

export const KEY_CHECK_TIMEOUT_MS = 6_000;

export const KEY_PROBES: Record<AiProvider, KeyProbe> = {
  // Metadata for one model that exists: authenticated, free, a few hundred bytes.
  gemini: async (apiKey, signal) => {
    await new GoogleGenAI({ apiKey }).models.get({
      model: DEFAULT_MODELS.gemini,
      config: { abortSignal: signal },
    });
  },
  openai: async (apiKey, signal) => {
    await new OpenAI({ apiKey, maxRetries: 0 }).models.list({ signal });
  },
  anthropic: async (apiKey, signal) => {
    await new Anthropic({ apiKey, maxRetries: 0 }).models.list({ limit: 1 }, { signal });
  },
};

export function isKeyRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return true;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return isAiKeyRejectedError(message);
}

export async function checkAiKey(
  provider: AiProvider,
  apiKey: string,
  opts: { probes?: Record<AiProvider, KeyProbe>; timeoutMs?: number } = {}
): Promise<KeyCheckVerdict> {
  const probe = (opts.probes ?? KEY_PROBES)[provider];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("key check timed out"));
    }, opts.timeoutMs ?? KEY_CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(apiKey, controller.signal), deadline]);
    return "accepted";
  } catch (err) {
    return isKeyRejection(err) ? "rejected" : "unverified";
  } finally {
    clearTimeout(timer);
  }
}

export type KeyCheckOutcome = { save: true; note: string | null } | { save: false; error: string };

export function keyCheckOutcome(verdict: KeyCheckVerdict, provider: AiProvider): KeyCheckOutcome {
  const label = AI_PROVIDERS.find((p) => p.id === provider)?.label ?? "Your AI provider";
  if (verdict === "rejected") {
    return { save: false, error: `${label} didn’t accept that key — check it and try again` };
  }
  if (verdict === "unverified") {
    return { save: true, note: `Saved — ${label} didn’t answer, so the key isn’t checked yet` };
  }
  return { save: true, note: null };
}
