import { and, desc, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups, userSettings } from "@/db/schema";
import { countInt } from "@/lib/admin-metrics";

/**
 * The interest-list roster: everyone who filled in the landing page's form, and when.
 *
 * Kept apart from `admin-product-health.ts`, which owns the Growth page's ten-row summary.
 * That answers "is anyone signing up"; this answers "who, and what happened to them" — a
 * different question with a different query shape (paged, filtered, and joined against
 * accounts), and the summary should not grow into a roster by accretion.
 */

export const INTEREST_LIST_PAGE_SIZE = 50;

export const INTEREST_LIST_FILTERS = [
  "all",
  "active",
  "unsubscribed",
  "converted",
] as const;

export type InterestListFilter = (typeof INTEREST_LIST_FILTERS)[number];

export function isInterestListFilter(value: string | undefined): value is InterestListFilter {
  return value != null && (INTEREST_LIST_FILTERS as readonly string[]).includes(value);
}

export type InterestListRow = {
  id: string;
  email: string;
  createdAt: Date;
  unsubscribedAt: Date | null;
  followUpSentAt: Date | null;
  welcomePlanet: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  landingPath: string | null;
  /** Whether this address later became an Orbit account. */
  converted: boolean;
};

export type InterestListSummary = {
  total: number;
  active: number;
  unsubscribed: number;
  converted: number;
  followUpsSent: number;
};

/**
 * Did this address go on to create an account?
 *
 * Matched against the `user_settings.email` mirror the Clerk webhook maintains — the same
 * join the day-3 follow-up sweep suppresses on, so the console and the mailer agree on who
 * counts as converted. Both sides are lowercased on write, but this is mirrored data with
 * no unique constraint, so the comparison does not assume it.
 */
const convertedSql = sql<boolean>`exists (
  select 1 from ${userSettings}
  where lower(${userSettings.email}) = ${interestListSignups.email}
)`;

function whereFor(filter: InterestListFilter) {
  if (filter === "active") {
    // "Active" means still mailable: subscribed AND not already an account. Someone who
    // converted is not a lost subscriber, but they are not an audience either.
    return and(isNull(interestListSignups.unsubscribedAt), sql`not ${convertedSql}`);
  }
  if (filter === "unsubscribed") return isNotNull(interestListSignups.unsubscribedAt);
  if (filter === "converted") return sql`${convertedSql}`;
  return undefined;
}

/** Counts for the tiles. One round trip — these are all aggregates over the same table. */
export async function getInterestListSummary(): Promise<InterestListSummary> {
  const db = await getDb();
  const [row] = await db
    .select({
      total: countInt,
      unsubscribed: sql<number>`count(*) filter (where ${interestListSignups.unsubscribedAt} is not null)::int`,
      followUpsSent: sql<number>`count(*) filter (where ${interestListSignups.followUpSentAt} is not null)::int`,
      converted: sql<number>`count(*) filter (where ${convertedSql})::int`,
      active: sql<number>`count(*) filter (
        where ${interestListSignups.unsubscribedAt} is null and not ${convertedSql}
      )::int`,
    })
    .from(interestListSignups);

  return {
    total: row?.total ?? 0,
    active: row?.active ?? 0,
    unsubscribed: row?.unsubscribed ?? 0,
    converted: row?.converted ?? 0,
    followUpsSent: row?.followUpsSent ?? 0,
  };
}

function selection() {
  return {
    id: interestListSignups.id,
    email: interestListSignups.email,
    createdAt: interestListSignups.createdAt,
    unsubscribedAt: interestListSignups.unsubscribedAt,
    followUpSentAt: interestListSignups.followUpSentAt,
    welcomePlanet: interestListSignups.welcomePlanet,
    referrer: interestListSignups.referrer,
    utmSource: interestListSignups.utmSource,
    utmMedium: interestListSignups.utmMedium,
    utmCampaign: interestListSignups.utmCampaign,
    landingPath: interestListSignups.landingPath,
    converted: convertedSql,
  };
}

/** One page of signups, newest first — the order the question "who just joined" is asked in. */
export async function loadInterestList(options: {
  page: number;
  filter: InterestListFilter;
}): Promise<{ rows: InterestListRow[]; total: number; page: number; pageCount: number }> {
  const db = await getDb();
  const where = whereFor(options.filter);

  const [counted] = await db
    .select({ n: countInt })
    .from(interestListSignups)
    .where(where);

  const total = counted?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / INTEREST_LIST_PAGE_SIZE));
  // Clamp rather than trust the query string: `?page=999` on a two-page list should show
  // the last page, not an empty table that looks like the list was wiped.
  const page = Math.min(Math.max(1, options.page), pageCount);

  const rows = await db
    .select(selection())
    .from(interestListSignups)
    .where(where)
    .orderBy(desc(interestListSignups.createdAt))
    .limit(INTEREST_LIST_PAGE_SIZE)
    .offset((page - 1) * INTEREST_LIST_PAGE_SIZE);

  return { rows: rows as InterestListRow[], total, page, pageCount };
}

/** Every matching row, for the CSV export. No pagination, same filter semantics. */
export async function loadInterestListAll(
  filter: InterestListFilter
): Promise<InterestListRow[]> {
  const db = await getDb();
  const rows = await db
    .select(selection())
    .from(interestListSignups)
    .where(whereFor(filter))
    .orderBy(desc(interestListSignups.createdAt));
  return rows as InterestListRow[];
}

/**
 * Where this signup came from, as one short string for a table cell.
 *
 * UTM wins over referrer when both exist: a campaign tag is something you chose to attach,
 * whereas the referrer is whatever the browser happened to send.
 */
export function sourceLabel(row: InterestListRow): string {
  const utm = [row.utmSource, row.utmMedium, row.utmCampaign].filter(Boolean).join(" · ");
  if (utm) return utm;
  if (row.referrer) return row.referrer;
  return "direct";
}
