import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { feedback, feedbackScreenshots, userSettings } from "@/db/schema";
import { countInt } from "@/lib/admin-metrics";
import { assertRevealable } from "@/lib/admin-redaction";
import { FEEDBACK_AREAS, FEEDBACK_CATEGORIES, type FeedbackArea, type FeedbackCategory } from "@/lib/feedback-report";

/**
 * The feedback console's read side: what people said, and what has been done about it.
 *
 * Mirrors `admin-interest-list.ts` — paged, filtered, with a summary in one round trip —
 * because the console asks the same shape of question of both.
 *
 * Mutations live at the bottom as plain functions taking an explicit `adminUserId`, with no
 * `revalidatePath` and no `after()`: that boundary belongs to `src/actions/admin.ts`, and
 * keeping it means `scripts/smoke-feedback-admin.ts` can exercise the writes without a
 * request context.
 */

export const FEEDBACK_PAGE_SIZE = 50;

export const FEEDBACK_FILTERS = ["all", "new", "triaged", "resolved"] as const;
export type FeedbackFilter = (typeof FEEDBACK_FILTERS)[number];
export type FeedbackStatus = "new" | "triaged" | "resolved";

export function isFeedbackFilter(value: string | undefined): value is FeedbackFilter {
  return value != null && (FEEDBACK_FILTERS as readonly string[]).includes(value);
}

export function isFeedbackArea(value: string | undefined): value is FeedbackArea {
  return value != null && (FEEDBACK_AREAS as readonly string[]).includes(value);
}

export function isFeedbackCategory(value: string | undefined): value is FeedbackCategory {
  return value != null && (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The mood of a category, for the one question the widget has no field for: is this a
 * complaint or a compliment? Derived rather than asked, so a submission stays one tap shorter
 * and the scale needs no migration. `idea` is neutral: a request is neither.
 */
export type FeedbackSentiment = "negative" | "neutral" | "positive";
export function categorySentiment(category: string | null): FeedbackSentiment | null {
  switch (category) {
    case "bug":
    case "confusing":
      return "negative";
    case "idea":
      return "neutral";
    case "praise":
      return "positive";
    default:
      return null;
  }
}

/**
 * How many screenshots this entry has.
 *
 * THE ALIAS AND THE QUALIFIERS ARE LOAD-BEARING, for the reason written out at length in
 * `admin-interest-list.ts:convertedSql`: interpolating a bare `${feedbackScreenshots.feedbackId}`
 * renders as an unqualified `"feedback_id"`, which binds to the INNER table and turns the
 * correlation into `s.feedback_id = s.feedback_id` — true for every row, so every entry
 * would report the whole table's screenshot count.
 */
const screenshotCountSql = sql<number>`(
  select count(*)::int from ${feedbackScreenshots} as s
  where s.feedback_id = ${feedback}.id
)`;

export type FeedbackListRow = {
  id: string;
  userId: string;
  kind: string;
  area: string | null;
  category: string | null;
  status: FeedbackStatus;
  score: number | null;
  /** Trimmed in SQL — the table shows an excerpt and the detail page shows the whole thing. */
  excerpt: string | null;
  screenshotCount: number;
  createdAt: Date;
  statusChangedAt: Date | null;
  /** From the `user_settings` mirror. Null once the account has been purged. */
  submitterEmail: string | null;
  /** They ticked "you may contact me about this". Null on entries older than the field. */
  contactOk: boolean | null;
};

export type FeedbackSummary = {
  total: number;
  new: number;
  triaged: number;
  resolved: number;
  withScreenshots: number;
  last7Days: number;
};

function whereFor(filter: FeedbackFilter) {
  if (filter === "all") return undefined;
  return eq(feedback.status, filter);
}

/** The widget's two facets. Both are closed sets, validated before they reach here. */
function facetsFor(area?: FeedbackArea | null, category?: FeedbackCategory | null) {
  return and(area ? eq(feedback.area, area) : undefined, category ? eq(feedback.category, category) : undefined);
}

export type FeedbackThemes = {
  days: number;
  byCategory: Array<{ category: string; sentiment: FeedbackSentiment | null; count: number }>;
  byArea: Array<{ area: string; count: number; negative: number }>;
  /** Entries in the window that ticked "you may contact me", and that are still unresolved. */
  contactableOpen: number;
};

/**
 * What the widget says in aggregate over a window: how much of each kind, where it is
 * about, and how much of it is a complaint. Counts only; with a few hundred users a share of
 * a dozen entries is not a finding, so none is computed.
 */
export async function getFeedbackThemes(days = 28): Promise<FeedbackThemes> {
  const db = await getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [byCategory, byArea, contactable] = await Promise.all([
    db
      .select({ category: feedback.category, count: countInt })
      .from(feedback)
      .where(sql`${feedback.createdAt} >= ${since}`)
      .groupBy(feedback.category),
    db
      .select({
        area: feedback.area,
        count: countInt,
        negative: sql<number>`count(*) filter (where ${feedback.category} in ('bug', 'confusing'))::int`,
      })
      .from(feedback)
      .where(sql`${feedback.createdAt} >= ${since}`)
      .groupBy(feedback.area),
    db
      .select({ n: countInt })
      .from(feedback)
      .where(
        sql`${feedback.createdAt} >= ${since} AND ${feedback.status} <> 'resolved' AND ${feedback.context} ->> 'contactOk' = 'true'`
      ),
  ]);
  return {
    days,
    byCategory: byCategory
      .map((r) => ({ category: r.category ?? "uncategorised", sentiment: categorySentiment(r.category), count: r.count }))
      .sort((a, b) => b.count - a.count),
    byArea: byArea
      .map((r) => ({ area: r.area ?? "unspecified", count: r.count, negative: r.negative }))
      .sort((a, b) => b.count - a.count),
    contactableOpen: contactable[0]?.n ?? 0,
  };
}

/**
 * Free-text match on what they wrote.
 *
 * The term is escaped first: `%` and `_` are LIKE wildcards, so an unescaped `_` would
 * silently widen the match. Same treatment as `admin-interest-list.ts:searchFor`.
 */
function searchFor(q: string | undefined) {
  const term = q?.trim();
  if (!term) return undefined;
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return sql`${feedback.text} ilike ${`%${escaped}%`}`;
}

/** Counts for the tiles. One round trip — all aggregates over the same table. */
export async function getFeedbackSummary(): Promise<FeedbackSummary> {
  const db = await getDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [row] = await db
    .select({
      total: countInt,
      new: sql<number>`count(*) filter (where ${feedback.status} = 'new')::int`,
      triaged: sql<number>`count(*) filter (where ${feedback.status} = 'triaged')::int`,
      resolved: sql<number>`count(*) filter (where ${feedback.status} = 'resolved')::int`,
      withScreenshots: sql<number>`count(*) filter (where ${screenshotCountSql} > 0)::int`,
      last7Days: sql<number>`count(*) filter (where ${feedback.createdAt} >= ${sevenDaysAgo})::int`,
    })
    .from(feedback);

  return {
    total: row?.total ?? 0,
    new: row?.new ?? 0,
    triaged: row?.triaged ?? 0,
    resolved: row?.resolved ?? 0,
    withScreenshots: row?.withScreenshots ?? 0,
    last7Days: row?.last7Days ?? 0,
  };
}

/**
 * Unresolved entries, for the nav badge.
 *
 * Runs on every admin page render, which is what `feedback_status_created_idx` is for.
 * "Not resolved" rather than "new" so something parked in `triaged` still reads as
 * outstanding — a backlog you stopped looking at is still a backlog.
 */
export async function unresolvedFeedbackCount(): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: countInt })
    .from(feedback)
    .where(ne(feedback.status, "resolved"));
  return row?.n ?? 0;
}

function listSelection() {
  return {
    id: feedback.id,
    userId: feedback.userId,
    kind: feedback.kind,
    area: feedback.area,
    category: feedback.category,
    status: feedback.status,
    score: feedback.score,
    excerpt: sql<string | null>`left(${feedback.text}, 180)`,
    screenshotCount: screenshotCountSql,
    createdAt: feedback.createdAt,
    statusChangedAt: feedback.statusChangedAt,
    submitterEmail: userSettings.email,
    contactOk: sql<boolean | null>`(${feedback.context} ->> 'contactOk')::boolean`,
  };
}

/** One page, newest first — the order "what has anyone said lately" is asked in. */
export async function loadFeedbackList(options: {
  page: number;
  filter: FeedbackFilter;
  q?: string;
  area?: FeedbackArea | null;
  category?: FeedbackCategory | null;
}): Promise<{ rows: FeedbackListRow[]; total: number; page: number; pageCount: number }> {
  const db = await getDb();
  const where = and(whereFor(options.filter), searchFor(options.q), facetsFor(options.area, options.category));

  const [counted] = await db.select({ n: countInt }).from(feedback).where(where);
  const total = counted?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / FEEDBACK_PAGE_SIZE));
  // Clamp rather than trust the query string: `?page=999` should show the last page, not an
  // empty table that reads as data loss.
  const page = Math.min(Math.max(1, options.page), pageCount);

  const rows = await db
    .select(listSelection())
    .from(feedback)
    .leftJoin(userSettings, eq(userSettings.userId, feedback.userId))
    .where(where)
    .orderBy(desc(feedback.createdAt))
    .limit(FEEDBACK_PAGE_SIZE)
    .offset((page - 1) * FEEDBACK_PAGE_SIZE);

  return { rows: rows as FeedbackListRow[], total, page, pageCount };
}

export type FeedbackScreenshotRow = {
  id: string;
  position: number;
  note: string | null;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
};

export type FeedbackDetail = {
  entry: {
    id: string;
    userId: string;
    kind: string;
    area: string | null;
    category: string | null;
    status: FeedbackStatus;
    score: number | null;
    text: string | null;
    context: Record<string, unknown>;
    createdAt: Date;
    statusChangedAt: Date | null;
    statusChangedBy: string | null;
    resolutionNote: string | null;
  };
  screenshots: FeedbackScreenshotRow[];
  submitter: { email: string | null; createdAt: Date | null } | null;
};

/** One entry, with its gallery. Null when the id does not exist. */
export async function loadFeedbackDetail(id: string): Promise<FeedbackDetail | null> {
  // Passes today, and that is the point: this is the executable form of the doc comment on
  // the `feedback` table, and it fails loudly the day someone adds these to the redaction
  // denylist without noticing the console reads them.
  assertRevealable(["feedback.text", "feedback.resolution_note"]);

  const db = await getDb();
  const [entry] = await db.select().from(feedback).where(eq(feedback.id, id)).limit(1);
  if (!entry) return null;

  // `inlineData` and `blobUrl` are deliberately NOT selected. The page renders
  // `/api/feedback/screenshots/[shotId]`, so the bytes never enter the RSC payload — the
  // same discipline `src/lib/contact-avatar-url.ts` enforces for avatars.
  const screenshots = await db
    .select({
      id: feedbackScreenshots.id,
      position: feedbackScreenshots.position,
      note: feedbackScreenshots.note,
      contentType: feedbackScreenshots.contentType,
      byteSize: feedbackScreenshots.byteSize,
      width: feedbackScreenshots.width,
      height: feedbackScreenshots.height,
    })
    .from(feedbackScreenshots)
    .where(eq(feedbackScreenshots.feedbackId, id))
    .orderBy(asc(feedbackScreenshots.position));

  const [submitter] = await db
    .select({ email: userSettings.email, createdAt: userSettings.createdAt })
    .from(userSettings)
    .where(eq(userSettings.userId, entry.userId))
    .limit(1);

  return {
    entry: {
      id: entry.id,
      userId: entry.userId,
      kind: entry.kind,
      area: entry.area,
      category: entry.category,
      status: entry.status,
      score: entry.score,
      text: entry.text,
      context: entry.context,
      createdAt: entry.createdAt,
      statusChangedAt: entry.statusChangedAt,
      statusChangedBy: entry.statusChangedBy,
      resolutionNote: entry.resolutionNote,
    },
    screenshots,
    submitter: submitter ?? null,
  };
}

export type FeedbackExportRow = Omit<FeedbackListRow, "excerpt"> & { text: string | null };

/**
 * Everything matching a filter, unpaged, for the CSV export.
 *
 * Selects the FULL text rather than the list's 180-character excerpt: an export that
 * silently truncates the one column anybody opens it for is worse than no export.
 * Screenshots are still absent — `inline_data` must never reach a CSV.
 */
export async function loadFeedbackAll(filter: FeedbackFilter): Promise<FeedbackExportRow[]> {
  const db = await getDb();
  const rows = await db
    .select({ ...listSelection(), excerpt: feedback.text })
    .from(feedback)
    .leftJoin(userSettings, eq(userSettings.userId, feedback.userId))
    .where(whereFor(filter))
    .orderBy(desc(feedback.createdAt));
  return rows.map(({ excerpt, ...rest }) => ({ ...rest, text: excerpt })) as FeedbackExportRow[];
}

/**
 * Move one entry's triage state.
 *
 * Returns null when nothing matched, so the caller can throw rather than write an audit row
 * for a no-op — `ConfirmActionDialog` reports success for any resolved promise.
 */
export async function setFeedbackStatus(input: {
  id: string;
  status: FeedbackStatus;
  adminUserId: string;
  resolutionNote?: string | null;
}): Promise<{ id: string; from: FeedbackStatus; excerpt: string | null } | null> {
  const db = await getDb();

  const [before] = await db
    .select({ status: feedback.status, text: feedback.text })
    .from(feedback)
    .where(eq(feedback.id, input.id))
    .limit(1);
  if (!before) return null;

  await db
    .update(feedback)
    .set({
      status: input.status,
      statusChangedAt: new Date(),
      statusChangedBy: input.adminUserId,
      // Only written when supplied, so reopening does not erase the note explaining why it
      // was closed the first time.
      ...(input.resolutionNote === undefined ? {} : { resolutionNote: input.resolutionNote }),
    })
    .where(eq(feedback.id, input.id));

  return {
    id: input.id,
    from: before.status,
    excerpt: before.text?.slice(0, 120) ?? null,
  };
}

/**
 * Remove one screenshot.
 *
 * Returns the blob URL so the caller can delete the object too. The row going is the
 * contract; the blob is cleanup.
 */
export async function deleteFeedbackScreenshot(
  id: string
): Promise<{ feedbackId: string; storage: string; blobUrl: string | null } | null> {
  const db = await getDb();
  const [row] = await db
    .select({
      feedbackId: feedbackScreenshots.feedbackId,
      storage: feedbackScreenshots.storage,
      blobUrl: feedbackScreenshots.blobUrl,
    })
    .from(feedbackScreenshots)
    .where(eq(feedbackScreenshots.id, id))
    .limit(1);
  if (!row) return null;

  await db.delete(feedbackScreenshots).where(eq(feedbackScreenshots.id, id));
  return row;
}
