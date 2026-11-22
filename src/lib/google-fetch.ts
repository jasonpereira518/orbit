import { fetchWithRetry } from "@/lib/http/retry";

/**
 * `fetch` for Google APIs: backoff on quota answers and a fresh timeout per attempt.
 *
 * Moved out of `gmail.ts` so the Calendar connector — "fetch and map only", no database —
 * can use it without importing `@/db`. Its only import, `@/lib/http/retry`, has none of its own.
 *
 * Gmail's "Units per minute per user" quota is cost-based, not request-count-based, so a
 * heavy scan can trip it well before any endpoint's own rate limit. A 403 for that reason
 * (`rateLimitExceeded` / `quotaExceeded` / `userRateLimitExceeded`, distinct from a genuine
 * permission-denied 403) and any 429 are transient and worth waiting out. People and
 * Calendar share the same quota vocabulary.
 */
export const GOOGLE_MAX_RETRIES = 5;

/**
 * Ceiling on one wait. Calendar sync gives each connection a 60-second budget, and an
 * uncapped `Retry-After` would spend all of it asleep.
 */
export const GOOGLE_MAX_RETRY_DELAY_MS = 30_000;

export type GoogleFetchInit = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

async function isRetryableGoogleResponse(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const text = await res.clone().text();
  return /rateLimitExceeded|quotaExceeded|userRateLimitExceeded/i.test(text);
}

/**
 * A fresh `AbortSignal.timeout` per attempt — reusing one across retries would leave later
 * attempts pre-aborted. Honours `Retry-After` (capped), otherwise exponential backoff with
 * jitter. Returns the last response when retries run out; callers decide what a non-2xx means.
 */
export function googleFetchWithRetry(url: string | URL, init: GoogleFetchInit): Promise<Response> {
  return fetchWithRetry(url, init, {
    maxRetries: GOOGLE_MAX_RETRIES,
    maxDelayMs: GOOGLE_MAX_RETRY_DELAY_MS,
    isRetryable: isRetryableGoogleResponse,
  });
}
