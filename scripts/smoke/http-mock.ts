/**
 * A `globalThis.fetch` stand-in for contract tests against third-party APIs.
 *
 *   const http = mockFetch([
 *     route("GET", /googleapis\.com\/drive\/v3\/files/, () => json({ files: [] })),
 *     route("POST", "https://oauth2.googleapis.com/token", () => status(400, { error: "invalid_grant" })),
 *   ]);
 *   try { ...code under test... } finally { http.restore(); }
 *
 * Unmatched requests THROW (as a network error would), so a test can never fall through to
 * the real network by accident, and `http.calls` records every request for assertions about
 * what was sent. The response helpers cover the cases a contract test has to pin: success,
 * an HTTP error with a body, a body that is not JSON, a body that is JSON but the wrong
 * shape, a network failure, and a request that never answers (for timeout handling).
 */

export type Call = { method: string; url: string; headers: Record<string, string>; body: string | null };
type Handler = (call: Call) => Response | Promise<Response>;
type Route = { method: string; match: string | RegExp; handler: Handler };

export function route(method: string, match: string | RegExp, handler: Handler): Route {
  return { method: method.toUpperCase(), match, handler };
}

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

export const status = (code: number, body: unknown = { error: `HTTP ${code}` }, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: code,
    headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json", ...headers },
  });

/** A 200 whose body is not JSON at all — an HTML error page from a proxy, say. */
export const notJson = (text = "<html><body>Bad Gateway</body></html>") =>
  new Response(text, { status: 200, headers: { "content-type": "text/html" } });

/** A 200 that never resolves its body past the first byte: for testing timeouts. */
export const hang = (): Promise<Response> => new Promise(() => {});

export class MockNetworkError extends TypeError {
  constructor(url: string) {
    super(`fetch failed (mock network error) for ${url}`);
    this.name = "TypeError";
  }
}

/** Use as a handler to simulate DNS failure / connection reset. */
export const networkError = (call: Call): never => {
  throw new MockNetworkError(call.url);
};

export function mockFetch(routes: Route[]) {
  const original = globalThis.fetch;
  const calls: Call[] = [];

  const fake: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? req?.headers ?? {}).forEach((v, k) => (headers[k] = v));
    let body: string | null = null;
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof URLSearchParams) body = init.body.toString();
    else if (req) body = await req.clone().text();
    const call: Call = { method, url, headers, body };
    calls.push(call);
    const hit = routes.find(
      (r) => (r.method === "*" || r.method === method) && (typeof r.match === "string" ? url === r.match || url.startsWith(r.match) : r.match.test(url))
    );
    if (!hit) throw new MockNetworkError(`${method} ${url} (no mock route matched)`);
    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException("aborted", "AbortError");
    const answer = hit.handler(call);
    if (!init?.signal) return answer;
    // Honour AbortSignal so code with a timeout sees the abort, not a hang.
    const signal = init.signal;
    return Promise.race([
      answer,
      new Promise<Response>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), { once: true })
      ),
    ]);
  };

  globalThis.fetch = fake;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
