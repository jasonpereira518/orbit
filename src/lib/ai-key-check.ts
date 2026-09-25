import { AI_PROVIDERS, DEFAULT_MODELS, type AiProvider } from "@/lib/ai-providers";
import { JEV_MODEL } from "@/lib/ai-models";
import { isAiKeyRejectedError } from "@/lib/errors";
import { systemOneRequest } from "@/lib/typesafe-api";

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
export type KeyCheckVerdict = "accepted" | "rejected" | "unverified" | "malformed";

/**
 * Every provider's keys are printable ASCII with no spaces. A paste that picked up anything
 * else — a typographic ellipsis, a non-breaking space, a smart quote — cannot even be sent:
 * `fetch` refuses the header before any request leaves, and that TypeError used to read as
 * "the provider didn't answer", so the broken key was SAVED and then failed quietly on
 * every call. Caught here, before any probe runs.
 */
export function looksLikeApiKey(key: string): boolean {
  return /^[\x21-\x7E]{8,}$/.test(key);
}
export type KeyProbe = (apiKey: string, signal: AbortSignal) => Promise<void>;

export const KEY_CHECK_TIMEOUT_MS = 6_000;

export const KEY_PROBES: Record<AiProvider, KeyProbe> = {
  // Metadata for one model that exists: authenticated, free, a few hundred bytes.
  // Each probe loads its SDK when it runs: this module is imported by the settings actions,
  // which every page that reads settings pulls in, and a key check is rare.
  gemini: async (apiKey, signal) => {
    const { GoogleGenAI } = await import("@google/genai");
    await new GoogleGenAI({ apiKey }).models.get({
      model: DEFAULT_MODELS.gemini,
      config: { abortSignal: signal },
    });
  },
  openai: async (apiKey, signal) => {
    const { default: OpenAI } = await import("openai");
    await new OpenAI({ apiKey, maxRetries: 0 }).models.list({ signal });
  },
  anthropic: async (apiKey, signal) => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
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
  return runKeyProbe((opts.probes ?? KEY_PROBES)[provider], apiKey, opts.timeoutMs);
}

/**
 * TypeSafe has no free metadata endpoint to ask, so the probe is the smallest real call: one
 * yes/no question about a few words — a dozen input tokens, about a millionth of a cent.
 */
export const TYPESAFE_KEY_PROBE: KeyProbe = async (apiKey, signal) => {
  await systemOneRequest(
    apiKey,
    {
      model: JEV_MODEL,
      state: "Orbit is checking that this key works.",
      questions: { check: { type: "noul", instructions: "Is this text about checking a key?" } },
    },
    { signal, retries: 0 }
  );
};

/** The decision model's key (TypeSafe), checked the same way as a chat provider's. */
export function checkDecisionKey(
  apiKey: string,
  opts: { probe?: KeyProbe; timeoutMs?: number } = {}
): Promise<KeyCheckVerdict> {
  return runKeyProbe(opts.probe ?? TYPESAFE_KEY_PROBE, apiKey, opts.timeoutMs);
}

async function runKeyProbe(probe: KeyProbe, apiKey: string, timeoutMs?: number): Promise<KeyCheckVerdict> {
  if (!looksLikeApiKey(apiKey)) return "malformed";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("key check timed out"));
    }, timeoutMs ?? KEY_CHECK_TIMEOUT_MS);
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

export function keyCheckOutcome(verdict: KeyCheckVerdict, provider: AiProvider | "typesafe"): KeyCheckOutcome {
  const label =
    provider === "typesafe"
      ? "TypeSafe"
      : (AI_PROVIDERS.find((p) => p.id === provider)?.label ?? "Your AI provider");
  if (verdict === "rejected") {
    return { save: false, error: `${label} didn’t accept that key — check it and try again` };
  }
  if (verdict === "malformed") {
    return { save: false, error: `That key has a character API keys don’t contain — copy it again from ${label}` };
  }
  if (verdict === "unverified") {
    return { save: true, note: `Saved — ${label} didn’t answer, so the key isn’t checked yet` };
  }
  return { save: true, note: null };
}
