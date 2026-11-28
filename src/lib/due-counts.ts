import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { dueDaySql } from "@/lib/reminders-page-query";
import { ymdInZone } from "@/lib/reminder-due-bucket";
import { alertableContactSql, alertableReminderSql } from "@/lib/met-contact";

/**
 * Due reminders, as `getDueCounts` counts them: pending, alertable, due on or before `today`
 * by the bucket rule, minus the two kinds the Due follow-ups row already shows for a due
 * contact. Raw `reminders.` names, so it fits any statement that reads the table unaliased.
 */
export function dueReminderWhereSql(userId: string, tz: string, today: string, now: Date) {
  return sql`reminders.user_id = ${userId}
    and reminders.status = 'pending'
    and ${dueDaySql(tz)} <= ${today}::date
    and ${alertableReminderSql(userId)}
    and not (
      reminders.contact_id is not null
      and exists (
        select 1 from contacts due
         where due.id = reminders.contact_id
           and due.user_id = ${userId}
           and ${alertableContactSql(sql`due.id`, userId)}
           and date_trunc('milliseconds', due.next_follow_up_at) <= ${now.toISOString()}::timestamptz
           and (
             reminders.reminder_type = 'generated'
             or (
               due.next_follow_up_at = reminders.due_date
               and reminders.title = 'Follow up with ' || coalesce(nullif(due.preferred_name, ''), due.full_name)
             )
           )
      )
    )`;
}

/** Due follow-ups, as `getDueCounts` counts them: the clock has run out and the contact may alert. */
export function dueFollowUpWhereSql(userId: string, now: Date) {
  return sql`contacts.user_id = ${userId}
    and contacts.next_follow_up_at <= ${now.toISOString()}::timestamptz
    and ${alertableContactSql(sql`contacts.id`, userId)}`;
}

/**
 * How much a due item matters, lower first; `IMPORTANT_TIER` and under is what Cosmo names.
 *   0  critical reminder
 *   1  high reminder; follow-up with someone in the inner circle or marked high priority
 *   2  normal reminder the person wrote; follow-up in the mid circle or at priority 1
 *   3  everything else: low, and normal ones Orbit made (notes, calendar, generated); outer
 * One definition for the count (`getDueCounts().important`) and the list (`loadTopDue`).
 */
export const IMPORTANT_TIER = 1;
export const reminderTierSql = sql`(case reminders.priority
  when 'critical' then 0
  when 'high' then 1
  when 'normal' then case when reminders.created_by = 'user' then 2 else 3 end
  else 3 end)`;
// ponytail: reads the stored tier, which may lag a fresh closeness pass; same read as
// `loadDueFollowUps` when its scores are current.
export const followUpTierSql = sql`(case
  when contacts.closeness_breakdown->>'tier' = 'inner' or contacts.priority_level >= 2 then 1
  when contacts.closeness_breakdown->>'tier' = 'mid' or contacts.priority_level = 1 then 2
  else 3 end)`;

/**
 * THE count of what is due, for the dashboard tiles, the bell and the Cosmo chip. Lists keep
 * their own queries; only the numbers come from here.
 *
 *   - `reminders`: `dueReminderWhereSql`. Undated and upcoming are not due.
 *   - `followUps`: `dueFollowUpWhereSql`.
 *   - `important`: of those, the ones at `IMPORTANT_TIER` or under, counted in the same
 *     statement (the pulse reads this, so it must not add a round trip).
 *
 * Reminders use the whole-day rule (anything due today counts, even later today); follow-ups use
 * `<= now` (the clock has run out), as the brief says.
 *
 * The paired contact must itself be alertable, as in the bell's own pairing
 * (`loadNotificationPanel`): otherwise a reminder would be dropped here while its follow-up row
 * is not counted either, and the work would be counted nowhere.
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
): Promise<{ reminders: number; followUps: number; total: number; important: number }> {
  const db = database ?? (await getDb());
  const today = ymdInZone(now, tz);
  const result = await db.execute(sql`
    select r.n as reminders, r.imp as r_imp, f.n as follow_ups, f.imp as f_imp
      from (select count(*)::int as n,
                   (count(*) filter (where ${reminderTierSql} <= ${IMPORTANT_TIER}))::int as imp
              from reminders
             where ${dueReminderWhereSql(userId, tz, today, now)}) r,
           (select count(*)::int as n,
                   (count(*) filter (where ${followUpTierSql} <= ${IMPORTANT_TIER}))::int as imp
              from contacts
             where ${dueFollowUpWhereSql(userId, now)}) f
  `);
  const row = rowsOf<{ reminders: number; follow_ups: number; r_imp: number; f_imp: number }>(result)[0];
  const r = Number(row?.reminders ?? 0);
  const f = Number(row?.follow_ups ?? 0);
  return { reminders: r, followUps: f, total: r + f, important: Number(row?.r_imp ?? 0) + Number(row?.f_imp ?? 0) };
}

export type TopDueItem = {
  kind: "reminder" | "follow_up";
  id: string;
  /** The reminder's title, or the person to follow up with. */
  label: string;
  /** Who it's about, when a reminder names someone. */
  contactName: string | null;
  tier: number;
  /** Why it made the list, in words a voice can say ("high priority", "inner circle"). */
  why: string;
  /** ISO: the reminder's due date, or when the follow-up clock ran out. */
  due: string;
};

const REMINDER_WHY = ["critical", "high priority", "your reminder", "lower priority"];
const FOLLOW_UP_WHY = ["", "close contact", "mid circle", "outer circle"];

/**
 * The few due things worth saying out loud, most important first: the same items
 * `getDueCounts` counts, ranked by tier, then by how long they've been due. Two reads capped
 * at `limit`, plus the count, so `total - items.length` is honestly "the rest".
 */
export async function loadTopDue(
  userId: string,
  tz: string,
  now: Date = new Date(),
  limit = 3
): Promise<{ items: TopDueItem[]; important: number; total: number }> {
  const db = await getDb();
  const today = ymdInZone(now, tz);
  const [rem, fol, counts] = await Promise.all([
    db.execute(sql`
      select reminders.id, reminders.title, reminders.due_date, ${reminderTierSql} as tier,
             coalesce(nullif(c.preferred_name, ''), c.full_name) as contact_name
        from reminders
        left join contacts c on c.id = reminders.contact_id and c.user_id = ${userId}
       where ${dueReminderWhereSql(userId, tz, today, now)}
       order by tier, ${dueDaySql(tz)}, reminders.due_date, reminders.id
       limit ${limit}`),
    db.execute(sql`
      select contacts.id, coalesce(nullif(contacts.preferred_name, ''), contacts.full_name) as name,
             contacts.next_follow_up_at, ${followUpTierSql} as tier
        from contacts
       where ${dueFollowUpWhereSql(userId, now)}
       order by tier, contacts.next_follow_up_at, contacts.id
       limit ${limit}`),
    getDueCounts(userId, tz, now, db),
  ]);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : "");
  const items: TopDueItem[] = [
    ...rowsOf<{ id: string; title: string; due_date: unknown; tier: number; contact_name: string | null }>(rem).map(
      (r) => ({
        kind: "reminder" as const,
        id: r.id,
        label: r.title,
        contactName: r.contact_name ?? null,
        tier: Number(r.tier),
        why: REMINDER_WHY[Number(r.tier)] ?? "",
        due: iso(r.due_date),
      })
    ),
    ...rowsOf<{ id: string; name: string; next_follow_up_at: unknown; tier: number }>(fol).map((c) => ({
      kind: "follow_up" as const,
      id: c.id,
      label: `Follow up with ${c.name}`,
      contactName: c.name,
      tier: Number(c.tier),
      why: FOLLOW_UP_WHY[Number(c.tier)] ?? "",
      due: iso(c.next_follow_up_at),
    })),
  ]
    .sort((a, b) => a.tier - b.tier || a.due.localeCompare(b.due) || a.id.localeCompare(b.id))
    .slice(0, limit);
  return { items, important: counts.important, total: counts.total };
}
