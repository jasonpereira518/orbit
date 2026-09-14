import { ProviderError, type FetchLike, type ProviderName } from "@/lib/outreach/providers/types";

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One provider call with bounded retries. 401/403 → `auth` (never retried: a bad key does not
 * get better); 429/5xx/network → retried with backoff (honouring Retry-After, capped at 8 s),
 * then `rate_limited`/`unavailable`; any other 4xx → `bad_request`.
 */
export async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  opts: { provider: ProviderName; attempts?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> }
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const last = attempt === attempts - 1;
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      if (last) throw new ProviderError(opts.provider, "unavailable", `${opts.provider} could not be reached`);
      await sleep(300 * 2 ** attempt);
      continue;
    }
    if (response.ok) return response;
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(opts.provider, "auth", `${opts.provider} rejected the API key`);
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfterSec = Number(response.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? Math.min(retryAfterSec * 1000, 8_000) : 300 * 2 ** attempt;
      if (last) {
        throw new ProviderError(
          opts.provider,
          response.status === 429 ? "rate_limited" : "unavailable",
          `${opts.provider} returned ${response.status}`,
          waitMs
        );
      }
      await sleep(waitMs);
      continue;
    }
    throw new ProviderError(opts.provider, "bad_request", `${opts.provider} returned ${response.status}`);
  }
  throw new ProviderError(opts.provider, "unavailable", `${opts.provider} could not be reached`);
}
