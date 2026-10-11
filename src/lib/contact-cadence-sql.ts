import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { contacts } from "@/db/schema";

/**
 * The SQL twin of `keep-in-touch.ts`: effective cadence, when it lapses, and "is this follow-up
 * due". `scripts/smoke-contact-cadence.ts` holds the two to the same answers.
 *
 * Intervals are 24-HOUR multiples, not `interval '1 day'`, so a session time zone with DST
 * cannot move the instant by an hour away from the TypeScript arithmetic.
 */
type Ref = AnyColumn | SQL;
export type CadenceColumns = {
  cadenceDays: Ref; closenessTier: Ref; lastInteractionAt: Ref; dateMet: Ref; createdAt: Ref; nextFollowUpAt: Ref;
};

export const contactColumns: CadenceColumns = {
  cadenceDays: contacts.cadenceDays,
  closenessTier: contacts.closenessTier,
  lastInteractionAt: contacts.lastInteractionAt,
  dateMet: contacts.dateMet,
  createdAt: contacts.createdAt,
  nextFollowUpAt: contacts.nextFollowUpAt,
};

/** For raw SQL that joins contacts under an alias (`due` in the reminders card query). */
export function aliasColumns(alias: string): CadenceColumns {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("bad alias");
  const col = (name: string) => sql.raw(`${alias}.${name}`);
  return {
    cadenceDays: col("cadence_days"), closenessTier: col("closeness_tier"), lastInteractionAt: col("last_interaction_at"),
    dateMet: col("date_met"), createdAt: col("created_at"), nextFollowUpAt: col("next_follow_up_at"),
  };
}

export function effectiveCadenceSql(c: CadenceColumns = contactColumns): SQL<number | null> {
  return sql<number | null>`coalesce(
    case when ${c.cadenceDays} > 0 then ${c.cadenceDays} end,
    case ${c.closenessTier} when 'inner' then 30 when 'mid' then 90 end
  )`;
}

export function cadenceDueAtSql(c: CadenceColumns = contactColumns): SQL<string | null> {
  return sql<string | null>`(coalesce(${c.lastInteractionAt}, ${c.dateMet}, ${c.createdAt}) + ${effectiveCadenceSql(c)} * interval '24 hours')`;
}

/**
 * Due now: a booked follow-up at or before `now`, or nothing booked and the cadence lapsed.
 * Truncated to the millisecond as reminders.ts always did, so a JS Date and the column agree.
 */
export function followUpDueSql(now: SQL, c: CadenceColumns = contactColumns): SQL<boolean> {
  return sql<boolean>`(
    (${c.nextFollowUpAt} is not null and date_trunc('milliseconds', ${c.nextFollowUpAt}) <= ${now})
    or (${c.nextFollowUpAt} is null and date_trunc('milliseconds', ${cadenceDueAtSql(c)}) <= ${now})
  )`;
}
