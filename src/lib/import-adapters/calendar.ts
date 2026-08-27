import type { CalendarEventRowPayload } from "@/db/schema";
import type { ContactInput } from "@/lib/contact-writes";
import { daysAgo } from "@/lib/duplicates";
import type { ImportAdapter, InteractionInsert, ReminderInsert } from "@/lib/import-engine";

/**
 * The two `imports.import_type` values a calendar upload can carry, depending on the file
 * the user exported (an .ics from Google/Apple/Outlook, or a CSV). Both are driven by the
 * same `calendarAdapter` below — one adapter registered under two keys in
 * `import-adapters/index.ts` — because the two formats produce the exact same row shape
 * (`CalendarEventRowPayload`) once `confirmCalendarImport` has parsed them; the only
 * difference is which parser ran, which is already resolved before a job row ever exists.
 */
export const CALENDAR_ICS_IMPORT_TYPE = "calendar_ics";
export const CALENDAR_CSV_IMPORT_TYPE = "calendar_csv";

/**
 * `interactions.externalId` for a calendar meeting. Keyed on **both** the event and the
 * contact, not the event alone: a calendar import explodes one event into one job row per
 * attendee (see `CalendarEventRowPayload`'s doc comment), so the same `eventUid` reaches this
 * function once per matched attendee, each time with a different `contactId`. Keying on
 * `eventUid` alone would make every attendee of the same event collide on the
 * `(user_id, external_id)` unique index. Since Task 15 that insert is an
 * `onConflictDoUpdate`, not `onConflictDoNothing`, so the failure mode is not the silent
 * drop this comment used to describe: two attendees of one event inside a single chunk hit
 * "ON CONFLICT DO UPDATE command cannot affect row a second time" and the write throws —
 * which is precisely why the engine grew an intra-batch dedupe on `externalId`. Across
 * chunks it would be quieter and worse: the second attendee's row would overwrite the
 * first's, so one attendee's meeting would be lost rather than logged. The (event, contact)
 * pair is unique per attendee, so neither happens.
 */
export function calendarMeetingExternalId(eventUid: string, contactId: string) {
  return `cal:${eventUid}:${contactId}`;
}

function eventDateOf(payload: CalendarEventRowPayload): Date {
  return payload.start ? new Date(payload.start) : new Date();
}

/**
 * Calendar ingest never creates contacts — it only annotates people already in the network.
 * `createsContacts: false` routes every unmatched row to `skipped` instead of `toCreate`, and
 * skips the plan's contact-headroom check entirely (see `runImportJob`): a calendar file
 * cannot push a free user over their contact limit, because it adds nobody.
 *
 * Matching uses a 0.6 confidence floor — the weakest tier `findDuplicateCandidatesIndexed`
 * produces (a bare full-name hit), well below the 0.85 `DUPLICATE_MERGE_CONFIDENCE` floor
 * every contact-*creating* adapter uses to decide "these two rows are the same person, merge
 * them." Calendar isn't making that call: logging a meeting against a same-named contact is a
 * much smaller mistake than silently merging two different people, so it can accept a weaker
 * match than a create-or-merge decision could. See `matchConfidence` below and its doc
 * comment on `ImportAdapter` for where that floor is actually enforced.
 */
export const calendarAdapter: ImportAdapter<CalendarEventRowPayload> = {
  createsContacts: false,
  matchConfidence: 0.6,

  identity(payload) {
    if (!payload.attendeeEmail && !payload.attendeeName) return null;
    return {
      fullName: payload.attendeeName || undefined,
      email: payload.attendeeEmail || undefined,
    };
  },

  toCreate(): ContactInput {
    // Unreachable: `createsContacts: false` means the engine never takes the create
    // branch. Throwing rather than returning something plausible is the point — a calendar
    // file must never be able to add people to a network, and a silent fallback here is
    // exactly how that would happen if the flag were ever dropped.
    throw new Error("calendar import does not create contacts");
  },

  /**
   * The only contact fields a calendar match may touch: the attendee's email (fills a blank,
   * never overwrites — `bulkMergeContactsForUser` COALESCEs), and the event's date widening
   * `firstInteractionAt`/`lastInteractionAt` via `LEAST`/`GREATEST`. Nothing else — a calendar
   * upload has no company/title/name data worth trusting over what's already on the contact.
   *
   * The widened timestamps used to require the importer to read `lastInteractionAt`/
   * `firstInteractionAt` off the matched contact first (Task 5 could not narrow that query
   * for exactly this reason). That's no longer true: `bulkMergeContactsForUser` widens
   * server-side against whatever the row currently holds, so this only ever needs to supply
   * this one event's date — the six-column duplicate index (which doesn't carry either
   * timestamp) is enough to match on, and nothing here reads the matched contact's fields.
   */
  toMerge(payload) {
    const eventDate = eventDateOf(payload);
    return {
      email: payload.attendeeEmail || undefined,
      firstInteractionAt: eventDate,
      lastInteractionAt: eventDate,
    };
  },

  interactions(payload, contactId, userId): InteractionInsert[] {
    const note = [
      payload.summary ? `Meeting: ${payload.summary}` : "Calendar meeting",
      payload.location ? `Location: ${payload.location}` : "",
      payload.description ? payload.description.slice(0, 500) : "",
    ]
      .filter(Boolean)
      .join("\n");

    return [
      {
        userId,
        contactId,
        interactionType: "meeting",
        interactionDate: eventDateOf(payload),
        source: "calendar_import",
        externalId: calendarMeetingExternalId(payload.eventUid, contactId),
        rawNotes: note,
        aiSummary: payload.summary || "Calendar meeting",
        topics: payload.summary ? [payload.summary] : [],
      },
    ];
  },

  /**
   * Post-meeting follow-up reminders, preserved from the old per-row importer. Gated on
   * `payload.createFollowUps` (snapshotted once at ingest — see the payload's own doc
   * comment) and on the event being both in the past and recent (within 21 days), same as
   * before. `description` embeds `eventUid`, which is what makes this row's engine-side
   * dedupe (exact `(contactId, description)` match — see `ImportAdapter.reminders`'s doc
   * comment) actually distinguish "the same meeting, re-uploaded" from "a different meeting
   * with the same contact."
   */
  reminders(payload, contactId, userId): ReminderInsert[] {
    if (!payload.createFollowUps) return [];

    const eventDate = eventDateOf(payload);
    const now = Date.now();
    const isPast = eventDate.getTime() <= now;
    if (!isPast || daysAgo(eventDate) > 21) return [];

    const due = new Date(eventDate);
    due.setDate(due.getDate() + 2);
    if (due.getTime() < now) due.setTime(now + 2 * 86400000);

    return [
      {
        userId,
        contactId,
        title: `Follow up after ${payload.summary || "meeting"}`,
        description: `You met with ${payload.attendeeName || "them"}. Event ${payload.eventUid}`,
        dueDate: due,
        status: "pending",
        reminderType: "post_meeting",
        actionKind: "follow_up",
        createdBy: "import",
      },
    ];
  },
};
