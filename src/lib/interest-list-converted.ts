import { sql, type SQL } from "drizzle-orm";
import { interestListSignups, userSettings } from "@/db/schema";
import { internalAccountSql } from "@/lib/analytics-internal";

/**
 * The waitlist's shared SQL definitions. The admin roster (`admin-interest-list.ts`) and the
 * broadcast sender (`broadcasts.ts`) used to each carry their own "did this address become an
 * account?" test; they now read this one, so the console and the mailer cannot disagree about
 * who counts as converted.
 *
 * Server-only (it imports the schema), but no framework: smokes can import it.
 */

/**
 * Did this person go on to create an account?
 *
 * TRUE when the waitlist row was linked to an account by id (`user_id`, set when the invite is
 * claimed: `linkInviteToAccount`), OR the address matches an account's `user_settings.email`
 * mirror, which still catches people who signed up without an invite. The id is the real key;
 * the email is the fallback that keeps rows from before the link existed honest.
 *
 * A deleted account's waitlist row is deleted by a full purge, so neither arm can resurrect a
 * deleted person as "converted".
 *
 * THE ALIAS AND THE QUALIFIERS ARE LOAD-BEARING. Interpolating bare `${userSettings.email}`
 * and `${interestListSignups.email}` renders both as an unqualified `"email"`, and inside
 * the subquery both then bind to `user_settings.email` — the correlation silently collapses
 * to `lower(u.email) = u.email`, which is true for any lowercase address, so EXISTS returns
 * true for every row and the whole list reads as converted. Aliasing the inner table and
 * qualifying each side is what keeps the outer reference an outer reference.
 */
export const convertedSql = sql<boolean>`(
  ${interestListSignups}.user_id is not null
  or exists (
    select 1 from ${userSettings} as u
    where lower(u.email) = ${interestListSignups}.email
  )
)`;

/**
 * Whether this waitlist row is the operator's own test join: it belongs to an internal
 * account (an admin id, the showcase account, or one marked internal/tester), matched by the
 * linked `user_id` or by the address on that account.
 *
 * Statistics leave these out, so testing the join form does not read as demand. The roster
 * still lists them. `false` outright in demo mode (see `internalAccountSql`).
 */
export function operatorTestJoinSql(): SQL {
  return sql`(
    (${interestListSignups}.user_id is not null and ${internalAccountSql(sql.raw("interest_list_signups.user_id"))})
    or exists (
      select 1 from ${userSettings} as o
      where lower(o.email) = ${interestListSignups}.email
        and ${internalAccountSql(sql.raw("o.user_id"))}
    )
  )`;
}

/**
 * Still waiting for early access: on the list, not already an account. The audience the
 * console calls "waiting" and the one a broadcast goes to.
 */
export const waitingSql = sql<boolean>`(
  ${interestListSignups}.unsubscribed_at is null and not ${convertedSql}
)`;
