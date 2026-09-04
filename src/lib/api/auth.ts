/**
 * The only place the public API and MCP server decide who is calling.
 *
 * One file, on purpose, mirroring `src/lib/extension/auth.ts`: an authentication path that
 * exists in several handlers is one that will eventually differ between them.
 *
 * ## The order of the checks is the design
 *
 * A malformed bearer is rejected on a regex, before any query. That matters because these
 * routes are exempt from Clerk's `auth.protect()` — anyone on the internet can reach them, so
 * the cost of an unauthenticated request has to be near zero or the endpoint is a free way to
 * make Orbit do database work.
 *
 * Then exactly one indexed lookup, then revocation, then scope, then suspension, then the
 * paywall. Cheapest and most decisive first.
 *
 * ## What this deliberately does NOT do
 *
 * It never calls `requireUserId()`. That helper goes to Clerk for a session, and an API key
 * request has none — it would fail for every legitimate caller. It also never resolves an
 * unauthenticated caller to `demo-user` the way `requireUserId` does in demo mode: that
 * shortcut is safe for a local browser session and would be a wide-open write API here. The
 * reasoning is the same one `devUserId` in the extension's auth module already records.
 *
 * And it does not call `requireEntitlement()`. That writes a `gate_events` row on every
 * denial, so one lapsed subscriber whose Zapier polls every five minutes would write ~300
 * rows a day and drown the very signal that table exists to collect. Gate hits from the
 * request path go through the throttle instead; the unthrottled version is correct in the
 * key-issuance actions, which a human triggers.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { bearerFrom, hashApiKey, looksLikeApiKey, type ApiKeyScope } from "@/lib/api/keys";
import { getEntitlements } from "@/lib/entitlements";
import { ensureUserSettings } from "@/lib/user-settings";

export type ApiCaller = {
  userId: string;
  keyId: string;
  prefix: string;
  scopes: ApiKeyScope[];
};

export type ApiAuthFailure =
  | "missing"
  | "malformed"
  | "unknown"
  | "revoked"
  | "insufficient_scope"
  | "suspended"
  | "payment_required";

export class ApiAuthError extends Error {
  constructor(
    readonly reason: ApiAuthFailure,
    message: string
  ) {
    super(message);
    this.name = "ApiAuthError";
  }
}

/**
 * Resolve a credential to a caller, or throw.
 *
 * `token` may be supplied directly for the MCP path-token route, where the credential is a
 * URL segment rather than a header — claude.ai's connector UI has no custom-header field.
 */
export async function requireApiCaller(
  request: Request,
  opts: { scope: ApiKeyScope; token?: string }
): Promise<ApiCaller> {
  const token = opts.token ?? bearerFrom(request.headers.get("authorization"));
  if (!token) {
    throw new ApiAuthError("missing", "Provide an Orbit API key as a bearer token.");
  }
  if (!looksLikeApiKey(token)) {
    // Shape-only rejection, no database work. See this file's header.
    throw new ApiAuthError("malformed", "That is not a valid Orbit API key.");
  }

  const db = await getDb();
  const row = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, hashApiKey(token)),
    columns: {
      id: true,
      userId: true,
      prefix: true,
      scopes: true,
      revokedAt: true,
    },
  });
  if (!row) {
    throw new ApiAuthError("unknown", "That API key is not recognised.");
  }
  if (row.revokedAt) {
    throw new ApiAuthError("revoked", "That API key has been revoked.");
  }

  const scopes = (row.scopes ?? ["read"]) as ApiKeyScope[];
  // A read key must never write. Write implies read, so only the write case is checked.
  if (opts.scope === "write" && !scopes.includes("write")) {
    throw new ApiAuthError(
      "insufficient_scope",
      "That API key is read-only. Create a key with write access to make changes."
    );
  }

  const settings = await ensureUserSettings(row.userId);
  if (settings.suspendedAt) {
    throw new ApiAuthError("suspended", "This Orbit account is suspended.");
  }

  const entitlements = await getEntitlements(row.userId);
  if (!entitlements.canUseApi) {
    throw new ApiAuthError(
      "payment_required",
      "The Orbit API, webhooks and MCP server are available on Orbit Pro and Orbit Lifetime."
    );
  }

  return { userId: row.userId, keyId: row.id, prefix: row.prefix, scopes };
}

/**
 * Stamp "this key was used", at most once a minute.
 *
 * The throttle is in the WHERE clause rather than in a read-then-write, so it costs one
 * statement and cannot race. Without it this is an extra write on every API request, which on
 * a polled integration is thousands of pointless writes a day for a timestamp nobody reads at
 * that resolution.
 *
 * Call it from `after()`: it is telemetry, and must never delay or fail a response.
 */
export async function touchApiKeyLastUsed(keyId: string): Promise<void> {
  try {
    const db = await getDb();
    await db.execute(sql`
      UPDATE api_keys SET last_used_at = now()
       WHERE id = ${keyId}
         AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
    `);
  } catch {
    // Telemetry only.
  }
}
