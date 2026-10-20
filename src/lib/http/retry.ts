/**
 * Retry helpers for outbound HTTP: one backoff ladder and one retrying `fetch`.
 *
 * No imports: `google-fetch.ts` and `graph-fetch.ts` are deliberately dependency-free so
 * the connectors that use them never pull in `@/db`, and this file keeps that promise.
 */

export type BackoffOptions = {
  /** Wait for attempt 0; doubles each attempt. Default 300. */
  baseMs?: number;
  /** Upper bound of the random addend. Default 250. */
  jitterMs?: number;
  /** Ceiling on the exponential part (the jitter is added on top). Default none. */
  maxMs?: number;
  /** Floor the jitter to a whole number of ms. Default true. */
  integerJitter?: boolean;
  /** Injectable for tests. Default `Math.random`. */
  random?: () => number;
};

/**
 * `min(maxMs, baseMs * 2^attempt) + jitter`, jitter in `[0, jitterMs)`. With the defaults this is
 * the ladder Apollo, Eventbrite, Luma and guarded-fetch all used: 300 * 2^attempt + floor(random * 250).
 * Calls `random` exactly once.
 */
export function backoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 300, jitterMs = 250, maxMs = Infinity, integerJitter = true } = opts;
  const random = opts.random ?? Math.random;
  const jitter = integerJitter ? Math.floor(random() * jitterMs) : random() * jitterMs;
  return Math.min(maxMs, baseMs * 2 ** attempt) + jitter;
}

/** `Retry-After` in whole or fractional seconds, as ms; null when absent, zero, negative or not a number. */
export function retryAfterMs(res: Response): number | null {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

export type FetchWithRetryInit = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  /** Applied as a FRESH `AbortSignal.timeout` on every attempt. */
  timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

export type FetchWithRetryOptions = {
  /** Retries after the first attempt; the last response is returned once they run out. */
  maxRetries: number;
  /** Ceiling on one wait, applied to `Retry-After` and to the computed backoff alike. */
  maxDelayMs: number;
  /** Whether a non-ok response is transient. May read a clone of the body. */
  isRetryable: (res: Response) => boolean | Promise<boolean>;
  /** Ladder used when there is no usable `Retry-After`. Default: 500 * 2^attempt capped at 30s, + random * 250. */
  backoff?: BackoffOptions;
};

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 30_000, integerJitter: false };

/**
 * `fetch` with backoff on transient answers. A fresh `AbortSignal.timeout` per attempt —
 * reusing one would leave later attempts pre-aborted. Honours `Retry-After`, otherwise
 * exponential backoff with jitter; both capped at `maxDelayMs`. Returns the last response when
 * retries run out; callers decide what a non-2xx means. Network errors propagate (not retried).
 */
export async function fetchWithRetry(
  url: string | URL,
  init: FetchWithRetryInit,
  opts: FetchWithRetryOptions
): Promise<Response> {
  const doFetch = init.fetchImpl ?? fetch;
  const sleep = init.sleep ?? DEFAULT_SLEEP;
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    if (res.ok || attempt >= opts.maxRetries || !(await opts.isRetryable(res))) {
      return res;
    }
    const delayMs = retryAfterMs(res) ?? backoffMs(attempt, opts.backoff ?? DEFAULT_BACKOFF);
    await sleep(Math.min(delayMs, opts.maxDelayMs));
  }
}
