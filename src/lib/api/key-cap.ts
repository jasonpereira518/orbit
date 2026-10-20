/**
 * How many live API keys (and MCP URLs) one account may hold (audit L-22).
 *
 * Kept out of `keys.ts`, which is pure crypto by design. A count rather than a bucket: what is
 * bounded is how many working credentials exist at once, not how fast they are made, and
 * revoking one frees a slot. Ten is several integrations' worth; nobody wiring Orbit into
 * their own tools needs more live at once. Follows `ORBIT_NEW_LIMITS=log` like the other
 * post-launch limits (see `src/lib/rate-limit.ts`).
 */
import { and, count, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { MAX_ACTIVE_API_KEYS, softenedLimit } from "@/lib/rate-limit";

export const API_KEY_CAP_MESSAGE = `You have ${MAX_ACTIVE_API_KEYS} active keys, the most an account can hold. Revoke one you no longer use first.`;

/** The refusal copy when the account is at its cap, or null when another key may be made. */
export async function apiKeyCapRefusal(userId: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ n: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
  const active = Number(row?.n ?? 0);
  if (active < MAX_ACTIVE_API_KEYS) return null;
  if (softenedLimit("apiKeyCap", userId, `active=${active} limit=${MAX_ACTIVE_API_KEYS}`)) return null;
  return API_KEY_CAP_MESSAGE;
}
