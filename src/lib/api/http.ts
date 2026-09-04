/**
 * Request plumbing for the public API: auth, limits, body reading, and one error funnel.
 *
 * Closely modelled on `src/lib/extension/http.ts`, which is the right precedent — it is the
 * existing non-browser client and solved most of these problems already. It diverges in three
 * places, each deliberate:
 *
 *   - Rate limiting goes through the shared `rate_limit_buckets` (`consumeBucket`) rather than
 *     the extension's private `extension_usage` table, because these budgets protect the
 *     database rather than an AI spend allowance.
 *   - Keys carry scopes, so every handler declares whether it reads or writes.
 *   - There is NO CORS. See `preflight` below.
 */
import { NextResponse, after } from "next/server";
import type { z } from "zod";
import { ApiAuthError, requireApiCaller, touchApiKeyLastUsed, type ApiCaller } from "@/lib/api/auth";
import type { ApiKeyScope } from "@/lib/api/keys";
import { RATE_LIMITS, RateLimitedError, consumeBucket } from "@/lib/rate-limit";

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "payment_required"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "rate_limited"
  | "server_error";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  payment_required: 402,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  server_error: 500,
};

export type ApiError = {
  code: ApiErrorCode;
  message: string;
  /** Dotted path to the offending field, e.g. `events.0.occurredAt`. */
  param?: string;
  retryAfterSeconds?: number;
};

export class ApiRequestError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly param?: string
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** Envelope deliberately identical to the extension's, so the two read as one system. */
export function apiOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true as const, data }, init);
}

export function apiError(error: ApiError) {
  const headers: Record<string, string> = {};
  if (error.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(error.retryAfterSeconds);
  }
  return NextResponse.json(
    { ok: false as const, error },
    { status: STATUS_BY_CODE[error.code], headers }
  );
}

/**
 * No `Access-Control-Allow-Origin`, on purpose.
 *
 * These endpoints authenticate with a long-lived bearer key. Allowing browser origins would
 * invite people to put `orb_live_…` into front-end code, where a single XSS — or simply
 * anyone opening devtools — exfiltrates a credential with full read/write access to their
 * entire personal network. Server-to-server callers (Zapier, Make, n8n, an MCP client) do not
 * send preflights and are unaffected.
 */
export function preflight() {
  return new NextResponse(null, { status: 204, headers: { Allow: "GET, POST, PATCH, DELETE" } });
}

const STATUS_BY_AUTH_FAILURE: Record<string, ApiErrorCode> = {
  missing: "unauthorized",
  malformed: "unauthorized",
  unknown: "unauthorized",
  revoked: "unauthorized",
  insufficient_scope: "forbidden",
  suspended: "forbidden",
  payment_required: "payment_required",
};

/** Bytes. Generous for a batch of events, tight for everything else. */
export const MAX_BODY_BYTES = 1_000_000;
export const MAX_SMALL_BODY_BYTES = 64_000;

/**
 * Read and validate a JSON body.
 *
 * `Content-Length` is checked first so an oversized request is refused without reading it,
 * then the decoded length is re-checked because that header is absent under chunked encoding
 * and can simply be wrong. The second check is load-bearing for another reason too: because a
 * proxy file exists, Next buffers request bodies in memory up to `proxyClientMaxBodySize` and
 * TRUNCATES beyond it rather than failing, so a handler that trusts the header can be handed a
 * silently short body.
 */
export async function readJson<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = MAX_SMALL_BODY_BYTES
): Promise<T> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    throw new ApiRequestError("payload_too_large", "Request body is too large.");
  }
  const raw = await request.text();
  if (raw.length > maxBytes) {
    throw new ApiRequestError("payload_too_large", "Request body is too large.");
  }

  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    throw new ApiRequestError("invalid_request", "Request body is not valid JSON.");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ApiRequestError(
      "invalid_request",
      issue?.message ?? "Request body failed validation.",
      issue?.path.join(".")
    );
  }
  return result.data;
}

export type HandlerContext = { caller: ApiCaller };

/**
 * Wraps a handler with auth, rate limiting and the single error funnel.
 *
 * The funnel is the point: every failure leaves through one place, so an internal message or
 * stack can never reach a caller by accident. Anything unrecognised becomes a flat 500.
 */
export function apiHandler(
  opts: { scope: ApiKeyScope; bucket: "apiRead" | "apiWrite" | "apiIngest" | "mcp" },
  handler: (request: Request, ctx: HandlerContext) => Promise<Response>
) {
  return async (request: Request): Promise<Response> => {
    let caller: ApiCaller;
    try {
      caller = await requireApiCaller(request, { scope: opts.scope });
    } catch (err) {
      if (err instanceof ApiAuthError) {
        return apiError({
          code: STATUS_BY_AUTH_FAILURE[err.reason] ?? "unauthorized",
          message: err.message,
        });
      }
      return apiError({ code: "server_error", message: "Authentication failed." });
    }

    try {
      // Keyed on the user, not the key: the resource being protected is their database, and
      // per-key budgets would let anyone multiply their own limit by making more keys.
      await consumeBucket(opts.bucket, caller.userId, RATE_LIMITS[opts.bucket]);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return apiError({
          code: "rate_limited",
          message: "Too many requests.",
          retryAfterSeconds: err.retryAfterSec,
        });
      }
      throw err;
    }

    // Telemetry, deferred so it can never delay or fail the response.
    after(() => touchApiKeyLastUsed(caller.keyId));

    try {
      return await handler(request, { caller });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        return apiError({ code: err.code, message: err.message, param: err.param });
      }
      // Never leak an internal message.
      return apiError({ code: "server_error", message: "Something went wrong." });
    }
  };
}
