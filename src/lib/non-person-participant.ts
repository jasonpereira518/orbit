/**
 * Calendar participants that are not people: Google group and resource calendars ("External
 * Stripe Interview Calendar 2"), meeting rooms and machine mailboxes. Calendar sync used
 * to save them as contacts.
 *
 * `isNonPersonParticipant` blocks them at ingest; `nonPersonContactSql` is its twin over the
 * `contacts` row, for the People list and `scripts/cleanup-non-person-contacts.ts`. Kept in step
 * by `scripts/smoke-non-person-participant.ts`. Both read `contacts.email` (the denormalised
 * primary) only: calendar sync writes the attendee address there, and it keeps the list cheap.
 *
 * Wrong in one direction only, on purpose: hiding a real person loses a relationship, while a
 * missed room costs one junk row.
 */
import { sql } from "drizzle-orm";
import { contacts } from "@/db/schema";
import { AUTOMATED_LOCAL_PARTS } from "@/lib/email-activity";

/**
 * Mailboxes only a machine sends from: `isAutomatedAddress`'s list plus calendar and invite
 * senders. Deliberately not the wider role list (`isRoleEmail`): hello@, team@ and sales@ on
 * a founder's own domain are often one person.
 */
const MACHINE_LOCAL_PARTS = [
  ...new Set([
    ...AUTOMATED_LOCAL_PARTS,
    ...["noreply", "no-reply", "donotreply", "do-not-reply", "calendar", "invite", "invites", "event", "events"],
    ...["notification", "notifications", "mailer", "mailer-daemon", "bounce", "bounces", "postmaster", "updates"],
  ]),
];
const MACHINE_SET = new Set(MACHINE_LOCAL_PARTS);

/** group.calendar.google.com, resource.calendar.google.com, import.calendar.google.com. */
const CALENDAR_DOMAIN = "@(.+\\.)?calendar\\.google\\.com$";
/**
 * "Calendar" as a whole word, only with a digit or three+ words around it, so "Ann Calendar"
 * (a surname) passes while "Team Offsite Calendar" and "Interview Calendar 2" do not. Written
 * without `\b` (Postgres spells it `\y`) so one pattern serves JS and SQL.
 * ponytail: name heuristic for addresses that are NOT on a calendar domain (rooms on Outlook,
 * renamed resources); extend the phrase list when a new junk name shows up.
 */
const CALENDAR_WORD = "(^|[^a-z0-9])calendar($|[^a-z0-9])";
const CALENDAR_CONTEXT = "[0-9]|^[[:space:]]*[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]";
const ROOM_PHRASE = "(^|[^a-z0-9])(conference|meeting) room($|[^a-z0-9])";

const jsRe = (pattern: string) => new RegExp(pattern.replaceAll("[:space:]", "\\s"), "i");

/** Whether a participant (as calendar sync sees it) is a calendar, room or mailbox, not a person. */
export function isNonPersonParticipant(name: string | null | undefined, email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  // `ada+github@x.com` is still Ada, so the tag is dropped before the lookup.
  const base = e.split("@")[0]!.split("+")[0]!;
  if (e && (jsRe(CALENDAR_DOMAIN).test(e) || MACHINE_SET.has(base))) return true;
  const n = (name ?? "").trim();
  if (jsRe(ROOM_PHRASE).test(n)) return true;
  return jsRe(CALENDAR_WORD).test(n) && jsRe(CALENDAR_CONTEXT).test(n);
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
