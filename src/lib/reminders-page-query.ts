/**
 * The reminders page's query: filtering, ordering and keyset paging in Postgres.
 *
 * This replaces a `findMany({ limit: 500 })` that filtered and sorted in JS — anyone past
 * 500 reminders silently lost the rest, the same bug the contacts list and the
 * notification panel each had fixed. Takes `db` rather than calling `getDb()` and needs no
 * auth, so `scripts/smoke-reminders-page.ts` exercises this exact SQL.
 *
 * Ordering is a total order ending in `id`, with every element in the same direction,
 * because the cursor is a row-value comparison (see `listContactsPage` for the long form of
 * that rule):
 *   active views: (due day, due instant, id) ascending, undated last
 *   done:         (created_at, id) descending
 * The cursor carries timestamps as Postgres text, not JS Dates: `created_at` has
 * microseconds, and a millisecond-truncated cursor skips rows created in the same
 * millisecond as a page's last row.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { getDb } from "@/db";
import {
  contacts,
  reminders,
  suggestedReminders,
  type ReminderActionKind,
  type ReminderOrigin,
} from "@/db/schema";
import { dueDayOf, ymdInZone } from "@/lib/reminder-due-bucket";
import {
  REMINDERS_PAGE_SIZE,
  type ReminderRailCounts,
  type ReminderRow,
  type ReminderSource,
  type RemindersPage,
  type RemindersPageFilters,
} from "@/lib/reminders-page";

type Db = Awaited<ReturnType<typeof getDb>>;

/** Statuses the Done view shows. (`completed`, a legacy spelling, was migrated in schema v66.) */
const DONE_STATUSES = ["done"];

/**
 * `dueDayOf` in SQL: a date-only value (UTC midnight or noon, exactly) keeps its UTC date;
 * a timed value is read in the viewer's zone. NULL when undated.
 */
export function dueDaySql(tz: string, qualified = false): SQL<string | null> {
  // `qualified` for use inside a select projection (see the cursor columns below).
  const due = qualified ? sql.raw(`"reminders"."due_date"`) : sql`${reminders.dueDate}`;
  return sql<string | null>`(case
    when ${due} is null then null
    when (${due} at time zone 'UTC')::time in ('00:00:00', '12:00:00')
      then (${due} at time zone 'UTC')::date
    else (${due} at time zone ${tz})::date
  end)`;
}

const INFINITE_DAY = sql.raw(`'infinity'::date`);
const INFINITE_TS = sql.raw(`'infinity'::timestamptz`);

type ActiveCursor = { v: "a"; d: string; t: string; id: string };
type DoneCursor = { v: "d"; c: string; id: string };
type Cursor = ActiveCursor | DoneCursor;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined, done: boolean): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    // A cursor from the other ordering describes a position that does not exist in this
    // one. Starting over beats silently skipping or repeating reminders.
    if (!parsed || typeof parsed.id !== "string") return null;
    if (done ? parsed.v !== "d" : parsed.v !== "a") return null;
    return parsed as Cursor;
  } catch {
    return null;
  }
}

function escapeLike(q: string) {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function sourceCondition(source: ReminderSource): SQL | undefined {
  switch (source) {
    case "manual":
      return and(eq(reminders.reminderType, "manual"), isNull(reminders.noteBatchId));
    case "notes":
      return or(
        isNotNull(reminders.noteBatchId),
        inArray(reminders.reminderType, ["capture", "post_meeting", "extracted_date"])
      );
    case "ai":
      return and(eq(reminders.reminderType, "ai_suggested"), isNull(reminders.noteBatchId));
    case "auto":
      return eq(reminders.reminderType, "generated");
  }
}

/**
 * The WHERE for everything but the cursor. Shared by the page query and its total, so the
 * two can't disagree about what matches.
 */
function filterConditions(
  userId: string,
  filters: RemindersPageFilters,
  inboxId: string | null,
  today: string
): SQL[] {
  const dueDay = dueDaySql(filters.tz);
  const conds: SQL[] = [eq(reminders.userId, userId)];

  if (filters.listId) {
    conds.push(eq(reminders.status, "pending"));
    // Rows written before lists existed (or by paths that never set one) are Inbox rows.
    conds.push(
      filters.listId === inboxId
        ? (or(eq(reminders.listId, filters.listId), isNull(reminders.listId)) as SQL)
        : eq(reminders.listId, filters.listId)
    );
  } else {
    switch (filters.view ?? "today") {
      case "today":
        conds.push(eq(reminders.status, "pending"));
        conds.push(sql`${dueDay} <= ${today}::date`);
        break;
      case "upcoming":
        conds.push(eq(reminders.status, "pending"));
        conds.push(sql`${dueDay} > ${today}::date`);
        break;
      case "anytime":
        conds.push(eq(reminders.status, "pending"));
        conds.push(isNull(reminders.dueDate));
        break;
      case "done":
        conds.push(inArray(reminders.status, DONE_STATUSES));
        break;
    }
  }

  const q = filters.q?.trim();
  if (q) {
    const pattern = `%${escapeLike(q.toLowerCase())}%`;
    conds.push(sql`(
      lower(${reminders.title}) like ${pattern}
      or lower(coalesce(${reminders.description}, '')) like ${pattern}
      or lower(coalesce(${contacts.fullName}, '')) like ${pattern}
      or lower(coalesce(${contacts.preferredName}, '')) like ${pattern}
    )`);
  }
  if (filters.kinds?.length) conds.push(inArray(reminders.actionKind, filters.kinds));
  if (filters.sources?.length) {
    const parts = filters.sources.map(sourceCondition).filter((c): c is SQL => Boolean(c));
    if (parts.length) conds.push(or(...parts) as SQL);
  }
  if (filters.contactId) conds.push(eq(reminders.contactId, filters.contactId));
  return conds;
}

export async function queryRemindersPage(
  db: Db,
  userId: string,
  filters: RemindersPageFilters,
  opts: { inboxId: string | null; now?: Date }
): Promise<RemindersPage> {
  const today = ymdInZone(opts.now ?? new Date(), filters.tz);
  const limit = Math.max(1, Math.min(200, filters.limit ?? REMINDERS_PAGE_SIZE));
  const done = !filters.listId && filters.view === "done";
  const dueDay = dueDaySql(filters.tz);

  const conds = filterConditions(userId, filters, opts.inboxId, today);
  const cursor = decodeCursor(filters.cursor, done);
  const withCursor = [...conds];
  if (cursor?.v === "a") {
    withCursor.push(sql`(
      coalesce(${dueDay}, ${INFINITE_DAY}),
      coalesce(${reminders.dueDate}, ${INFINITE_TS}),
      ${reminders.id}
    ) > (${cursor.d}::date, ${cursor.t}::timestamptz, ${cursor.id}::uuid)`);
  } else if (cursor?.v === "d") {
    withCursor.push(
      sql`(${reminders.createdAt}, ${reminders.id}) < (${cursor.c}::timestamptz, ${cursor.id}::uuid)`
    );
  }

  const orderBy = done
    ? [sql`${reminders.createdAt} desc`, sql`${reminders.id} desc`]
    : [
        sql`coalesce(${dueDay}, ${INFINITE_DAY}) asc`,
        sql`coalesce(${reminders.dueDate}, ${INFINITE_TS}) asc`,
        sql`${reminders.id} asc`,
      ];

  // The join serves search (contact names) and the row's contact fields in one pass.
  const contactJoin = and(eq(contacts.id, reminders.contactId), eq(contacts.userId, userId));

  const rowsPromise = db
    .select({
      id: reminders.id,
      title: reminders.title,
      description: reminders.description,
      dueDate: reminders.dueDate,
      status: reminders.status,
      reminderType: reminders.reminderType,
      actionKind: reminders.actionKind,
      origin: reminders.origin,
      confidenceScore: reminders.confidenceScore,
      listId: reminders.listId,
      contactId: reminders.contactId,
      contactFullName: contacts.fullName,
      contactPreferredName: contacts.preferredName,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactLastTouch: contacts.lastInteractionAt,
      noteBatchId: reminders.noteBatchId,
      sourceExcerpt: reminders.sourceExcerpt,
      rawDatePhrase: reminders.rawDatePhrase,
      createdAt: reminders.createdAt,
      // Cursor material, exact (see the header comment). Spelled with qualified raw names:
      // a column interpolated into a projection's sql`` loses its table prefix, and with
      // `contacts` joined, an unqualified `created_at` is ambiguous.
      cursorDay: sql<string>`coalesce(${dueDaySql(filters.tz, true)}, ${INFINITE_DAY})::text`,
      cursorDue: sql<string>`coalesce("reminders"."due_date", ${INFINITE_TS})::text`,
      cursorCreated: sql<string>`"reminders"."created_at"::text`,
    })
    .from(reminders)
    .leftJoin(contacts, contactJoin)
    .where(and(...withCursor))
    .orderBy(...orderBy)
    // One extra row answers "is there more" without a second count.
    .limit(limit + 1);

  const totalPromise = cursor
    ? Promise.resolve(null)
    : db
        .select({ n: sql<number>`count(*)::int` })
        .from(reminders)
        .leftJoin(contacts, contactJoin)
        .where(and(...conds))
        .then((r) => Number(r[0]?.n ?? 0));

  const [rows, total] = await Promise.all([rowsPromise, totalPromise]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  const items: ReminderRow[] = page.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    dueDate: r.dueDate ? r.dueDate.toISOString() : null,
    dueDay: dueDayOf(r.dueDate, filters.tz),
    status: r.status,
    reminderType: r.reminderType,
    actionKind: (r.actionKind || "task") as ReminderActionKind,
    origin: (r.origin || "explicit") as ReminderOrigin,
    confidenceScore: r.confidenceScore,
    listId: r.listId ?? opts.inboxId,
    contactId: r.contactId,
    contactName: r.contactId
      ? r.contactPreferredName?.trim() || r.contactFullName || null
      : null,
    contactEmail: r.contactEmail ?? null,
    contactPhone: r.contactPhone ?? null,
    contactLastTouch: r.contactLastTouch ? r.contactLastTouch.toISOString() : null,
    noteBatchId: r.noteBatchId,
    sourceExcerpt: r.sourceExcerpt,
    rawDatePhrase: r.rawDatePhrase,
    createdAt: r.createdAt.toISOString(),
  }));

  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor(
            done
              ? { v: "d", c: last.cursorCreated, id: last.id }
              : { v: "a", d: last.cursorDay, t: last.cursorDue, id: last.id }
          )
        : null,
    total,
    today,
  };
}

/**
 * The rail's counts, unfiltered by search or chips: they describe the views, not the
 * current result. One statement for the smart views, one for the lists.
 */
export async function queryReminderRailCounts(
  db: Db,
  userId: string,
  opts: { tz: string; inboxId: string | null; now?: Date }
): Promise<{ counts: ReminderRailCounts; pendingByList: Map<string, number> }> {
  const today = ymdInZone(opts.now ?? new Date(), opts.tz);
  const dueDay = dueDaySql(opts.tz);
  const pending = sql`${reminders.status} = 'pending'`;

  const [viewRows, listRows, suggestedRows] = await Promise.all([
    db
      .select({
        today: sql<number>`count(*) filter (where ${pending} and ${dueDay} <= ${today}::date)::int`,
        overdue: sql<number>`count(*) filter (where ${pending} and ${dueDay} < ${today}::date)::int`,
        upcoming: sql<number>`count(*) filter (where ${pending} and ${dueDay} > ${today}::date)::int`,
        anytime: sql<number>`count(*) filter (where ${pending} and ${reminders.dueDate} is null)::int`,
        done: sql<number>`count(*) filter (where ${inArray(reminders.status, DONE_STATUSES)})::int`,
      })
      .from(reminders)
      .where(eq(reminders.userId, userId)),
    db
      .select({ listId: reminders.listId, n: sql<number>`count(*)::int` })
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.status, "pending")))
      .groupBy(reminders.listId),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(suggestedReminders)
      .where(
        and(eq(suggestedReminders.userId, userId), eq(suggestedReminders.status, "pending"))
      ),
  ]);

  const pendingByList = new Map<string, number>();
  for (const row of listRows) {
    const key = row.listId ?? opts.inboxId;
    if (!key) continue;
    pendingByList.set(key, (pendingByList.get(key) ?? 0) + Number(row.n));
  }

  const v = viewRows[0];
  return {
    counts: {
      today: Number(v?.today ?? 0),
      overdue: Number(v?.overdue ?? 0),
      upcoming: Number(v?.upcoming ?? 0),
      anytime: Number(v?.anytime ?? 0),
      done: Number(v?.done ?? 0),
      suggested: Number(suggestedRows[0]?.n ?? 0),
    },
    pendingByList,
  };
}
