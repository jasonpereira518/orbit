import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups, userSettings, waitlistPollVotes } from "@/db/schema";
import { countInt } from "@/lib/admin-metrics";
import { getWaitlistPageUrl } from "@/lib/app-url";
import { UserFacingError } from "@/lib/errors";
import {
  REFERRAL_TIERS,
  buildShareUrl,
  buildTicketUrl,
  parseEventSignupPaste,
  tierFor,
  type ReferralTierId,
} from "@/lib/interest-list";
import {
  adminManualInterestListSchema,
  type AdminManualInterestListInput,
} from "@/lib/interest-list-schema";
import {
  buildUnsubscribeUrl,
  generateUnsubscribeToken,
  sendInterestListWelcomeEmail,
} from "@/lib/interest-list-email";
import { generateShareToken } from "@/lib/interest-list-join";
import {
  invalidateInterestProof,
  readStandings,
  ticketForRow,
  type Standing,
} from "@/lib/interest-list-ticket";
import { asWelcomePlanet, planetForSignupNumber } from "@/lib/welcome-planets";

/**
 * The waitlist roster: everyone who joined, when, and where they stand in line.
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
  "priority-beta",
  "early-access",
  "founding",
  "unsubscribed",
  "converted",
] as const;

export type InterestListFilter = (typeof INTEREST_LIST_FILTERS)[number];

/** The referral count each tier filter starts at, read from the tier table so they cannot drift. */
const TIER_FILTER_AT = {
  "priority-beta": tierAt("priority-beta"),
  "early-access": tierAt("early-access"),
  founding: tierAt("founding"),
} as const;

function tierAt(id: ReferralTierId) {
  return REFERRAL_TIERS.find((t) => t.id === id)?.at ?? Number.POSITIVE_INFINITY;
}

function isTierFilter(filter: InterestListFilter): filter is keyof typeof TIER_FILTER_AT {
  return filter in TIER_FILTER_AT;
}

export function isInterestListFilter(value: string | undefined): value is InterestListFilter {
  return value != null && (INTEREST_LIST_FILTERS as readonly string[]).includes(value);
}

export type InterestListRow = {
  id: string;
  email: string;
  /** From the name step or an admin event add; null for address-only signups. */
  firstName: string | null;
  lastName: string | null;
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
  /** Friends who joined through this row's link and are still waiting. */
  referrals: number;
  /** Place in line, or null once they have left the waitlist. See `lineSql`. */
  position: number | null;
  /** Place by join order alone: what `position` would be with no referrals. Null once they have left. */
  joinRank: number | null;
  /** The referral tier they hold, or null once they have left the waitlist. */
  tier: ReferralTierId | null;
  /** Times they opened their own pass. Debounced; see `recordPassCheck`. */
  passCheckCount: number;
  /** When they last opened their own pass, or null if never. */
  passLastCheckedAt: Date | null;
  /** Operator-added from an in-person event; referenced in the welcome email. */
  signupEventLabel: string | null;
};

/** Display name for the roster: "First Last", or null when neither is set. */
export function interestListDisplayName(row: {
  firstName: string | null;
  lastName: string | null;
}): string | null {
  const first = row.firstName?.trim() || "";
  const last = row.lastName?.trim() || "";
  if (!first && !last) return null;
  // Event paste stores a single given name as both halves — show it once.
  if (first && last && first.toLowerCase() === last.toLowerCase()) return first;
  return [first, last].filter(Boolean).join(" ");
}

/**
 * The orders the roster can be read in: by place in line, or by join time (newest or
 * oldest first). The join-time orders never look at referrals.
 */
export type InterestListSort = "newest" | "oldest" | "position";

export type InterestListSummary = {
  total: number;
  active: number;
  unsubscribed: number;
  converted: number;
  /** Still-waiting rows with enough referrals for early access. */
  earlyAccess: number;
};

/**
 * Did this address go on to create an account?
 *
 * Matched against the `user_settings.email` mirror the Clerk webhook maintains — the same
 * join the broadcast sender suppresses on, so the console and the mailer agree on who
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

/**
 * Still-waiting referrals, per row. Same aliasing discipline as `convertedSql`: the inner
 * table is `r`, so the qualified outer `interest_list_signups.id` can only mean the row
 * being counted for.
 */
const referralsSql = sql<number>`(
  select count(*)::int from ${interestListSignups} as r
  where r.referred_by_id = ${interestListSignups}.id and r.unsubscribed_at is null
)`;

function whereFor(filter: InterestListFilter) {
  if (filter === "active") {
    // "Active" means still mailable: subscribed AND not already an account. Someone who
    // converted is not a lost subscriber, but they are not an audience either.
    return and(isNull(interestListSignups.unsubscribedAt), sql`not ${convertedSql}`);
  }
  if (isTierFilter(filter)) {
    return and(
      isNull(interestListSignups.unsubscribedAt),
      sql`${referralsSql} >= ${TIER_FILTER_AT[filter]}`
    );
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
      earlyAccess: sql<number>`count(*) filter (
        where ${interestListSignups.unsubscribedAt} is null and ${referralsSql} >= ${TIER_FILTER_AT["early-access"]}
      )::int`,
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
    earlyAccess: row?.earlyAccess ?? 0,
  };
}

export type WaitlistStats = InterestListSummary & {
  /** Joined in the last 24 hours / 7 days — every row, including ones that later left. */
  joined24h: number;
  joined7d: number;
  /** Rows that arrived through someone's invite link. */
  referred: number;
  /** The people bringing others in: most still-waiting referrals first. */
  topReferrers: Array<{ email: string; referrals: number; position: number | null }>;
};

const TOP_REFERRERS = 5;

/**
 * Everything the admin needs to know about the waitlist at a glance: its size, how much
 * of it is still waiting, how fast it is growing, how much of that growth is word of
 * mouth, and who is driving it. The tiles reuse `getInterestListSummary`; positions come
 * from `readStandings`, the same line the pass shows, so the console and the page agree.
 */
export async function getWaitlistStats(): Promise<WaitlistStats> {
  const db = await getDb();
  const [summary, [growth], leaders, standings] = await Promise.all([
    getInterestListSummary(),
    db
      .select({
        joined24h: sql<number>`count(*) filter (where ${interestListSignups.createdAt} > now() - interval '24 hours')::int`,
        joined7d: sql<number>`count(*) filter (where ${interestListSignups.createdAt} > now() - interval '7 days')::int`,
        referred: sql<number>`count(*) filter (where ${interestListSignups.referredById} is not null)::int`,
      })
      .from(interestListSignups),
    db
      .select({ id: interestListSignups.id, email: interestListSignups.email, referrals: referralsSql })
      .from(interestListSignups)
      .where(and(isNull(interestListSignups.unsubscribedAt), sql`${referralsSql} > 0`))
      .orderBy(sql`${referralsSql} desc`, interestListSignups.createdAt)
      .limit(TOP_REFERRERS),
    readStandings(),
  ]);

  return {
    ...summary,
    joined24h: growth?.joined24h ?? 0,
    joined7d: growth?.joined7d ?? 0,
    referred: growth?.referred ?? 0,
    topReferrers: leaders.map((l) => ({
      email: l.email,
      referrals: Number(l.referrals),
      position: standings.get(l.id)?.position ?? null,
    })),
  };
}

function selection() {
  return {
    id: interestListSignups.id,
    email: interestListSignups.email,
    firstName: interestListSignups.firstName,
    lastName: interestListSignups.lastName,
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
    referrals: referralsSql,
    passCheckCount: interestListSignups.passCheckCount,
    passLastCheckedAt: interestListSignups.passLastCheckedAt,
    signupEventLabel: interestListSignups.signupEventLabel,
  };
}

type SelectedRow = Omit<InterestListRow, "position" | "joinRank" | "tier">;

function withStanding(row: SelectedRow, standings: Map<string, Standing>): InterestListRow {
  const standing = row.unsubscribedAt ? undefined : standings.get(row.id);
  return {
    ...row,
    referrals: Number(row.referrals ?? 0),
    passCheckCount: Number(row.passCheckCount ?? 0),
    position: standing?.position ?? null,
    joinRank: standing?.joinRank ?? null,
    tier: row.unsubscribedAt ? null : tierFor(Number(row.referrals ?? 0)).current.id,
  };
}

/** Place in line first; rows that have left sort last, newest first among themselves. */
function byPosition(a: InterestListRow, b: InterestListRow) {
  if (a.position !== null && b.position !== null) return a.position - b.position;
  if (a.position !== null) return -1;
  if (b.position !== null) return 1;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

/**
 * Free-text match on the address or name.
 *
 * `ILIKE` with both wildcards, so a partial local part, a bare domain, or a first name all
 * work. The term is escaped first: `%` and `_` are wildcards in LIKE, so an unescaped `_`
 * in an address would silently widen the match.
 */
function searchFor(q: string | undefined) {
  const term = q?.trim();
  if (!term) return undefined;
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = `%${escaped}%`;
  return sql`(
    ${interestListSignups.email} ilike ${like}
    or coalesce(${interestListSignups.firstName}, '') ilike ${like}
    or coalesce(${interestListSignups.lastName}, '') ilike ${like}
  )`;
}

/**
 * One page of signups — by join time, newest or oldest first (who just joined; the order
 * people signed up in), or by place in line (who gets in first). Position is a window over
 * the whole line, so the position order is sorted here
 * from `readStandings` over the filtered set rather than in SQL; the roster is a few
 * thousand rows at most, and this keeps `lineSql` the single definition of the line.
 */
export async function loadInterestList(options: {
  page: number;
  filter: InterestListFilter;
  q?: string;
  sort?: InterestListSort;
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
  const standings = await readStandings();

  if (options.sort === "position") {
    const all = (await db.select(selection()).from(interestListSignups).where(where)) as SelectedRow[];
    const rows = all
      .map((r) => withStanding(r, standings))
      .sort(byPosition)
      .slice((page - 1) * INTEREST_LIST_PAGE_SIZE, page * INTEREST_LIST_PAGE_SIZE);
    return { rows, total, page, pageCount };
  }

  const rows = (await db
    .select(selection())
    .from(interestListSignups)
    .where(where)
    .orderBy(
      options.sort === "oldest" ? asc(interestListSignups.createdAt) : desc(interestListSignups.createdAt),
      options.sort === "oldest" ? asc(interestListSignups.id) : desc(interestListSignups.id)
    )
    .limit(INTEREST_LIST_PAGE_SIZE)
    .offset((page - 1) * INTEREST_LIST_PAGE_SIZE)) as SelectedRow[];

  return { rows: rows.map((r) => withStanding(r, standings)), total, page, pageCount };
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

/** Every matching row, for the CSV export, in line order. Same filter semantics. */
export async function loadInterestListAll(
  filter: InterestListFilter
): Promise<InterestListRow[]> {
  const db = await getDb();
  const [rows, standings] = await Promise.all([
    db.select(selection()).from(interestListSignups).where(whereFor(filter)),
    readStandings(),
  ]);
  return (rows as SelectedRow[]).map((r) => withStanding(r, standings)).sort(byPosition);
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
 * exactly one "is this person still waiting" condition in the system rather than an
 * operator flag that the line would also have to learn about. Idempotent via COALESCE: re-running
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
  if (!rows[0]) return null;
  // The public proof memo is module-level; without this the waitlist page keeps counting
  // them as waiting for up to a minute on this instance.
  invalidateInterestProof();
  return { email: rows[0].email };
}

/**
 * Put someone back on the list.
 *
 * The counterpart to the above, for the ordinary mistake of removing the wrong row. The
 * row keeps its join time, so it goes back to the place in line it had.
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
  if (!rows[0]) return null;
  invalidateInterestProof();
  return { email: rows[0].email };
}

/**
 * Erase the row entirely.
 *
 * For a bot signup, a typo, or a genuine deletion request — not for "stop mailing them",
 * which `unsubscribeInterestListRow` does while keeping the acquisition record. Deleting
 * loses the signup date and source permanently, and lets that address rejoin later as a
 * brand-new signup with a fresh planet.
 *
 * Child cleanup runs first even though the schema declares no FKs: friends still point at
 * this id via `referred_by_id`, and a poll vote may still key on `signup:<id>`. Clearing
 * those keeps the roster and tallies coherent after the row is gone. Broadcast recipient
 * rows are left alone — they denormalise the address so a send record survives deletion.
 */
export async function deleteInterestListRow(
  id: string
): Promise<{ email: string } | null> {
  const db = await getDb();
  const deleted = await db.transaction(async (tx) => {
    await tx
      .update(interestListSignups)
      .set({ referredById: null })
      .where(eq(interestListSignups.referredById, id));
    await tx
      .delete(waitlistPollVotes)
      .where(
        or(eq(waitlistPollVotes.signupId, id), eq(waitlistPollVotes.voterKey, `signup:${id}`))
      );
    const rows = await tx
      .delete(interestListSignups)
      .where(eq(interestListSignups.id, id))
      .returning();
    return rows[0] ?? null;
  });
  if (!deleted) return null;
  invalidateInterestProof();
  return { email: deleted.email };
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
  if (rows.length > 0) invalidateInterestProof();
  return rows.map((r) => r.email);
}

export async function bulkDeleteInterestListRows(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const capped = ids.slice(0, BULK_LIMIT);
  const db = await getDb();
  const emails = await db.transaction(async (tx) => {
    await tx
      .update(interestListSignups)
      .set({ referredById: null })
      .where(inArray(interestListSignups.referredById, capped));
    const voterKeys = capped.map((id) => `signup:${id}`);
    await tx
      .delete(waitlistPollVotes)
      .where(
        or(
          inArray(waitlistPollVotes.signupId, capped),
          inArray(waitlistPollVotes.voterKey, voterKeys)
        )
      );
    const rows = await tx
      .delete(interestListSignups)
      .where(inArray(interestListSignups.id, capped))
      .returning();
    return rows.map((r) => r.email);
  });
  if (emails.length > 0) invalidateInterestProof();
  return emails;
}

/**
 * Where this signup came from, as one short string for a table cell.
 *
 * UTM wins over referrer when both exist: a campaign tag is something you chose to attach,
 * whereas the referrer is whatever the browser happened to send.
 */
export function sourceLabel(row: InterestListRow): string {
  if (row.signupEventLabel) return `Event · ${row.signupEventLabel}`;
  const utm = [row.utmSource, row.utmMedium, row.utmCampaign].filter(Boolean).join(" · ");
  if (utm) return utm;
  if (row.referrer) return row.referrer;
  return "direct";
}

/**
 * Adds someone from an in-person event: names on the pass, a stored event label, and the
 * welcome note that names the event. Refuses active duplicates; someone who left can rejoin.
 */
export async function addManualInterestListSignup(
  input: AdminManualInterestListInput
): Promise<{ email: string; id: string }> {
  const parsed = adminManualInterestListSchema.safeParse(input);
  if (!parsed.success) {
    throw new UserFacingError(parsed.error.issues[0]?.message ?? "Could not add that signup.");
  }
  const { firstName, lastName, eventLabel, createdAt } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();

  const db = await getDb();
  const [existing] = await db
    .select()
    .from(interestListSignups)
    .where(eq(interestListSignups.email, email))
    .limit(1);

  if (existing && !existing.unsubscribedAt) {
    throw new UserFacingError("That address is already on the waitlist.");
  }

  let row = existing;
  if (!existing) {
    const [before] = await db.select({ n: sql<number>`count(*)::int` }).from(interestListSignups);
    const [inserted] = await db
      .insert(interestListSignups)
      .values({
        email,
        firstName,
        lastName,
        signupEventLabel: eventLabel,
        utmSource: "admin",
        utmMedium: "event",
        utmCampaign: eventLabel,
        landingPath: "/admin/growth/interest-list",
        unsubscribeToken: generateUnsubscribeToken(),
        shareToken: generateShareToken(),
        welcomePlanet: planetForSignupNumber((before?.n ?? 0) + 1),
        ...(createdAt ? { createdAt } : {}),
      })
      .onConflictDoNothing({ target: interestListSignups.email })
      .returning();
    if (inserted) {
      row = inserted;
      invalidateInterestProof();
    } else {
      [row] = await db
        .select()
        .from(interestListSignups)
        .where(eq(interestListSignups.email, email))
        .limit(1);
      if (row && !row.unsubscribedAt) {
        throw new UserFacingError("That address is already on the waitlist.");
      }
    }
  }

  if (row?.unsubscribedAt) {
    [row] = await db
      .update(interestListSignups)
      .set({
        unsubscribedAt: null,
        followUpSentAt: null,
        firstName,
        lastName,
        signupEventLabel: eventLabel,
        utmSource: "admin",
        utmMedium: "event",
        utmCampaign: eventLabel,
        shareToken: row.shareToken ?? generateShareToken(),
        // Keep their original join time on rejoin — do not rewrite with the event stamp.
      })
      .where(eq(interestListSignups.id, row.id))
      .returning();
    invalidateInterestProof();
  }

  if (!row?.shareToken) {
    throw new UserFacingError("Could not add that signup — try again.");
  }

  const ticket = await ticketForRow({
    id: row.id,
    email: row.email,
    referralSlug: row.referralSlug,
    createdAt: row.createdAt,
    welcomePlanet: row.welcomePlanet,
    shareToken: row.shareToken,
  });

  const pageUrl = getWaitlistPageUrl();
  await sendInterestListWelcomeEmail(
    row.email,
    buildUnsubscribeUrl(row.unsubscribeToken),
    asWelcomePlanet(row.welcomePlanet),
    {
      ticketUrl: buildTicketUrl(pageUrl, row.shareToken),
      shareUrl: buildShareUrl(pageUrl, { referralSlug: ticket.referralSlug, shareToken: row.shareToken }),
    },
    ticket.position,
    eventLabel
  );

  return { email: row.email, id: row.id };
}

export type BulkManualInterestListResult = {
  added: Array<{ email: string; id: string }>;
  skipped: Array<{ email: string; reason: string }>;
  parseErrors: string[];
};

/**
 * Paste from an event spreadsheet: timestamp, name, email. Adds in spreadsheet order
 * (by timestamp when every row has one, otherwise paste order) so join order matches the
 * line at the event.
 */
export async function addManualInterestListSignupsFromPaste(input: {
  paste: string;
  eventLabel: string;
}): Promise<BulkManualInterestListResult> {
  const eventLabel = input.eventLabel.trim();
  const labelOk = adminManualInterestListSchema.shape.eventLabel.safeParse(eventLabel);
  if (!labelOk.success) {
    throw new UserFacingError(labelOk.error.issues[0]?.message ?? "Event name is required.");
  }

  const { rows, errors: parseErrors } = parseEventSignupPaste(input.paste);
  if (rows.length === 0) {
    if (parseErrors.length > 0) {
      throw new UserFacingError(parseErrors[0]!);
    }
    throw new UserFacingError("Paste at least one row: timestamp, name, and email.");
  }

  // Prefer event time order when every row carried a timestamp; otherwise keep paste order.
  const ordered =
    rows.every((r) => r.signedAt) ?
      [...rows].sort((a, b) => a.signedAt!.getTime() - b.signedAt!.getTime() || a.line - b.line)
    : rows;

  const added: BulkManualInterestListResult["added"] = [];
  const skipped: BulkManualInterestListResult["skipped"] = [];

  // Sequential so each insert sees the previous row and join order stays stable.
  for (const row of ordered) {
    try {
      const result = await addManualInterestListSignup({
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        eventLabel,
        createdAt: row.signedAt ?? undefined,
      });
      added.push(result);
    } catch (err) {
      const message =
        err instanceof UserFacingError ? err.message : "Could not add that signup.";
      skipped.push({ email: row.email, reason: message });
    }
  }

  return { added, skipped, parseErrors };
}
