import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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
 *
 * THE ALIAS AND THE QUALIFIERS ARE LOad-BEARING. Interpolating bare `${userSettings.email}`
 * and `${interestListSignups.email}` renders both as an unqualified `"email"`, and inside
 * the subquery both then bind to `user_settings.email` — the correlation silently collapses
 * to `lower(u.email) = u.email`, which is true for any lowercase address, so EXISTS returns
 * true for every row and the whole list reads as converted. Aliasing the inner table and
 * qualifying each side is what keeps the outer reference an outer reference.
 */
const convertedSql = sql<boolean>`exists (
  select 1 from ${userSettings} as u
  where lower(u.email) = ${interestListSignups}.email
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

/**
 * Free-text match on the address.
 *
 * `ILIKE` with both wildcards, so a partial local part or a bare domain both work — the two
 * things you actually type when hunting for someone. The term is escaped first: `%` and `_`
 * are wildcards in LIKE, so an unescaped `_` in an address would silently widen the match.
 */
function searchFor(q: string | undefined) {
  const term = q?.trim();
  if (!term) return undefined;
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return sql`${interestListSignups.email} ilike ${`%${escaped}%`}`;
}

/** One page of signups, newest first — the order the question "who just joined" is asked in. */
export async function loadInterestList(options: {
  page: number;
  filter: InterestListFilter;
  q?: string;
}): Promise<{ rows: InterestListRow[]; total: number; page: number; pageCount: number }> {
  const db = await getDb();
  const where = and(whereFor(options.filter), searchFor(options.q));

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

export type InterestListTrendPoint = { bucketStart: Date; count: number };

/**
 * Signups per week or month.
 *
 * Uses `date_trunc` and generates no empty buckets — a period with no signups produces no
 * row, so the caller fills the gaps. Matches how `admin-trends.ts` reports the same shape
 * for accounts.
 */
export async function interestListTrend(
  grain: "week" | "month" = "week",
  buckets = 12
): Promise<InterestListTrendPoint[]> {
  const db = await getDb();

  // The grain is inlined rather than bound. Passed as a parameter it becomes `date_trunc($1,
  // …)` in the SELECT and `date_trunc($2, …)` in the GROUP BY, and Postgres cannot prove two
  // different placeholders are the same expression — it rejects the whole query with 42803.
  // Inlining is safe precisely because `grain` is a closed union, never caller text.
  const unit = grain === "month" ? "month" : "week";
  const bucket = sql<string>`date_trunc('${sql.raw(unit)}', ${interestListSignups.createdAt})`;

  const rows = await db
    .select({ bucketStart: bucket, count: countInt })
    .from(interestListSignups)
    .groupBy(bucket)
    .orderBy(sql`${bucket} desc`)
    .limit(buckets);

  return rows
    .map((r) => ({ bucketStart: new Date(r.bucketStart), count: r.count }))
    .reverse();
}

export type InterestListSourceRow = {
  source: string;
  count: number;
  converted: number;
};

/**
 * Where signups come from, and which sources actually produce accounts.
 *
 * The conversion column is the point: a channel that delivers volume and no accounts is
 * worth knowing about, and this table already stores everything needed to say so. Grouped
 * in SQL by the same precedence `sourceLabel` uses for a single row — UTM source first,
 * then referrer host, then "direct" — so the rollup and the table agree.
 */
export async function interestListSources(): Promise<InterestListSourceRow[]> {
  const db = await getDb();
  const bucket = sql<string>`coalesce(nullif(${interestListSignups.utmSource}, ''), nullif(${interestListSignups.referrer}, ''), 'direct')`;

  const rows = await db
    .select({
      source: bucket,
      count: countInt,
      converted: sql<number>`count(*) filter (where ${convertedSql})::int`,
    })
    .from(interestListSignups)
    .groupBy(bucket)
    .orderBy(sql`count(*) desc`);

  return rows.map((r) => ({
    source: r.source,
    count: r.count,
    converted: r.converted,
  }));
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

/** One row by id, for an action that needs to check what it is about to change. */
export async function loadInterestListRow(
  id: string
): Promise<{ id: string; email: string } | null> {
  const db = await getDb();
  const rows = await db
    .select({ id: interestListSignups.id, email: interestListSignups.email })
    .from(interestListSignups)
    .where(eq(interestListSignups.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Take someone off the list without losing the record of them.
 *
 * Sets the same `unsubscribed_at` the recipient's own one-click link writes, so there is
 * exactly one "is this person mailable" condition in the system rather than an operator
 * flag that the sweep would also have to learn about. Idempotent via COALESCE: re-running
 * it must not move a timestamp the subscriber themselves set earlier.
 *
 * Returns null when no row matched, so the caller can report that rather than logging an
 * audit entry for something that did not happen.
 */
export async function unsubscribeInterestListRow(
  id: string
): Promise<{ email: string } | null> {
  const db = await getDb();
  const rows = await db
    .update(interestListSignups)
    .set({
      unsubscribedAt: sql`coalesce(${interestListSignups.unsubscribedAt}, now())`,
    })
    .where(eq(interestListSignups.id, id))
    .returning();
  return rows[0] ? { email: rows[0].email } : null;
}

/**
 * Put someone back on the list.
 *
 * The counterpart to the above, for the ordinary mistake of removing the wrong row. It
 * clears `follow_up_sent_at` alongside, matching what a rejoin through the form does —
 * otherwise a restored row would be permanently ineligible for the day-3 note.
 */
export async function resubscribeInterestListRow(
  id: string
): Promise<{ email: string } | null> {
  const db = await getDb();
  const rows = await db
    .update(interestListSignups)
    .set({ unsubscribedAt: null, followUpSentAt: null })
    .where(eq(interestListSignups.id, id))
    .returning();
  return rows[0] ? { email: rows[0].email } : null;
}

/**
 * Erase the row entirely.
 *
 * For a bot signup, a typo, or a genuine deletion request — not for "stop mailing them",
 * which `unsubscribeInterestListRow` does while keeping the acquisition record. Deleting
 * loses the signup date and source permanently, and lets that address rejoin later as a
 * brand-new signup with a fresh planet.
 */
export async function deleteInterestListRow(
  id: string
): Promise<{ email: string } | null> {
  const db = await getDb();
  const rows = await db
    .delete(interestListSignups)
    .where(eq(interestListSignups.id, id))
    .returning();
  return rows[0] ? { email: rows[0].email } : null;
}

/** Ceiling on one bulk action, so a mis-click cannot take out the whole list in one go. */
export const BULK_LIMIT = 200;

/**
 * Unsubscribe or delete many rows at once.
 *
 * Both branches return the addresses they touched, because the audit entry is the only
 * record a bulk delete leaves behind — and a count alone would make it impossible to say
 * afterwards who was removed.
 */
export async function bulkUnsubscribeInterestListRows(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .update(interestListSignups)
    .set({
      unsubscribedAt: sql`coalesce(${interestListSignups.unsubscribedAt}, now())`,
    })
    .where(inArray(interestListSignups.id, ids.slice(0, BULK_LIMIT)))
    .returning();
  return rows.map((r) => r.email);
}

export async function bulkDeleteInterestListRows(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .delete(interestListSignups)
    .where(inArray(interestListSignups.id, ids.slice(0, BULK_LIMIT)))
    .returning();
  return rows.map((r) => r.email);
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
