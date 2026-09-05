/**
 * How every connector mints `interactions.external_id`.
 *
 * That column carries the partial unique index `interactions_user_external_uidx`
 * `(user_id, external_id) WHERE external_id IS NOT NULL`, which is the entire re-import and
 * re-sync dedupe story: writing the same id twice updates one row instead of creating a
 * second. So the id's *format* is a data contract, not an implementation detail. If two
 * producers of the same underlying event disagree by a single character, every one of those
 * events silently doubles, and no test that looks at one producer in isolation can see it.
 *
 * This module exists because that had already happened in miniature: `calendar.ts` (the
 * one-shot file import) and `calendar-sync.ts` (the ongoing ICS subscription) each computed
 * `cal:${eventUid}:${contactId}` from their own private copy of the formula. They agreed, but
 * only by inspection. Now there is one copy and drift is not expressible.
 *
 * The split between `base` and `contactId` is deliberate. The producer knows how to name the
 * *event* — its namespace prefix and the provider's stable identifier — and only the producer
 * can know that. The ingest layer knows that an event fans out to one interaction per matched
 * participant, and appends the contact. Producers must never append the contact themselves.
 */

/**
 * One interaction per (event, participant).
 *
 * The contact suffix is load-bearing. A calendar event reaches ingest once per matched
 * attendee, so keying on the event alone would make every attendee of one meeting collide on
 * the unique index. Within a single batch that surfaces loudly as "ON CONFLICT DO UPDATE
 * command cannot affect row a second time"; across batches it is quieter and worse — the
 * second attendee's row overwrites the first's, and one attendee's meeting is lost rather
 * than logged.
 */
export function interactionExternalId(base: string, contactId: string): string {
  return `${base}:${contactId}`;
}

/**
 * The event half of a calendar meeting's id.
 *
 * Google Calendar's `iCalUID` is the same string as the `UID` in an .ics export of that
 * calendar, so a user who both uploads an .ics file and connects Google Calendar produces
 * one interaction per (event, contact) rather than two. That property is why the API
 * connector must key on `iCalUID` and never on the provider-local `event.id`.
 */
export function calendarExternalIdBase(eventUid: string): string {
  return `cal:${eventUid}`;
}
