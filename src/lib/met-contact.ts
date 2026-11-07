/**
 * Has the user actually met, or talked with, this person?
 *
 * The question every unprompted alert has to answer first. A contact row says only that
 * somebody is in the address book: a bulk LinkedIn or Google import creates thousands of
 * people the user has never spoken to, and every producer that ran over `contacts` alerted
 * about them. This is the rule those producers share.
 *
 * It is stricter than `constellationEligibility`, on purpose: that one answers "does this
 * person matter to the user" (so a stated rating, a priority or a scheduled follow-up all
 * qualify), which is circular here, since a generated follow-up would make its own contact
 * eligible. Intent is not evidence. It also counts future-dated calendar rows and accepts
 * undirected message volume; neither proves a conversation.
 *
 * Evidence, any one of:
 *  - a past-dated meeting, in-person, call or event interaction (an event interaction is what
 *    "I spoke to them" at an event writes),
 *  - a note interaction (typed note rows only, never `contacts.notes`: outreach and address
 *    book prose land there),
 *  - messages both ways, with direction known (a thread nobody answered is a broadcast).
 * A manual `constellation_pin = 'out'` always wins: the user said to leave this person alone.
 * `ai_derived` rows are never evidence (`AI_DERIVED_SOURCE`).
 *
 * The pure function and the SQL twin below are held equal by `scripts/smoke-met-contact.ts`.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, reminders } from "@/db/schema";
import { AI_DERIVED_SOURCE, MEETING_TOUCH_TYPES, sqlList } from "@/lib/touch-kinds";

/** Time spent together. `event` is not a touch kind (constellation ignores it) but it is a meeting of people. */
export const ENCOUNTER_TYPES = [...MEETING_TOUCH_TYPES, "event"] as const;

export type MetSignals = {
  pin: "in" | "out" | null;
  /** Any `ENCOUNTER_TYPES` interaction dated at or before now, source not `ai_derived`. */
  pastEncounters: number;
  /** `contact_touch_counts`: note rows, and directed messages each way. */
  noteInteractions: number;
  messageInbound: number;
  messageOutbound: number;
};

export function hasMetOrConversed(s: MetSignals): boolean {
  if (s.pin === "out") return false;
  return (
    s.pastEncounters > 0 ||
    s.noteInteractions > 0 ||
    (s.messageInbound >= 1 && s.messageOutbound >= 1)
  );
}

/**
 * `hasMetOrConversed` for the contact whose id is `contactId` (a column or any uuid
 * expression), as a boolean SQL fragment. Self-contained: it reads the pin and the evidence
 * itself, so it works inside `db.query` filters, `.select()` and raw SQL alike.
 */
export function metContactSql(contactId: SQL, userId: string): SQL {
  return sql`(
    not exists (select 1 from contacts met_pin where met_pin.id = ${contactId} and met_pin.constellation_pin = 'out')
    and (
      exists (
        select 1 from contact_touch_counts met_t
         where met_t.contact_id = ${contactId}
           and (met_t.note_interactions > 0 or (met_t.message_inbound >= 1 and met_t.message_outbound >= 1))
      )
      or exists (
        select 1 from interactions met_i
         where met_i.user_id = ${userId}
           and met_i.contact_id = ${contactId}
           and met_i.interaction_type in ${sql.raw(sqlList(ENCOUNTER_TYPES))}
           and met_i.interaction_date <= now()
           and (met_i.source is null or met_i.source <> ${AI_DERIVED_SOURCE})
      )
    )
  )`;
}

/**
 * Every contact the user has met or talked with, or, given `ids`, which of those. The
 * all-contacts form starts from the evidence (two index-driven reads, unioned) rather than
 * testing each contact, so it costs the size of the user's real relationships, not of their
 * imported address book.
 *
 * ponytail: the `ids` form is one `id IN (...)` read, so pass a bounded list (a few hundred).
 */
export async function metContactIds(userId: string, ids?: readonly string[]): Promise<Set<string>> {
  if (ids && ids.length === 0) return new Set();
  const db = await getDb();
  if (ids) {
    const rows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(contacts.id, [...ids]), metContactSql(sql`${contacts.id}`, userId)));
    return new Set(rows.map((r) => r.id));
  }
  const res = await db.execute(sql`
    select c.id from contacts c
     where c.user_id = ${userId}
       and c.constellation_pin is distinct from 'out'
       and c.id in (
         select contact_id from contact_touch_counts
          where user_id = ${userId}
            and (note_interactions > 0 or (message_inbound >= 1 and message_outbound >= 1))
         union
         select contact_id from interactions
          where user_id = ${userId}
            and interaction_type in ${sql.raw(sqlList(ENCOUNTER_TYPES))}
            and interaction_date <= now()
            and (source is null or source <> ${AI_DERIVED_SOURCE})
       )
  `);
  return new Set(rowsOf<{ id: string }>(res).map((r) => r.id));
}

/**
 * May a generated reminder about this contact raise an alert (bell badge, desktop notification)?
 * Reminders the user wrote themselves always may: they asked for them. Everything Orbit
 * generated (`created_by` anything but `user`: system, ai, calendar_sync, import) may only
 * when the person has been met or talked with. A reminder about nobody is the user's to keep.
 * For a `db.query.reminders` or `.from(reminders)` filter.
 */
export function alertableReminderSql(userId: string): SQL {
  return sql`(
    ${reminders.createdBy} = 'user'
    or ${reminders.contactId} is null
    or ${metContactSql(sql`${reminders.contactId}`, userId)}
  )`;
}

/**
 * May this contact's own `next_follow_up_at` raise an alert? That column is a mirror of the
 * reminders (`reminders.ts` writes it from the pending reminder's due date, and generated
 * follow-ups set it to now), so it carries no author of its own. It may when the person has
 * been met or talked with, or when the user has a pending reminder of their own about them.
 */
export function alertableContactSql(contactId: SQL, userId: string): SQL {
  return sql`(
    ${metContactSql(contactId, userId)}
    or exists (
      select 1 from reminders own_r
       where own_r.user_id = ${userId}
         and own_r.contact_id = ${contactId}
         and own_r.status = 'pending'
         and own_r.created_by = 'user'
    )
  )`;
}
