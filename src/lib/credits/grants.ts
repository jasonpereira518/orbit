import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { creditGrants } from "@/db/schema";

/**
 * Writing credit grants: packs bought, packs taken back. (Allowances and spending live in
 * the rest of `src/lib/credits/`.) See `creditGrants` in `src/db/schema.ts` for the model:
 * the grant rows are the balance, and nothing here ever deletes one.
 *
 * No `next/server` and no Stripe: the webhook route, verify-on-return and tsx scripts all
 * reach this module.
 */

/** 1 credit = $0.01 of model cost = 10,000 cost-micros. */
export const MICROS_PER_CREDIT = 10_000;

export function creditsToMicros(credits: number): number {
  return Math.round(credits * MICROS_PER_CREDIT);
}

export function microsToCredits(micros: number): number {
  return micros / MICROS_PER_CREDIT;
}

/**
 * Grant a purchased pack, exactly once. `grantKey` is `pack:cs:<checkout session>`, so the
 * webhook, its retries and the verify-on-return path all collapse onto one row.
 * Returns true only for the call that actually created it.
 */
export async function grantPack(input: {
  userId: string;
  grantKey: string;
  stripeRef: string;
  amountCents: number;
  credits: number;
}): Promise<boolean> {
  const db = await getDb();
  const micros = creditsToMicros(input.credits);
  const inserted = await db
    .insert(creditGrants)
    .values({
      userId: input.userId,
      kind: "pack",
      grantKey: input.grantKey,
      microsGranted: micros,
      microsRemaining: micros,
      amountCents: input.amountCents,
      stripeRef: input.stripeRef,
    })
    .onConflictDoNothing({ target: creditGrants.grantKey })
    // Bare: an explicit field selector defeats Drizzle's overloads (see contact-identity.ts).
    .returning();
  return inserted.length > 0;
}

/**
 * A pack's payment was refunded in full or lost in a dispute: take back what is left of it.
 * Credits already spent stay spent. Idempotent — a second refund event finds the grant
 * already revoked and changes nothing. Returns the micros taken back (0 when none).
 */
export async function revokePack(input: {
  userId: string;
  paymentIntentId: string;
  reason: "refund" | "dispute_lost";
}): Promise<number> {
  const db = await getDb();
  const rows = await db
    .update(creditGrants)
    .set({
      status: "revoked",
      revokedAt: new Date(),
      revokedReason: input.reason,
      microsRevoked: sql`${creditGrants.microsRemaining}`,
      microsRemaining: 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(creditGrants.userId, input.userId),
        eq(creditGrants.kind, "pack"),
        eq(creditGrants.stripeRef, input.paymentIntentId),
        eq(creditGrants.status, "active")
      )
    )
    .returning();
  return rows.reduce((sum, row) => sum + (row.microsRevoked ?? 0), 0);
}
