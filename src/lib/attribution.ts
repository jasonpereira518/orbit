import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import type { Attribution } from "@/lib/attribution-parse";

/**
 * Persisting where an account came from.
 *
 * FIRST TOUCH, NOT LAST. Someone who follows a Reddit link, reads for a week, then types
 * the URL directly and signs up was acquired by Reddit — last-touch would credit "direct"
 * and quietly erase the only channel that actually worked. The values are captured by
 * middleware into a cookie (`src/proxy.ts`) and written exactly once here.
 *
 * Parsing lives in `attribution-parse.ts` so middleware can reach it without pulling the
 * database into its bundle. See that file.
 */

const EMPTY: Attribution = {
  referrer: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  landingPath: null,
};

/**
 * Write the first touch, once.
 *
 * The `signup_attributed_at IS NULL` predicate in the WHERE clause is what makes this
 * write-once, and it is enforced in SQL rather than by reading first: two concurrent
 * requests from the same new user would otherwise both see null and both write.
 *
 * Returns whether it claimed the row, so the caller can clear the cookie and stop paying
 * for this on every subsequent request.
 */
export async function recordFirstTouch(
  userId: string,
  attribution: Attribution
): Promise<boolean> {
  try {
    const db = await getDb();
    const rows = await db
      .update(userSettings)
      .set({
        signupReferrer: attribution.referrer,
        signupUtmSource: attribution.utmSource,
        signupUtmMedium: attribution.utmMedium,
        signupUtmCampaign: attribution.utmCampaign,
        signupLandingPath: attribution.landingPath,
        signupAttributedAt: new Date(),
      })
      .where(
        and(
          eq(userSettings.userId, userId),
          isNull(userSettings.signupAttributedAt)
        )
      )
      .returning();

    return rows.length > 0;
  } catch {
    // Knowing where a user came from is never worth failing their first page load over.
    return false;
  }
}

/**
 * Mark an account attributed with no channel — a genuine direct visit.
 *
 * Without this, "arrived directly" and "signed up before attribution existed" are the same
 * row shape, and every channel rollup silently mixes a real segment with a historical gap.
 */
export async function recordDirectVisit(userId: string): Promise<boolean> {
  return recordFirstTouch(userId, EMPTY);
}

/** The channel label for one account, as the rollup groups it. */
export function channelOf(row: {
  signupUtmSource?: string | null;
  signupReferrer?: string | null;
  signupAttributedAt?: Date | null;
}): string {
  if (row.signupUtmSource) return row.signupUtmSource;
  if (row.signupReferrer) return row.signupReferrer;
  // The distinction the `attributedAt` column exists to preserve.
  return row.signupAttributedAt ? "direct" : "unattributed";
}
