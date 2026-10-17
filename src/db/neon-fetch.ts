/**
 * The `fetch` the Neon HTTP driver uses for every statement.
 *
 * Without it a stalled connection held its request for Node's default of about 300 s
 * (reliability/tests/db-faults.mts), so a slow or waking Neon compute turned every page into
 * a function killed at `maxDuration`, and one transient 502/503 or dropped connection failed
 * the request on its first attempt.
 *
 *   - Every statement gets a deadline (`DB_QUERY_TIMEOUT_MS`, default 30 s). The role's
 *     `statement_timeout` bounds the server side; this bounds the wire.
 *   - A plain read (SELECT / SHOW) that fails to connect or gets a 502/503/504 is retried
 *     ONCE after a short jittered pause. Writes, batches, locks and anything else are never
 *     retried here: the caller cannot tell whether a failed write landed.
 *   - A timeout is not retried: a second full wait would only double the stall.
 *
 * Pure of app imports so a smoke script can load it.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_STATUSES = new Set([502, 503, 504]);

export function dbQueryTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DB_QUERY_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1_000 ? n : DEFAULT_TIMEOUT_MS;
}

/** Whether the request body is one plain read statement the driver may safely send twice. */
export function isRetryableRead(body: unknown): boolean {
  if (typeof body !== "string") return false;
  let parsed: { query?: unknown; queries?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (parsed.queries !== undefined) return false; // a batch is a transaction
  const text = typeof parsed.query === "string" ? parsed.query.trim() : "";
  if (!/^(select|show)\b/i.test(text)) return false;
  return !/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(text);
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function createResilientFetch(
  base: FetchLike = (input, init) => fetch(input, init),
  options: { timeoutMs?: number; retryDelayMs?: () => number } = {}
): FetchLike {
  const retryDelayMs = options.retryDelayMs ?? (() => 200 + Math.random() * 400);
  return async (input, init) => {
    const timeoutMs = options.timeoutMs ?? dbQueryTimeoutMs();
    const attempt = () => base(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const retryable = isRetryableRead(init?.body);
    try {
      const res = await attempt();
      if (!retryable || !RETRY_STATUSES.has(res.status)) return res;
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      if (!retryable || timedOut) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs()));
    return attempt();
  };
}
