"use server";

/**
 * Issuing, listing and revoking API keys.
 *
 * Every export in this file must be an async function: a single non-async export in a
 * `"use server"` module breaks every export in it, and `tsc` will not tell you.
 *
 * These run `requireEntitlement` in full, unlike the request path in `src/lib/api/auth.ts`.
 * That is the right call here and the wrong one there: a person clicking "create key" is
 * exactly the demand signal `gate_events` exists to record, whereas a lapsed subscriber's
 * integration polling every five minutes would write hundreds of identical rows a day and
 * bury it.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { isPaywallError, requireEntitlement } from "@/lib/entitlements";
import { generateApiKey, type ApiKeyKind, type ApiKeyScope } from "@/lib/api/keys";
import { getAppBaseUrl } from "@/lib/app-url";

export type ApiKeySummary = {
  id: string;
  name: string;
  kind: ApiKeyKind;
  /** Public half only. The secret is unrecoverable by design. */
  prefix: string;
  scopes: ApiKeyScope[];
  lastUsedAt: Date | null;
  createdAt: Date;
};

export async function listApiKeys(): Promise<ApiKeySummary[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await db.query.apiKeys.findMany({
    where: and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)),
    orderBy: [desc(apiKeys.createdAt)],
    columns: {
      id: true,
      name: true,
      kind: true,
      prefix: true,
      scopes: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    prefix: r.prefix,
    scopes: (r.scopes ?? ["read"]) as ApiKeyScope[],
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
  }));
}

/**
 * A refusal the UI can act on.
 *
 * Returned rather than thrown, because Next redacts a thrown server-action error's message
 * before it reaches the browser — the client would see a digest and could only say "something
 * went wrong", which for a paywall is the least useful thing to say. The demand signal is not
 * lost: `requireEntitlement` writes the `gate_events` row before it throws, and this catches
 * it afterwards.
 */
export type ApiKeyRefusal = { ok: false; reason: "payment_required"; message: string };

export type CreatedApiKey = {
  ok: true;
  summary: ApiKeySummary;
  /**
   * The full key. Returned exactly once, here, and never stored — only its SHA-256 hash is.
   * If the user loses it they must create another; there is no recovery path, deliberately.
   */
  token: string;
  /** For an `mcp_url` key, the ready-to-paste endpoint. */
  mcpUrl: string | null;
};

export async function createApiKey(
  name: string,
  scopes: ApiKeyScope[],
  kind: ApiKeyKind = "api"
): Promise<CreatedApiKey | ApiKeyRefusal> {
  const userId = await requireUserId();
  try {
    await requireEntitlement(userId, "api");
  } catch (err) {
    if (isPaywallError(err)) {
      return { ok: false, reason: "payment_required", message: err.message };
    }
    throw err;
  }

  const trimmed = name.trim().slice(0, 80) || "Untitled key";
  // Always include read: a write-only key is not a distinction anything here honours, and
  // pretending otherwise would produce a key that fails in confusing ways.
  const resolved: ApiKeyScope[] = scopes.includes("write") ? ["read", "write"] : ["read"];

  const key = generateApiKey(kind);
  const db = await getDb();
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      name: trimmed,
      kind,
      prefix: key.prefix,
      keyHash: key.keyHash,
      scopes: resolved,
    })
    .returning();

  revalidatePath("/settings");
  return {
    ok: true,
    summary: {
      id: row.id,
      name: row.name,
      kind: row.kind,
      prefix: row.prefix,
      scopes: resolved,
      lastUsedAt: null,
      createdAt: row.createdAt,
    },
    token: key.token,
    mcpUrl: kind === "mcp_url" ? `${getAppBaseUrl()}/api/mcp/${key.token}` : null,
  };
}

/**
 * Revoke a key.
 *
 * Soft-deleted rather than removed: `revoked_at` keeps the row so `last_used_at` remains
 * visible afterwards, which is what someone revoking a key they no longer recognise actually
 * wants to see. The verifier rejects any row with `revoked_at` set, so revocation is immediate
 * regardless.
 */
export async function revokeApiKey(id: string): Promise<{ ok: true }> {
  const userId = await requireUserId();
  const db = await getDb();
  await db
    .update(apiKeys)
    // Scoped by userId as well as id, so one user can never revoke another's key.
    .set({ revokedAt: new Date(), revokedReason: "revoked by user" })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)));
  revalidatePath("/settings");
  return { ok: true };
}
