/**
 * The panel's Home: what's due, and who you've touched lately.
 *
 * "Due" is exactly the reminders page's Today view — pending, due on or before
 * the viewer's today — through the same `dueDaySql`, so the panel and /reminders
 * can never disagree about what's due. That definition has one subtlety worth
 * knowing (see `reminder-due-bucket.ts`): a date-only reminder's day is its UTC
 * date, and only a timed one is converted into the viewer's zone.
 *
 * Two statements, in parallel. The due list is capped at 10 but its total is
 * exact (a window count on the same query), so "3 of 41 due" is never a guess.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, reminders } from "@/db/schema";
import { dueDaySql } from "@/lib/reminders-page-query";
import { dueDayOf, resolveTimeZone, ymdInZone } from "@/lib/reminder-due-bucket";
import type { HomeResponse } from "./contract";
import { SEARCH_RESULT_COLUMNS } from "./search";

const DUE_LIMIT = 10;
const RECENT_LIMIT = 8;

export async function loadHome(userId: string, rawTz: string | null): Promise<HomeResponse> {
  const tz = resolveTimeZone(rawTz);
  const today = ymdInZone(new Date(), tz);
  const db = await getDb();
  const dueDay = dueDaySql(tz);

  const [due, recent] = await Promise.all([
    db
      .select({
        id: reminders.id,
        title: reminders.title,
        dueDate: reminders.dueDate,
        contactId: contacts.id,
        contactName: contacts.fullName,
        contactPhoto: SEARCH_RESULT_COLUMNS.photoUrl,
        total: sql<number>`count(*) over ()`.mapWith(Number),
      })
      .from(reminders)
      .leftJoin(
        contacts,
        and(eq(contacts.id, reminders.contactId), eq(contacts.userId, userId))
      )
      .where(
        and(
          eq(reminders.userId, userId),
          eq(reminders.status, "pending"),
          sql`${dueDay} <= ${today}::date`
        )
      )
      .orderBy(sql`${reminders.dueDate} asc nulls last`)
      .limit(DUE_LIMIT),
    db
      .select(SEARCH_RESULT_COLUMNS)
      .from(contacts)
      .where(eq(contacts.userId, userId))
      .orderBy(desc(contacts.updatedAt))
      .limit(RECENT_LIMIT),
  ]);

  return {
    today,
    dueReminders: due.map((row) => {
      const day = dueDayOf(row.dueDate, tz);
      return {
        id: row.id,
        title: row.title,
        dueDate: row.dueDate ? row.dueDate.toISOString() : null,
        overdue: day !== null && day < today,
        contact: row.contactId
          ? { id: row.contactId, fullName: row.contactName ?? "", photoUrl: row.contactPhoto }
          : null,
      };
    }),
    dueReminderTotal: due[0]?.total ?? 0,
    recentContacts: recent,
  };
}
