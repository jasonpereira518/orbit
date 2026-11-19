import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { alertableContactSql, alertableReminderSql } from "@/lib/met-contact";

/** Counts all due items, including those beyond the notification preview. */
export async function getDueAttentionCounts(userId: string, now: Date) {
  const db = await getDb();
  const instant = sql`${now.toISOString()}::timestamptz`;
  const result = await db.execute(sql`
    with due_contacts as (
      select contacts.id, contacts.next_follow_up_at, contacts.preferred_name, contacts.full_name
      from contacts
      where contacts.user_id = ${userId}
        and contacts.next_follow_up_at <= ${instant}
        and ${alertableContactSql(sql`contacts.id`, userId)}
    )
    select
      (select count(*) from due_contacts)::int as follow_ups,
      (select count(*) from reminders
        where reminders.user_id = ${userId}
          and reminders.status = 'pending'
          and reminders.due_date <= ${instant}
          and ${alertableReminderSql(userId)}
          and not exists (
            select 1 from due_contacts due where due.id = reminders.contact_id
              and (reminders.reminder_type = 'generated'
                or (date_trunc('milliseconds', due.next_follow_up_at) = date_trunc('milliseconds', reminders.due_date)
                  and reminders.title = 'Follow up with ' || coalesce(nullif(due.preferred_name, ''), due.full_name)))
          ))::int as reminders
  `);
  const row = rowsOf<{ follow_ups: number; reminders: number }>(result)[0];
  return { followUps: row?.follow_ups ?? 0, reminders: row?.reminders ?? 0 };
}
