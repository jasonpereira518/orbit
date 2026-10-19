/**
 * The one error funnel for cookie-authenticated route handlers (FIX_PLAN 3.2).
 *
 * Route handlers under `src/app/api/**` each hand-rolled the same switch — a paywall is 403,
 * not signed in is 401, a rate limit is 429 with `Retry-After`, anything else a 500 — and
 * each drifted a little: one forgot `Retry-After`, one returned `err.message` for a fault,
 * one answered a suspended account 401. This is that switch, once:
 *
 *   UserFacingError, ZodError            400  { error }            Orbit's words / the bad field
 *   CapReachedError                       429  { error }            + Retry-After when known
 *   RateLimitedError                      429  { error }            + Retry-After
 *   PaywallError                          403  { error }            the plan's own denial copy
 *   AccountSuspendedError                 403  { error }
 *   UnauthorizedError (and held)          401  { error }
 *   RequestRefusedError                   403 / 415                 see `same-origin.ts`
 *   anything else                         500  { error, ref }       `reportedFailure`: the
 *                                                                   caller's fallback plus a
 *                                                                   reference, never the raw
 *                                                                   message
 *
 * The body is `{ error: string }` because that is what every browser caller of these routes
 * already reads (`res.json().error`); a 500 adds `ref`, which several already did. The public
 * API (`src/lib/api/http.ts`) and the extension (`src/lib/extension/http.ts`) keep their own
 * `{ ok: false, error: { code, message } }` envelopes: they have external consumers.
 *
 * Errors are recognised by `name` as well as class, like `friendlyError`: importing
 * `@/lib/auth` here would drag Clerk into every caller, and a second module instance (a test
 * runner, a separately bundled chunk) would fail an `instanceof`.
 */
import { NextResponse } from "next/server";
import { friendlyError } from "@/lib/errors";
import { reportedFailure } from "@/lib/report-error";

export type RouteErrorOptions = {
  /** What the person reads for a fault. Never replaced by the error's own message. */
  fallback: string;
  /** `reportError`'s call-site name, e.g. `route.research`. */
  where: string;
  userId?: string | null;
  extra?: Record<string, unknown>;
  /** Status for an unrecognised fault. 500 by default; an upstream failure may say 502. */
  faultStatus?: number;
};

export type ClassifiedError = {
  status: number;
  message: string;
  retryAfterSec?: number;
  /** The offending field, for a validation failure. */
  param?: string;
};

function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : "";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

/** A zod error, without importing zod's class (several copies can be bundled). */
function zodIssue(err: unknown): { message: string; path: string } | null {
  if (nameOf(err) !== "ZodError") return null;
  const issues = (err as { issues?: Array<{ message?: string; path?: Array<string | number> }> }).issues;
  const first = Array.isArray(issues) ? issues[0] : undefined;
  return { message: first?.message ?? "Invalid input", path: (first?.path ?? []).join(".") };
}

/**
 * The status and message for an error this funnel recognises, or null for a fault. Exported
 * for handlers whose response is not JSON (a stream that already started, a 204 beacon) and
 * for the smoke test.
 */
export function classifyRouteError(err: unknown): ClassifiedError | null {
  const name = nameOf(err);
  const message = messageOf(err);

  if (name === "RequestRefusedError") {
    const status = (err as { status?: number }).status ?? 403;
    return { status, message };
  }
  // Before UserFacingError: a cap IS one (so server actions show it), but it is a 429 here.
  const retry = (err as { retryAfterSec?: unknown }).retryAfterSec;
  if (name === "RateLimitedError" || (err as { code?: unknown } | null)?.code === "cap_reached") {
    return {
      status: 429,
      message,
      ...(typeof retry === "number" && retry > 0 ? { retryAfterSec: Math.ceil(retry) } : {}),
    };
  }
  if (name === "PaywallError" && message) return { status: 403, message };
  if (name === "AccountSuspendedError") return { status: 403, message: "This Orbit account is suspended." };
  if (name === "UnauthorizedError" || name === "AccountHeldError" || name === "ExtensionUnauthorizedError") {
    return { status: 401, message: message && message !== "Unauthorized" ? message : "Sign in to Orbit first." };
  }
  if (name === "UserFacingError" && message) return { status: 400, message };
  const issue = zodIssue(err);
  if (issue) {
    return {
      status: 400,
      message: "That request wasn’t valid.",
      ...(issue.path ? { param: issue.path } : {}),
    };
  }
  return null;
}

function json(status: number, body: Record<string, unknown>, retryAfterSec?: number) {
  return NextResponse.json(body, {
    status,
    headers: retryAfterSec ? { "Retry-After": String(retryAfterSec) } : undefined,
  });
}

/**
 * The response for any error a route handler caught. Recognised errors answer with their
 * status and Orbit's own words; anything else is reported and answers `faultStatus` (500)
 * with the fallback and a reference only.
 */
export function routeError(err: unknown, opts: RouteErrorOptions): NextResponse {
  const known = classifyRouteError(err);
  if (known) {
    return json(
      known.status,
      { error: known.message, ...(known.param ? { param: known.param } : {}) },
      known.retryAfterSec
    );
  }
  const { error, ref } = reportedFailure(err, opts.fallback, {
    where: opts.where,
    userId: opts.userId,
    extra: opts.extra,
  });
  return json(opts.faultStatus ?? 500, ref ? { error, ref } : { error });
}

/**
 * The response for a failed sign-in / surface gate at the top of a handler: a paywall or a
 * suspended account is 403, everything else 401 with the route's own sign-in line. Faults
 * in the gate (a database blip) are also 401 here, as they always were: the gate failing
 * closed is the safe reading, and the person's next action — sign in, retry — is the same.
 */
export function authErrorResponse(err: unknown, signInMessage: string): NextResponse {
  const known = classifyRouteError(err);
  const status = known?.status === 403 ? 403 : 401;
  const message = status === 403 ? known!.message : friendlyError(err, signInMessage);
  return json(status, { error: message });
}

/** A 429 for a rate limit or a cap that was caught where the route still owns the response. */
export function rateLimitedResponse(err: { message: string; retryAfterSec?: number | null }): NextResponse {
  const retry = typeof err.retryAfterSec === "number" && err.retryAfterSec > 0 ? Math.ceil(err.retryAfterSec) : undefined;
  return json(429, { error: err.message }, retry);
}

/**
 * Run a route's rate-limit check: null when allowed, the 429 when not. Anything other than a
 * rate limit (the database being down) is rethrown, as the hand-rolled versions did.
 */
export async function rateLimitGuard(check: () => Promise<unknown>): Promise<NextResponse | null> {
  try {
    await check();
    return null;
  } catch (err) {
    const known = classifyRouteError(err);
    if (known?.status === 429) return json(429, { error: known.message }, known.retryAfterSec);
    throw err;
  }
}
