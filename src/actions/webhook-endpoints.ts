"use server";

/**
 * Webhook endpoints, from the Settings panel.
 *
 * The same operations the REST routes expose, because a person setting one up by hand needs
 * the same verification handshake a Zapier subscribe gets — an endpoint that registers without
 * being proven reachable is the failure mode this whole flow exists to prevent.
 *
 * Every export must be async: one non-async export in a `"use server"` module breaks every
 * export in it, and `tsc` will not tell you.
 */
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { webhookEndpoints } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { isPaywallError, requireEntitlement } from "@/lib/entitlements";
import { encrypt } from "@/lib/crypto";
import { generateWebhookSecret } from "@/lib/webhooks/sign";
import { assertDeliverable, verifyEndpoint } from "@/lib/webhooks/dispatch";

export type WebhookEndpointSummary = {
  id: string;
  url: string;
  eventTypes: string[];
  status: "pending" | "active" | "disabled";
  disabledReason: string | null;
  createdAt: Date;
};

export async function listWebhookEndpoints(): Promise<WebhookEndpointSummary[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await db.query.webhookEndpoints.findMany({
    where: eq(webhookEndpoints.userId, userId),
    orderBy: [desc(webhookEndpoints.createdAt)],
    columns: {
      id: true,
      url: true,
      eventTypes: true,
      status: true,
      disabledReason: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({ ...r, eventTypes: r.eventTypes ?? [] }));
}

export type WebhookCreateResult =
  | {
      ok: true;
      endpoint: WebhookEndpointSummary;
      /** Shown once. The receiver needs it to validate `Orbit-Signature`. */
      secret: string;
      verified: boolean;
      verificationError: string | null;
    }
  | { ok: false; message: string };

export async function createWebhookEndpoint(
  url: string,
  eventTypes: string[]
): Promise<WebhookCreateResult> {
  const userId = await requireUserId();
  try {
    await requireEntitlement(userId, "api");
  } catch (err) {
    // Returned rather than thrown — Next redacts a thrown action's message, and "something
    // went wrong" is the least useful thing to say to someone who needs to upgrade.
    if (isPaywallError(err)) return { ok: false, message: err.message };
    throw err;
  }

  if (eventTypes.length === 0) {
    return { ok: false, message: "Choose at least one event to send." };
  }
  try {
    await assertDeliverable(url);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "That URL cannot be used.",
    };
  }

  const db = await getDb();
  const secret = generateWebhookSecret();
  const [created] = await db
    .insert(webhookEndpoints)
    .values({
      userId,
      url,
      secretEncrypted: encrypt(secret),
      eventTypes,
      status: "pending",
    })
    .returning();

  const verified = await verifyEndpoint(created.id);
  revalidatePath("/settings");
  return {
    ok: true,
    endpoint: {
      id: created.id,
      url: created.url,
      eventTypes,
      status: verified.ok ? "active" : "pending",
      disabledReason: null,
      createdAt: created.createdAt,
    },
    secret,
    verified: verified.ok,
    verificationError: verified.ok ? null : (verified.error ?? null),
  };
}

export async function deleteWebhookEndpoint(id: string): Promise<{ ok: true }> {
  const userId = await requireUserId();
  const db = await getDb();
  await db
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.userId, userId)));
  revalidatePath("/settings");
  return { ok: true };
}

/** Re-run the handshake for an endpoint that was disabled or never verified. */
export async function retryWebhookEndpoint(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserId();
  const db = await getDb();
  const owned = await db.query.webhookEndpoints.findFirst({
    where: and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.userId, userId)),
    columns: { id: true },
  });
  if (!owned) return { ok: false, error: "No such endpoint." };
  const result = await verifyEndpoint(id);
  revalidatePath("/settings");
  return result;
}
