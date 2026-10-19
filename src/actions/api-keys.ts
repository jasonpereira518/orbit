"use server";

/**
 * Issuing, listing and revoking API keys.
 *
 * Every export in this file must be an async function: a single non-async export in a
 * `"use server"` module breaks every export in it, and `tsc` will not tell you.
 *
 * The `mcp_url` kind is deprecated as of the OAuth connector. Settings no longer offers it —
 * claude.ai gained OAuth, which was the only reason a credential ever travelled in a URL —
 * but the kind, the keys already minted under it and `/api/mcp/[token]` all keep working, so
 * nobody's connector breaks on deploy. Remove all three once the last one goes unused.
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
import { isPaywallError, requireEntitlement } from "@/lib/entitlements";
import { generateApiKey, type ApiKeyKind, type ApiKeyScope } from "@/lib/api/keys";
import { apiKeyCapRefusal } from "@/lib/api/key-cap";
import { getAppBaseUrl } from "@/lib/app-url";
import { recordAccountAudit } from "@/lib/account-audit";
import { z } from "zod";
import { defineAction } from "@/lib/input/action";

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

export const listApiKeys = defineAction(
  {},
  async (userId): Promise<ApiKeySummary[]> => {
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
);

/**
 * A refusal the UI can act on.
 *
 * Returned rather than thrown, because Next redacts a thrown server-action error's message
 * before it reaches the browser — the client would see a digest and could only say "something
 * went wrong", which for a paywall is the least useful thing to say. The demand signal is not
 * lost: `requireEntitlement` writes the `gate_events` row before it throws, and this catches
 * it afterwards.
 */
export type ApiKeyRefusal = { ok: false; reason: "payment_required" | "limit_reached"; message: string };

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

export const createApiKey = defineAction(
  { schema: z.tuple([z.string(), z.array(z.enum(["read", "write"])), z.enum(["api", "mcp_url"]).optional()]) },
  async (userId, name: string, scopes: ApiKeyScope[], kind: ApiKeyKind = "api"): Promise<CreatedApiKey | ApiKeyRefusal> => {
    try {
      await requireEntitlement(userId, "api");
    } catch (err) {
      if (isPaywallError(err)) {
        return { ok: false, reason: "payment_required", message: err.message };
      }
      throw err;
    }
    const atCap = await apiKeyCapRefusal(userId);
    if (atCap) return { ok: false, reason: "limit_reached", message: atCap };

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
    await recordAccountAudit({ userId, action: "api_key.create", resourceType: "api_key", resourceId: row.id, detail: { kind, prefix: key.prefix, scopes: resolved } });

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
);

/**
 * Revoke a key.
 *
 * Soft-deleted rather than removed: `revoked_at` keeps the row so `last_used_at` remains
 * visible afterwards, which is what someone revoking a key they no longer recognise actually
 * wants to see. The verifier rejects any row with `revoked_at` set, so revocation is immediate
 * regardless.
 */
export const revokeApiKey = defineAction(
  { schema: z.tuple([z.string()]) },
  async (userId, id: string): Promise<{ ok: true }> => {
    const db = await getDb();
    await db
      .update(apiKeys)
      // Scoped by userId as well as id, so one user can never revoke another's key.
      .set({ revokedAt: new Date(), revokedReason: "revoked by user" })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)));
    await recordAccountAudit({ userId, action: "api_key.revoke", resourceType: "api_key", resourceId: id });
    revalidatePath("/settings");
    return { ok: true };
  }
);
