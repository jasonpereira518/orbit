/**
 * Calendar participants that are not people: Google group and resource calendars ("External
 * Stripe Interview Calendar 2"), meeting rooms and machine mailboxes. Calendar sync used
 * to save them as contacts.
 *
 * `isNonPersonParticipant` blocks them at ingest; `nonPersonContactSql` is its twin over the
 * `contacts` row, for the People list and `scripts/cleanup-non-person-contacts.ts`. Kept in step
 * by `scripts/smoke-non-person-participant.ts`. Both read `contacts.email` (the denormalised
 * primary) only: calendar sync writes the attendee address there, and it keeps the list cheap.
 * The lists and patterns themselves live in `@/lib/names/classify`.
 *
 * Wrong in one direction only, on purpose: hiding a real person loses a relationship, while a
 * missed room costs one junk row. That is also why role inboxes (hello@, team@, sales@) are
 * not here: on a founder's own domain they are often one person.
 */
import { sql } from "drizzle-orm";
import { contacts } from "@/db/schema";
import {
  CALENDAR_CONTEXT,
  CALENDAR_DOMAIN,
  CALENDAR_WORD,
  classifyMailbox,
  isRoomName,
  MACHINE_LOCAL_PARTS,
  ROOM_PHRASE,
} from "@/lib/names/classify";

/** Whether a participant (as calendar sync sees it) is a calendar, room or mailbox, not a person. */
export function isNonPersonParticipant(name: string | null | undefined, email: string | null | undefined): boolean {
  return isNonPersonEmail(email) || isRoomName(name);
}

/** The address alone says calendar or machine mailbox; a match on the name alone could be a person. */
export function isNonPersonEmail(email: string | null | undefined): boolean {
  return classifyMailbox(email) === "machine";
}

/** SQL twin of `isNonPersonParticipant` over `contacts`. */
export function nonPersonContactSql() {
  const email = sql`lower(trim(coalesce(${contacts.email}, '')))`;
  const local = sql`split_part(${email}, '@', 1)`;
  const name = sql`trim(${contacts.fullName})`;
  const machine = sql.join(MACHINE_LOCAL_PARTS.map((p) => sql`${p}`), sql`, `);
  return sql`((${email} <> '' AND (
      ${email} ~ ${CALENDAR_DOMAIN}
      OR split_part(${local}, '+', 1) IN (${machine})))
    OR ${name} ~* ${ROOM_PHRASE}
    OR (${name} ~* ${CALENDAR_WORD} AND ${name} ~ ${CALENDAR_CONTEXT}))`;
}
