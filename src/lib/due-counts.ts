import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { dueDaySql } from "@/lib/reminders-page-query";
import { ymdInZone } from "@/lib/reminder-due-bucket";
import { alertableContactSql, alertableReminderSql } from "@/lib/met-contact";

/**
 * THE count of what is due, for the dashboard tiles, the Reminders rail, the bell and the
 * Cosmo chip. Lists keep their own queries; only the numbers come from here.
 *
 *   - `reminders`: pending, alertable (`alertableReminderSql`), due on or before the viewer's
 *     today (`dueDaySql`, the bucket rule), minus the two kinds the Due follow-ups row already
 *     shows for a due contact (a generated reminder, and the day-preset twin of the clock;
 *     same pairing as `loadDashboardReminders`). Undated and upcoming are not due.
 *   - `followUps`: contacts whose clock has run out (`next_follow_up_at <= now()`) and that may
 *     alert (`alertableContactSql`).
 *
 * Because the pairing is removed from `reminders`, `total = reminders + followUps` never counts
 * one piece of work twice.
 */
export async function getDueCounts(
  userId: string,
  tz: string,
  now: Date = new Date(),
  // For a caller that already holds a handle (the reminders rail, whose smoke runs its own).
  database?: Awaited<ReturnType<typeof getDb>>
): Promise<{ reminders: number; followUps: number; total: number }> {
  const db = database ?? (await getDb());
  const today = ymdInZone(now, tz);
  const result = await db.execute(sql`
    select
      (select count(*) from reminders
        where reminders.user_id = ${userId}
          and reminders.status = 'pending'
          and ${dueDaySql(tz)} <= ${today}::date
          and ${alertableReminderSql(userId)}
          and not (
            reminders.contact_id is not null
            and exists (
              select 1 from contacts due
               where due.id = reminders.contact_id
                 and due.user_id = ${userId}
                 and date_trunc('milliseconds', due.next_follow_up_at) <= ${now.toISOString()}::timestamptz
                 and (
                   reminders.reminder_type = 'generated'
                   or (
                     due.next_follow_up_at = reminders.due_date
                     and reminders.title = 'Follow up with ' || coalesce(nullif(due.preferred_name, ''), due.full_name)
                   )
                 )
            )
          )
      )::int as reminders,
      (select count(*) from contacts
        where contacts.user_id = ${userId}
          and contacts.next_follow_up_at <= ${now.toISOString()}::timestamptz
          and ${alertableContactSql(sql`contacts.id`, userId)}
      )::int as follow_ups
  `);
  const row = rowsOf<{ reminders: number; follow_ups: number }>(result)[0];
  const r = Number(row?.reminders ?? 0);
  const f = Number(row?.follow_ups ?? 0);
  return { reminders: r, followUps: f, total: r + f };
}
