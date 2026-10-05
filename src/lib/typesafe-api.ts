/**
 * The TypeSafe HTTP API — the one file that names its host.
 *
 * TypeSafe's Jev is a decision model, not a chat model: it takes a `state` and a map of typed
 * questions and answers each with calibrated probabilities (see `src/lib/decisions/jev.ts`).
 * One endpoint, so a fetch rather than the SDK (`@typesafe-ai/sdk`, v0.6 at the time): the
 * SDK would be a dependency and a guard entry to buy a retry loop.
 *
 * Takes a raw key, so it is treated like an AI SDK: `scripts/smoke-ai-access.ts` fails the
 * suite if anything but the gate (`ai-access.ts`) and the save-time key probe
 * (`ai-key-check.ts`) imports it. Everything else reaches TypeSafe through a grant.
 *
 * Pure: no `@/db`, no env, no `next/server`.
 */

export const TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";

/** What goes over the wire. Question shapes are TypeSafe's own (`noul`, not `boolean`). */
export type SystemOneQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type SystemOneRequest = {
  model: string;
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, SystemOneQuestion>;
};

/** The response as sent — validated by the caller, never trusted by shape alone. */
export type SystemOneResponse = {
  model?: unknown;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
};

/**
 * A non-2xx from TypeSafe. `status` is what `isKeyRejection` and `classifyAiError` read, the
 * same field the provider SDKs put on their errors.
 */
export class TypeSafeApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TypeSafeApiError";
    this.status = status;
  }
}

/** Rate-limited and overloaded — the two statuses TypeSafe documents as worth a retry. */
const RETRYABLE = new Set([429, 529]);

export async function systemOneRequest(
  apiKey: string,
  body: SystemOneRequest,
  opts: {
    signal?: AbortSignal;
    /** Extra attempts after a 429/529. One by default: callers all have a fallback. */
    retries?: number;
    /** Injected by tests. */
    fetchImpl?: typeof fetch;
    /** Base backoff before a retry, in ms. Injected by tests. */
    backoffMs?: number;
  } = {},
): Promise<SystemOneResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 1;
  const backoffMs = opts.backoffMs ?? 250;

  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(TYPESAFE_SYSTEM_ONE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (res.ok) return (await res.json()) as SystemOneResponse;

    if (RETRYABLE.has(res.status) && attempt < retries && !opts.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** attempt));
      continue;
    }

    // The body is TypeSafe's validation detail on a 422 — useful in a log, never shown to a
    // person (callers fall back silently).
    const detail = await res.text().catch(() => "");
    throw new TypeSafeApiError(res.status, `TypeSafe ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
}
