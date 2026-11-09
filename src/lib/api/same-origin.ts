/**
 * Cross-site request refusal for cookie-authenticated route handlers (audit L-01, FIX_PLAN 3.3).
 *
 * Server Actions get this from Next itself: the `Origin` host is compared with the app's own
 * host (`x-forwarded-host`, else `host`), and a request with no `Origin` is let through
 * (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`).
 * Route handlers get nothing, so several hand-rolled it and `/api/chat` did not. This is
 * the same rule, once, for every route that a signed-in browser tab calls with its cookie:
 *
 *   - An `Origin` naming another host (or `null`, from a sandboxed frame or a privacy
 *     redirect) is refused 403.
 *   - No `Origin` is allowed — that is a same-origin GET/HEAD, an old browser, or a
 *     non-browser client with no cookie to abuse — unless `Sec-Fetch-Site` says
 *     `cross-site`, which only a browser sends and only for a request it knows is cross-site.
 *   - `{ json: true }` also requires a JSON `Content-Type` when one is sent. A cross-site
 *     `<form>` or no-cors `fetch` can only send `text/plain`, form or multipart bodies without
 *     a preflight; a JSON type cannot be sent cross-site without CORS approving it, which no
 *     route here does. A request with no body sends no `Content-Type` and passes.
 *
 * Deliberately NOT used by (each carries its own credential, or is called cross-origin by
 * design — `scripts/smoke-origin-checks.ts` holds the commented list):
 * `/api/extension/*` (the Chrome extension, a `chrome-extension://` origin with a Clerk
 * bearer token), `/api/v1/*` and `/api/mcp*` (bearer API keys / OAuth), `/api/webhooks/*`
 * (Stripe, Clerk/svix and Resend signatures), the unsubscribe endpoints (RFC 8058 one-click
 * POSTs from mail providers, authorised by the token in the URL), `/api/csp-report`
 * (browsers' own reports), `/api/scan/[token]/*` (the phone handoff token), and the cron and
 * internal routes (`isInternalRequest`'s shared secret).
 *
 * No `next/server` import, so the smoke test can load it under plain Node.
 */

export class RequestRefusedError extends Error {
  readonly status: 403 | 415;
  constructor(status: 403 | 415, message: string) {
    super(message);
    this.name = "RequestRefusedError";
    this.status = status;
  }
}

export type SameOriginOptions = {
  /** The handler reads a JSON body: refuse any other declared `Content-Type` with 415. */
  json?: boolean;
  /** The 403 wording, for routes whose clients show it ("Cross-origin upload refused"). */
  message?: string;
};

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i;

function hostOf(value: string | null | undefined): string | null {
  const first = value?.split(",")[0]?.trim();
  return first ? first.toLowerCase() : null;
}

/** The hosts this request was addressed to, as the browser would have named them. */
function ownHosts(request: Request): Set<string> {
  const hosts = new Set<string>();
  const add = (h: string | null) => {
    if (h) hosts.add(h);
  };
  add(hostOf(request.headers.get("x-forwarded-host")));
  add(hostOf(request.headers.get("host")));
  add(URL.parse(request.url)?.host.toLowerCase() ?? null);
  return hosts;
}

/** Why this request should be refused, or null when it may proceed. */
export function sameOriginRefusal(request: Request, opts: SameOriginOptions = {}): RequestRefusedError | null {
  const refused = () => new RequestRefusedError(403, opts.message ?? "Cross-origin request refused");
  const origin = request.headers.get("origin");
  if (origin !== null) {
    const host = URL.parse(origin)?.host.toLowerCase();
    if (!host || !ownHosts(request).has(host)) return refused();
  } else if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
    return refused();
  }

  if (opts.json) {
    const type = request.headers.get("content-type");
    if (type !== null && type.trim() !== "" && !JSON_TYPE.test(type.trim())) {
      return new RequestRefusedError(415, "Send this request as JSON");
    }
  }
  return null;
}

/** Throws `RequestRefusedError` (403, or 415 for a non-JSON body) — `routeError` answers it. */
export function assertSameOrigin(request: Request, opts: SameOriginOptions = {}): void {
  const refusal = sameOriginRefusal(request, opts);
  if (refusal) throw refusal;
}

/**
 * The guard as a response, for a handler that returns early rather than throwing:
 *
 *   const refused = sameOriginGuard(request, { json: true });
 *   if (refused) return refused;
 *
 * Built on `assertSameOrigin`; the body is `{ error }` like every other refusal here.
 */
export function sameOriginGuard(request: Request, opts: SameOriginOptions = {}): Response | null {
  try {
    assertSameOrigin(request, opts);
    return null;
  } catch (err) {
    const refusal = err as RequestRefusedError;
    return Response.json({ error: refusal.message }, { status: refusal.status });
  }
}
