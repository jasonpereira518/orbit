import { count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { webhookEndpoints } from "@/db/schema";

/**
 * Endpoints one account may register.
 *
 * Deliveries drain from one shared, oldest-first queue with a per-attempt timeout, so an
 * account with hundreds of endpoints that accept the verification ping and then hang could
 * hold the drain for every other customer until its own retries ran out — days. Ten covers
 * a Zapier plus a Make plus a few of one's own.
 */
export const MAX_WEBHOOK_ENDPOINTS_PER_USER = 10;

export const WEBHOOK_ENDPOINT_LIMIT_MESSAGE = `You can register up to ${MAX_WEBHOOK_ENDPOINTS_PER_USER} webhook endpoints. Delete one to add another.`;

export async function hasWebhookEndpointCapacity(userId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ n: count() })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.userId, userId));
  return (row?.n ?? 0) < MAX_WEBHOOK_ENDPOINTS_PER_USER;
}
