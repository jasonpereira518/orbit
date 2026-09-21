/**
 * Shared plumbing for every `/api/extension/*` route: auth, rate limiting,
 * body-size caps, zod validation, and the single response envelope.
 *
 * Route files stay two lines plus a handler, so the security-relevant behavior
 * is defined once here rather than re-derived (and eventually forgotten) per
 * endpoint.
 */

import { sql } from "drizzle-orm";
import { after, NextResponse } from "next/server";
import type { z } from "zod";
import { getDb } from "@/db";
import { extensionUsage } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import { ContactNotFoundError } from "@/lib/contact-writes";
import { getEntitlements, type Entitlements } from "@/lib/entitlements";
import { recordExtensionGateHit } from "@/lib/gate-events";
import type { ExtensionError, ExtensionErrorCode, ExtensionFeature } from "./contract";
import {
  extensionFeatures,
  extensionUpgradeUrl,
  FEATURE_LOCKED_COPY,
} from "./entitlements";
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
  // 402 like every other paywall in the app (and `limit_exceeded` here). Not 403:
  // clients read 401/403 as "sign in again", and this user is signed in fine.
  feature_locked: 402,
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
  feature?: ExtensionFeature;
  upgradeUrl?: string;
  constructor(
    code: ExtensionErrorCode,
    message: string,
    candidates?: ExtensionError["candidates"],
    extra?: { feature?: ExtensionFeature; upgradeUrl?: string }
  ) {
    super(message);
    this.name = "ExtensionRouteError";
    this.code = code;
    this.candidates = candidates;
    this.feature = extra?.feature;
    this.upgradeUrl = extra?.upgradeUrl;
  }
}

/**
 * `after()` when there is a request to hang it on, otherwise run it now.
 *
 * `after()` throws outside a request scope, which made every route that defers
 * work (embeddings, briefs, revalidation after a save) impossible to drive from
 * a smoke script. Routes hand this to the write core instead of bare `after`.
 */
export function deferSafely(work: () => Promise<unknown>) {
  try {
    after(work);
  } catch {
    void work().catch(() => null);
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
  maxBytes = MAX_BODY_BYTES
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
  /** Resolved once per request. Routes serving both tiers branch on this. */
  entitlements: Entitlements;
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
      feature: error.feature,
      upgradeUrl: error.upgradeUrl,
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
  /**
   * A Pro feature the WHOLE route is. Routes that serve both tiers (a free
   * answer plus a paid one) leave this off and branch on `ctx.entitlements`.
   */
  entitlement?: ExtensionFeature;
  /** Defaults to `MAX_BODY_BYTES`. Raise only for a route that needs it. */
  maxBodyBytes?: number;
  handler: (ctx: RouteContext<TIn>) => Promise<TOut>;
}) {
  return async function handle(req: Request) {
    try {
      const userId = await requireExtensionUserId(req);
      await consumeBudget(userId, config.cost ?? "request");
      const entitlements = await getEntitlements(userId);

      // Before the body is read: a locked 200KB request is refused without
      // parsing it. A current panel never gets here — it reads the same
      // `extensionFeatures` from /me and draws the lock itself — so this is
      // the backstop for older builds and for anything not using the panel.
      if (config.entitlement && !extensionFeatures(entitlements)[config.entitlement]) {
        await recordExtensionGateHit({
          userId,
          plan: entitlements.plan,
          feature: config.entitlement,
          context: { route: new URL(req.url).pathname },
        });
        throw new ExtensionRouteError(
          "feature_locked",
          FEATURE_LOCKED_COPY[config.entitlement],
          undefined,
          {
            feature: config.entitlement,
            upgradeUrl: extensionUpgradeUrl(getAppBaseUrl(), config.entitlement),
          }
        );
      }

      const input = config.schema
        ? await readJsonBody(req, config.schema, config.maxBodyBytes)
        : (undefined as TIn);

      const data = await config.handler({ userId, input, req, entitlements });
      return jsonOk(data);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}
