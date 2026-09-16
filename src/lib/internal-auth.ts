import { timingSafeEqual } from "node:crypto";
import { getAppBaseUrl } from "@/lib/app-url";

/**
 * Shared-secret gate for Orbit's internal job routes.
 *
 * The routes under it — the process-stalled cron, the import continuation target, and the
 * embedding / timeline backfill kickers — are called by Vercel Cron, by the ops scheduler,
 * and by the app's own `fetch`. None of those carry a Clerk session, so `proxy.ts` exempts
 * the paths from `auth.protect()` and THIS is the only thing standing between the public
 * internet and a privileged trigger.
 *
 * FAIL-CLOSED ON PURPOSE. Each route used to carry its own copy of this check, and every
 * copy returned `true` when `CRON_SECRET` was unset — so forgetting one env var in
 * production silently turned four job routes into anonymous endpoints. The door now opens
 * without a secret only in local development, and never on Vercel: a preview or production
 * deploy that lacks the secret answers 401 to everyone, including itself, which is loud
 * enough to notice.
 *
 * No `next/server` import — this is reached from tsx scripts via the kick helpers below,
 * and that import alone hangs the process (see the note in `src/lib/user-settings.ts`).
 */
export function isInternalRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return isLocalDevelopment();

  const presented = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  // `timingSafeEqual` throws on unequal lengths; a length mismatch is simply a wrong secret.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/** Local `next dev` with no secret configured. `VERCEL` is set on every Vercel build/runtime. */
function isLocalDevelopment() {
  return process.env.NODE_ENV === "development" && !process.env.VERCEL;
}

/** The header the routes above expect. Empty when no secret is configured (local dev). */
export function internalAuthHeaders(): Record<string, string> {
  const secret = process.env.CRON_SECRET;
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

/**
 * How long a self-kick may take. Every internal route answers as soon as it has queued its
 * work in `after()`, so ten seconds is generous — except `/api/sync/run`, which runs inline;
 * its continuation kick is best-effort by design (a lost one is picked up by the next run).
 */
export const INTERNAL_FETCH_TIMEOUT_MS = 10_000;

/**
 * `fetch` against this app's own internal routes, with the bearer attached and a timeout.
 *
 * Targets `getAppBaseUrl()` rather than the per-deployment `VERCEL_URL` so a preview build
 * does not kick a job on itself and then vanish; in production that is `APP_BASE_URL`.
 * Without the timeout, one hung kick held the kicking invocation to its own maxDuration.
 */
export function internalFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(internalAuthHeaders())) headers.set(k, v);
  return fetch(`${getAppBaseUrl()}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(INTERNAL_FETCH_TIMEOUT_MS),
  });
}

/**
 * Gate for the deep health view. Accepts `?token=` (so a browser or a monitor can use it)
 * or a bearer, compared in constant time. No token configured → the deep view is off.
 */
export function isHealthTokenValid(request: Request): boolean {
  const expected = process.env.HEALTH_TOKEN?.trim();
  if (!expected) return false;
  const url = new URL(request.url);
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const presented = url.searchParams.get("token") ?? bearer;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type HealthTokenState = "absent" | "valid" | "invalid";

/**
 * What the caller of /api/health presented. A `?token=` that does not match is `invalid`
 * — a 401, so a mistyped monitor token goes red instead of reading as a healthy shallow 200.
 * That includes a token presented while HEALTH_TOKEN is unset: a monitor configured with a
 * token against a deployment that lost it must go red too. With no parameter a valid bearer
 * still opens the deep view; anything else is `absent`.
 */
export function healthTokenState(request: Request): HealthTokenState {
  if (isHealthTokenValid(request)) return "valid";
  return new URL(request.url).searchParams.has("token") ? "invalid" : "absent";
}
