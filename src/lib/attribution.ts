import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { interestListSignups, userSettings } from "@/db/schema";
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

/** Where a `signup_*` first touch came from; see `user_settings.signup_attribution_source`. */
export type AttributionSource = "cookie" | "direct" | "waitlist";

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
  attribution: Attribution,
  source: AttributionSource = "cookie"
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
        signupAttributionSource: source,
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
  // An account made from an invite arrives on the app host with no cookie — the first-touch
  // cookie is host-only and lives on the waitlist's domain — but the waitlist row it came
  // from holds the real channel. Prefer that to writing "direct" over it (audit U1).
  const fromWaitlist = await waitlistAttributionFor(userId);
  if (fromWaitlist) return recordFirstTouch(userId, fromWaitlist, "waitlist");
  return recordFirstTouch(userId, EMPTY, "direct");
}

/** The first touch the waitlist row behind this account recorded, or null when it has no such row. */
async function waitlistAttributionFor(userId: string): Promise<Attribution | null> {
  try {
    const db = await getDb();
    const [row] = await db
      .select({
        referrer: interestListSignups.referrer,
        utmSource: interestListSignups.utmSource,
        utmMedium: interestListSignups.utmMedium,
        utmCampaign: interestListSignups.utmCampaign,
        landingPath: interestListSignups.landingPath,
      })
      .from(userSettings)
      .innerJoin(interestListSignups, eq(interestListSignups.id, userSettings.interestSignupId))
      .where(eq(userSettings.userId, userId))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Copy the waitlist row's first touch onto an account the moment its invite is linked.
 *
 * Needed because the link and the first app render race: the Clerk webhook (which links the
 * invite) can land after the layout has already written the account as a `direct` visit. A
 * `direct` stamp means "no signal at all", so a waitlist row that DOES carry one may replace
 * it; a `cookie` first touch never yields. Idempotent, and a no-op once the account is
 * `waitlist`-attributed.
 */
export async function applyWaitlistAttribution(
  userId: string,
  interestSignupId: string
): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE user_settings u
       SET signup_referrer = w.referrer,
           signup_utm_source = w.utm_source,
           signup_utm_medium = w.utm_medium,
           signup_utm_campaign = w.utm_campaign,
           signup_landing_path = w.landing_path,
           signup_attribution_source = 'waitlist',
           signup_attributed_at = coalesce(u.signup_attributed_at, now())
      FROM interest_list_signups w
     WHERE w.id = ${interestSignupId}
       AND u.user_id = ${userId}
       AND (u.signup_attributed_at IS NULL OR u.signup_attribution_source = 'direct')
    RETURNING u.user_id
  `);
  return rowsOf(result).length > 0;
}

/** Whether this account still has no first touch written (a cheap guard before lazy work). */
export async function attributionPending(userId: string): Promise<boolean> {
  try {
    const db = await getDb();
    const [row] = await db
      .select({ at: userSettings.signupAttributedAt })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    return Boolean(row) && row!.at === null;
  } catch {
    return false;
  }
}

/**
 * Attribute an account that has only ever used a machine surface (API key, MCP, extension).
 *
 * The web layout is the only other writer, so an account that never renders an (app) page
 * stayed `signup_attributed_at IS NULL` — "unattributed" — forever (audit U2). Called from
 * the authenticated request paths with the settings row they already read, so the check is
 * free; the write is the same idempotent `WHERE signup_attributed_at IS NULL` UPDATE.
 */
export function noteMachineSurfaceAccount(
  userId: string,
  settings: { signupAttributedAt?: Date | null } | null | undefined
): void {
  if (!settings || settings.signupAttributedAt) return;
  void recordDirectVisit(userId).catch(() => null);
}

/**
 * The channel label for one account, as the rollup groups it.
 *
 * JS twin of {@link signupChannelSql}: both are the one definition of "channel", written
 * twice only because SQL cannot call JS. `scripts/smoke-attribution-chain.ts` runs them over
 * the same rows and fails if they ever disagree.
 */
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

/**
 * SQL for the channel of a `user_settings` row aliased `alias`: the same precedence as
 * {@link channelOf} (UTM source, else referrer host, else `direct` for an account that was
 * attributed with no signal, else `unattributed` for one that never was).
 *
 * Export for every rollup that groups accounts by channel, so a second spelling of the
 * COALESCE cannot drift. `money-metrics.ts` `paidSignupsByChannel` carries an identical
 * inline copy today; it should call this instead (another workstream owns that file).
 */
export function signupChannelSql(alias = "s"): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`signupChannelSql: bad alias "${alias}"`);
  const a = sql.raw(alias);
  return sql`coalesce(
    nullif(${a}.signup_utm_source, ''),
    nullif(${a}.signup_referrer, ''),
    CASE WHEN ${a}.signup_attributed_at IS NULL THEN 'unattributed' ELSE 'direct' END
  )`;
}
