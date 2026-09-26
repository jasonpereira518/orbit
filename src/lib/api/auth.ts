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
import { entitlementsFromSettings, type Entitlements } from "@/lib/entitlements";
import { ensureUserSettings } from "@/lib/user-settings";
import { isHeldByStealth } from "@/lib/site-access";

export type ApiCaller = {
  userId: string;
  keyId: string;
  prefix: string;
  scopes: ApiKeyScope[];
  /** Resolved from the settings row the suspension check read, so callers need not re-read it. */
  entitlements: Entitlements;
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
  opts: { scope: ApiKeyScope; token?: string; surface?: "api" | "mcp" }
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
      kind: true,
    },
  });
  if (!row) {
    throw new ApiAuthError("unknown", "That API key is not recognised.");
  }
  if (row.revokedAt) {
    throw new ApiAuthError("revoked", "That API key has been revoked.");
  }

  // A connector key is minted to sit in a URL, where proxies, browser history and logs see
  // it. It is good for the MCP connector and nothing else — never the REST API or webhooks.
  if (row.kind === "mcp_url" && opts.surface !== "mcp") {
    throw new ApiAuthError("unknown", "That key only works as an MCP connector URL.");
  }

  const scopes = (row.scopes ?? ["read"]) as ApiKeyScope[];
  // A read key must never write. Write implies read, so only the write case is checked.
  if (opts.scope === "write" && !scopes.includes("write")) {
    throw new ApiAuthError(
      "insufficient_scope",
      "That API key is read-only. Create a key with write access to make changes."
    );
  }

  const entitlements = await assertAccountUsable(row.userId, { surface: opts.surface });

  return { userId: row.userId, keyId: row.id, prefix: row.prefix, scopes, entitlements };
}

/**
 * The two account-level refusals that apply however the caller authenticated.
 *
 * Separate from the key lookup above because the MCP server also reaches here with a Clerk
 * OAuth token, which has no `api_keys` row — and a suspended account must be refused on both
 * paths or the check is decorative.
 *
 * Returns the caller's entitlements, resolved from the same settings row. `getEntitlements`
 * would read that row again: `cache()` does not deduplicate in a route handler, so every
 * MCP message paid for the same `user_settings` read three times, one after another.
 */
export async function assertAccountUsable(
  userId: string,
  opts: { surface?: "api" | "mcp" } = {}
): Promise<Entitlements> {
  const settings = await ensureUserSettings(userId);
  if (settings.suspendedAt) {
    throw new ApiAuthError("suspended", "This Orbit account is suspended.");
  }
  // An account stealth is holding is not signed in anywhere else in the app; a key or an
  // OAuth grant must not be the way around that.
  if (await isHeldByStealth(userId, settings)) {
    throw new ApiAuthError("suspended", "This account is waiting for an invitation.");
  }

  const entitlements = entitlementsFromSettings(userId, settings);
  // The MCP server is free on every plan; the REST API and webhooks are not. Two flags
  // rather than one so that making the connector free cannot quietly open the paid surfaces
  // beside it — see `canUseMcp` in `entitlements.ts`.
  const allowed = opts.surface === "mcp" ? entitlements.canUseMcp : entitlements.canUseApi;
  if (!allowed) {
    throw new ApiAuthError(
      "payment_required",
      "The Orbit API and webhooks are available on Orbit Pro and Orbit Lifetime."
    );
  }
  return entitlements;
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
