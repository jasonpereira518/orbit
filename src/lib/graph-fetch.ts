import { fetchWithRetry } from "@/lib/http/retry";

/**
 * `fetch` for Microsoft Graph: backoff on throttling and a fresh timeout per attempt.
 *
 * The Outlook counterpart of `google-fetch.ts`, and dependency-free for the same reason.
 * Graph throttles per mailbox — a small cap on concurrent requests plus a request-rate
 * budget — and answers with 429 and a `Retry-After`; 503/504 are its transient "try again".
 * A mailbox sweep fetches one message per request, so without this a heavy scan trips the
 * limit and every throttled message reads as "not there".
 */
export const GRAPH_MAX_RETRIES = 5;

/** Ceiling on one wait, so an uncapped `Retry-After` cannot spend a whole invocation asleep. */
export const GRAPH_MAX_RETRY_DELAY_MS = 30_000;

export type GraphFetchInit = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

function isRetryableGraphStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 504;
}

/**
 * A fresh `AbortSignal.timeout` per attempt — reusing one across retries would leave later
 * attempts pre-aborted. Honours `Retry-After` (capped), otherwise exponential backoff with
 * jitter. Returns the last response when retries run out; callers decide what a non-2xx means.
 */
export function graphFetchWithRetry(url: string | URL, init: GraphFetchInit): Promise<Response> {
  return fetchWithRetry(url, init, {
    maxRetries: GRAPH_MAX_RETRIES,
    maxDelayMs: GRAPH_MAX_RETRY_DELAY_MS,
    isRetryable: (res) => isRetryableGraphStatus(res.status),
  });
}
