import { and, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups, userSettings } from "@/db/schema";
import {
  asWelcomePlanet,
  buildUnsubscribeUrl,
  sendInterestListFollowUpEmail,
} from "@/lib/interest-list-email";

/**
 * How long a signup waits before the follow-up. Long enough that the welcome note is no
 * longer in view, short enough that Orbit is still why they gave up an address.
 */
export const FOLLOW_UP_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Ceiling on one sweep. The cron this rides on runs daily, so a backlog drains over days
 * rather than firing hundreds of messages from a cold domain in one burst — which is how
 * new sending domains get throttled.
 */
export const FOLLOW_UP_BATCH_LIMIT = 25;

export type FollowUpSweepStats = {
  eligible: number;
  sent: number;
  failed: number;
};

/**
 * Sends the day-3 follow-up to everyone still owed one.
 *
 * WHO IS EXCLUDED, and why each exclusion is in the SQL rather than in the loop:
 *   - anyone who unsubscribed
 *   - anyone already sent one (`follow_up_sent_at`)
 *   - anyone who went on to create an account, matched against the `user_settings.email`
 *     mirror the Clerk webhook maintains. This is the one that matters: mailing "here's a
 *     tip for getting started" to somebody who signed up two days ago reads as a product
 *     that does not know its own users.
 *
 * Converted rows are deliberately never stamped. `follow_up_sent_at` means "we sent it",
 * so writing it for someone we suppressed would be a lie recorded in the table; leaving
 * them unstamped costs one more row scanned per day and keeps the column honest.
 *
 * AT-MOST-ONCE, NOT AT-LEAST-ONCE. Each row is claimed with a conditional UPDATE before
 * its message is built, so two overlapping runs cannot both take the same person, and a
 * crash mid-batch loses a send rather than repeating one. A send that fails releases its
 * claim so the next day retries it.
 */
export async function sweepInterestListFollowUps(): Promise<FollowUpSweepStats> {
  const db = await getDb();
  const stats: FollowUpSweepStats = { eligible: 0, sent: 0, failed: 0 };

  const cutoff = new Date(Date.now() - FOLLOW_UP_DELAY_MS);

  const candidates = await db
    .select({
      id: interestListSignups.id,
      email: interestListSignups.email,
      unsubscribeToken: interestListSignups.unsubscribeToken,
      welcomePlanet: interestListSignups.welcomePlanet,
    })
    .from(interestListSignups)
    .where(
      and(
        isNull(interestListSignups.followUpSentAt),
        isNull(interestListSignups.unsubscribedAt),
        lt(interestListSignups.createdAt, cutoff),
        notExists(
          db
            .select({ one: sql`1` })
            .from(userSettings)
            // Both sides are already lowercased on write — the signup action normalises,
            // and the Clerk webhook lowercases before mirroring — but this is mirrored
            // data with no unique constraint, so the comparison does not assume it.
            .where(eq(sql`lower(${userSettings.email})`, interestListSignups.email))
        )
      )
    )
    .limit(FOLLOW_UP_BATCH_LIMIT);

  stats.eligible = candidates.length;

  for (const row of candidates) {
    // Claim first. The `IS NULL` guard is what makes this safe under a concurrent run:
    // whoever updates the row first gets a returned row, the loser gets none and skips.
    const claimed = await db
      .update(interestListSignups)
      .set({ followUpSentAt: new Date() })
      .where(
        and(eq(interestListSignups.id, row.id), isNull(interestListSignups.followUpSentAt))
      )
      .returning();

    if (!claimed[0]) continue;

    const ok = await sendInterestListFollowUpEmail(
      row.email,
      buildUnsubscribeUrl(row.unsubscribeToken),
      asWelcomePlanet(row.welcomePlanet)
    );

    if (ok) {
      stats.sent += 1;
    } else {
      stats.failed += 1;
      // Release the claim so tomorrow's run picks it up again. A send that never happened
      // must not leave the row looking like it did.
      await db
        .update(interestListSignups)
        .set({ followUpSentAt: null })
        .where(eq(interestListSignups.id, row.id));
    }
  }

  return stats;
}
