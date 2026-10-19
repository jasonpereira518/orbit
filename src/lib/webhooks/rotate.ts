import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { webhookEndpoints } from "@/db/schema";
import { recordAccountAudit } from "@/lib/account-audit";
import { encrypt } from "@/lib/crypto";
import { generateWebhookSecret } from "@/lib/webhooks/sign";

export type RotateWebhookSecretResult = { ok: true; secret: string } | { ok: false; message: string };

/**
 * Replace an endpoint's signing secret (audit L-19). Owner-scoped: the update matches the id
 * AND the user, so one account can never rotate another's. The new secret is returned once,
 * here, exactly like on create; only its ciphertext is stored.
 *
 * The switch is immediate: every delivery from now on, including retries of ones already
 * queued, is signed with the new secret, so the receiver has to be updated with it.
 */
export async function rotateWebhookEndpointSecret(userId: string, endpointId: string): Promise<RotateWebhookSecretResult> {
  const secret = generateWebhookSecret();
  const db = await getDb();
  const rows = await db
    .update(webhookEndpoints)
    .set({ secretEncrypted: encrypt(secret), updatedAt: new Date() })
    .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.userId, userId)))
    .returning();
  if (rows.length === 0) return { ok: false, message: "No such endpoint" };
  await recordAccountAudit({ userId, action: "webhook.secret_rotate", resourceType: "webhook_endpoint", resourceId: endpointId });
  return { ok: true, secret };
}
