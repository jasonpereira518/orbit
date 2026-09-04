/**
 * Shared plumbing for every `/api/extension/*` route: auth, rate limiting,
 * body-size caps, zod validation, and the single response envelope.
 *
 * Route files stay two lines plus a handler, so the security-relevant behavior
 * is defined once here rather than re-derived (and eventually forgotten) per
 * endpoint.
 */

import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { getDb } from "@/db";
import { extensionUsage } from "@/db/schema";
import { ContactNotFoundError } from "@/lib/contact-writes";
import type { ExtensionError, ExtensionErrorCode } from "./contract";
import { MAX_BODY_BYTES } from "./contract.schema";
import {
  ExtensionRateLimitError,
  ExtensionUnauthorizedError,
  requireExtensionUserId,
} from "./auth";

/** Rolling one-minute budgets, per user. */
const REQUEST_LIMIT_PER_MINUTE = 60;
/**
 * Much tighter than the general budget: these calls spend the *user's* own
 * provider credits, so a runaway extension must not be able to burn their
 * quota overnight.
 */
const AI_LIMIT_PER_MINUTE = 10;
const WINDOW_SECONDS = 60;

export type RouteCost = "request" | "ai";

class PayloadTooLargeError extends Error {}
class InvalidRequestError extends Error {}

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

const STATUS_BY_CODE: Record<ExtensionErrorCode, number> = {
  unauthorized: 401,
  invalid_request: 400,
  rate_limited: 429,
  not_found: 404,
  duplicate: 409,
  limit_exceeded: 402,
  payload_too_large: 413,
  server_error: 500,
};

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true as const, data }, init);
}

export function jsonError(error: ExtensionError, status?: number) {
  const resolved = status ?? STATUS_BY_CODE[error.code];
  const headers: Record<string, string> = {};
  if (error.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(error.retryAfterSeconds);
  }
  return NextResponse.json(
    { ok: false as const, error },
    { status: resolved, headers }
  );
}

/**
 * The extension declares `host_permissions` for the Orbit origin, so its
 * fetches are exempt from CORS and never send a preflight. This exists purely
 * so a stray preflight (a different client, a future browser change) gets a
 * clean 204 rather than a 405.
 */
export function preflight() {
  return new NextResponse(null, { status: 204 });
}

/** Thrown by a handler to return a specific error envelope. */
export class ExtensionRouteError extends Error {
  code: ExtensionErrorCode;
  candidates?: ExtensionError["candidates"];
  constructor(
    code: ExtensionErrorCode,
    message: string,
    candidates?: ExtensionError["candidates"]
  ) {
    super(message);
    this.name = "ExtensionRouteError";
    this.code = code;
    this.candidates = candidates;
  }
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Bump the caller's rolling counters and return them, in one statement.
 *
 * Both CASE expressions test `window_started_at`; in Postgres every SET
 * expression in a DO UPDATE sees the pre-update row, so the window check and
 * the counter reset stay consistent with each other.
 */
async function consumeBudget(userId: string, cost: RouteCost) {
  const db = await getDb();
  const aiCost = cost === "ai" ? 1 : 0;
  const windowExpired = (column: unknown) =>
    sql`now() - ${column} > interval '${sql.raw(String(WINDOW_SECONDS))} seconds'`;

  const [row] = await db
    .insert(extensionUsage)
    .values({
      userId,
      requestCount: 1,
      aiCount: aiCost,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: extensionUsage.userId,
      set: {
        windowStartedAt: sql`CASE WHEN ${windowExpired(extensionUsage.windowStartedAt)} THEN now() ELSE ${extensionUsage.windowStartedAt} END`,
        requestCount: sql`CASE WHEN ${windowExpired(extensionUsage.windowStartedAt)} THEN 1 ELSE ${extensionUsage.requestCount} + 1 END`,
        aiWindowStartedAt: sql`CASE WHEN ${windowExpired(extensionUsage.aiWindowStartedAt)} THEN now() ELSE ${extensionUsage.aiWindowStartedAt} END`,
        aiCount: sql`CASE WHEN ${windowExpired(extensionUsage.aiWindowStartedAt)} THEN ${aiCost} ELSE ${extensionUsage.aiCount} + ${aiCost} END`,
        lastSeenAt: sql`now()`,
      },
    })
    .returning();

  if (!row) return;

  const retryAfter = (startedAt: Date | null) => {
    const elapsed = startedAt
      ? Math.floor((Date.now() - startedAt.getTime()) / 1000)
      : 0;
    return Math.max(1, WINDOW_SECONDS - elapsed);
  };

  if (cost === "ai" && row.aiCount > AI_LIMIT_PER_MINUTE) {
    throw new ExtensionRateLimitError(
      retryAfter(row.aiWindowStartedAt),
      "Too many AI requests in a row. Give it a moment."
    );
  }
  if (row.requestCount > REQUEST_LIMIT_PER_MINUTE) {
    throw new ExtensionRateLimitError(
      retryAfter(row.windowStartedAt),
      "Too many requests. Give it a moment."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Body reading                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `next.config.ts`'s `serverActions.bodySizeLimit` does not apply to route
 * handlers, so the cap is enforced here. Content-Length is checked first to
 * reject cheaply, then the decoded length is re-checked because the header can
 * be absent under chunked encoding, or simply wrong.
 */
async function readJsonBody<T>(
  req: Request,
  schema: z.ZodType<T>,
  maxBytes: number = MAX_BODY_BYTES
): Promise<T> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    throw new PayloadTooLargeError("Request body is too large.");
  }

  const raw = await req.text();
  if (raw.length > maxBytes) {
    throw new PayloadTooLargeError("Request body is too large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidRequestError("Request body is not valid JSON.");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".");
    throw new InvalidRequestError(
      path ? `${path}: ${first.message}` : (first?.message ?? "Invalid request.")
    );
  }
  return result.data;
}

/* -------------------------------------------------------------------------- */
/* The wrapper                                                                */
/* -------------------------------------------------------------------------- */

export type RouteContext<TIn> = {
  userId: string;
  input: TIn;
  req: Request;
};

function toErrorResponse(error: unknown) {
  if (error instanceof ExtensionUnauthorizedError) {
    return jsonError({ code: "unauthorized", message: error.message });
  }
  if (error instanceof ExtensionRateLimitError) {
    return jsonError({
      code: "rate_limited",
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }
  if (error instanceof PayloadTooLargeError) {
    return jsonError({ code: "payload_too_large", message: error.message });
  }
  if (error instanceof InvalidRequestError) {
    return jsonError({ code: "invalid_request", message: error.message });
  }
  if (error instanceof ContactNotFoundError) {
    return jsonError({ code: "not_found", message: "Contact not found." });
  }
  if (error instanceof ExtensionRouteError) {
    return jsonError({
      code: error.code,
      message: error.message,
      candidates: error.candidates,
    });
  }

  // Never leak internals to the extension; the detail goes to the server log.
  console.error("[extension] unhandled route error", error);
  return jsonError({
    code: "server_error",
    message: "Orbit is having a moment. Try again.",
  });
}

/**
 * Build a route handler that authenticates, throttles, validates, and wraps the
 * result in the standard envelope.
 *
 * `schema` is omitted for GET/DELETE routes that take no body.
 */
export function extensionRoute<TIn, TOut>(config: {
  schema?: z.ZodType<TIn>;
  cost?: RouteCost;
  /** Defaults to MAX_BODY_BYTES. Raised only by routes that carry whole page sections. */
  maxBodyBytes?: number;
  handler: (ctx: RouteContext<TIn>) => Promise<TOut>;
}) {
  return async function handle(req: Request) {
    try {
      const userId = await requireExtensionUserId(req);
      await consumeBudget(userId, config.cost ?? "request");

      const input = config.schema
        ? await readJsonBody(req, config.schema, config.maxBodyBytes)
        : (undefined as TIn);

      const data = await config.handler({ userId, input, req });
      return jsonOk(data);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}
