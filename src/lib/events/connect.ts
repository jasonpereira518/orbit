/**
 * Roster rows against the network: who is already a contact, and keeping event-stamped
 * interactions in step when the event changes.
 *
 * People met at an event become contacts through capture ("Log who you met", see
 * `recordMetAtEvent` in store.ts). This module no longer writes contacts; `previewConnect`
 * only answers "which existing contact is this row", for the roster's badges.
 *
 * ## Why `matchConfidence` is 0.85 and not calendar's 0.6
 *
 * `calendar-sync.ts` passes 0.6, reasoning that an attendee list makes a bare full-name match
 * strong evidence. That argument does not transfer, and `ImportAdapter`'s docstring says why:
 * it is explicitly conditioned on `createsContacts: false`, where a low bar only means "this
 * row correlates with a known contact". Here we DO create contacts, so at 0.6 a bare name
 * match would MERGE two records — welding two people together, with no unmerge.
 *
 * The inputs differ too. A calendar attendee list is scoped by the user's own mailbox and
 * nearly always carries an email, so the weakest tier is rare. A pasted conference roster is
 * frequently name-only, and a conference is exactly where two different "Sarah Chen"s turn up.
 *
 * The failure modes are asymmetric: merging wrongly destroys data, while not merging produces
 * a duplicate that `src/lib/duplicates.ts` and the existing duplicate surfaces already handle.
 * So the floor is the standard one, passed explicitly — every other caller passes something,
 * and silence here would read as an oversight rather than a decision.
 *
 * The badge uses the same floor, so "already a contact" never claims a weaker match than a
 * merge would accept.
 */
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { DUPLICATE_MERGE_CONFIDENCE, findDuplicateCandidatesIndexed } from "@/lib/duplicates";
import { eventExternalIdBase } from "@/lib/ingest/external-id";
import { openIngestContext, type NetworkParticipant } from "@/lib/ingest/events";
import { loadAttendeesForUser } from "@/lib/events/store";
import type { EventAttendeeRecord, EventRecord } from "@/db/schema";

function toParticipant(row: EventAttendeeRecord): NetworkParticipant {
  return {
    name: row.fullName,
    email: row.email,
    linkedinUrl: row.linkedinUrl,
    handle: row.xHandle,
    company: row.company,
    title: row.title,
  };
}

/**
 * When the event happened, for the interaction's date.
 *
 * Never `now`. `contacts.last_interaction_at` feeds closeness directly, so dating a
 * conference you attended in March as today would score those people as your most recent
 * contacts — the exact distortion ingest dates new contacts from their events to avoid.
 * Falls back to when the row was created, which is the closest thing to a real date we have.
 */
function eventTimestamp(event: EventRecord): Date {
  return event.startsAt ?? event.createdAt;
}

/**
 * Deterministic, so a re-run reproduces byte-identical rows.
 *
 * The interaction upsert keys on `external_id`, and a note containing a timestamp or a
 * "connected on" phrase would make every re-run rewrite every row for no reason.
 */
function meetingNote(event: EventRecord): string {
  const where = [event.venue, event.city].filter(Boolean).join(", ");
  return where ? `Met at ${event.title} (${where}).` : `Met at ${event.title}.`;
}

/**
 * Bring an event's already-written interactions back in step after its details change.
 *
 * Connecting stamps each person's interaction with values DERIVED from the event — the date,
 * `Met at <title> (venue, city).`, and the title as the summary. Correct the venue afterwards
 * and every one of those silently describes an event that no longer exists as described.
 *
 * ## Regenerate only what we generated
 *
 * The interaction is also a thing the user can edit directly, from the contact's timeline.
 * Overwriting that would be worse than staleness. So each field is updated only where it
 * still holds exactly what the OLD event values produced: if it matches, nobody has touched
 * it and it is ours to refresh; if it does not, it is theirs and it is left alone.
 *
 * Each field is guarded independently, so correcting only the venue still refreshes the note
 * without skipping a date the user had also left untouched.
 *
 * This lives beside `meetingNote` and `eventTimestamp` deliberately. The predicate is
 * "does this equal what we would have written", so it has to be computed by the same code
 * that writes it — a second copy of the format string here would drift and silently stop
 * matching, turning every restamp into a no-op nobody notices.
 */
export async function restampEventInteractions(
  userId: string,
  previous: EventRecord,
  next: EventRecord
): Promise<number> {
  const prevNote = meetingNote(previous);
  const nextNote = meetingNote(next);
  const prevWhen = eventTimestamp(previous);
  const nextWhen = eventTimestamp(next);

  const unchanged =
    prevNote === nextNote &&
    previous.title === next.title &&
    prevWhen.getTime() === nextWhen.getTime();
  if (unchanged) return 0;

  const db = await getDb();
  // `evt:<uuid>:` — no `%` or `_`, so it needs no LIKE escaping.
  const prefix = `${eventExternalIdBase(next.id)}:%`;
  const updated = await db.execute(sql`
    UPDATE interactions SET
      raw_notes = CASE WHEN raw_notes IS NOT DISTINCT FROM ${prevNote}
                       THEN ${nextNote} ELSE raw_notes END,
      ai_summary = CASE WHEN ai_summary IS NOT DISTINCT FROM ${previous.title}
                        THEN ${next.title} ELSE ai_summary END,
      interaction_date = CASE WHEN interaction_date IS NOT DISTINCT FROM ${prevWhen}
                              THEN ${nextWhen} ELSE interaction_date END
    WHERE user_id = ${userId}
      AND external_id LIKE ${prefix}
    RETURNING id
  `);
  return rowsOf(updated).length;
}

export type ConnectPreviewRow = {
  attendeeId: string;
  name: string;
  /** What will happen: a confident match merges, anything weaker creates. */
  outcome: "match" | "create";
  matchedContactId: string | null;
  matchedContactName: string | null;
  confidence: number;
};

/**
 * What a connect would do, without doing it.
 *
 * Runs the same indexed matcher ingest will, at the same floor, against the same index — so
 * the preview is a genuine dry run rather than a second opinion. It is still a snapshot:
 * nothing locks the network between preview and commit, and a contact added in between simply
 * matches on commit and shows up in the summary counts.
 */
export async function previewConnect(
  userId: string,
  event: EventRecord,
  attendeeIds: string[]
): Promise<ConnectPreviewRow[]> {
  const rows = await loadAttendeesForUser(userId, event.id, attendeeIds);
  if (rows.length === 0) return [];

  const ctx = await openIngestContext(userId, {
    source: connectSource(event),
    createsContacts: true,
    matchConfidence: DUPLICATE_MERGE_CONFIDENCE,
  });

  return rows.map((row) => {
    const participant = toParticipant(row);
    const [best] = findDuplicateCandidatesIndexed(ctx.index, {
      fullName: participant.name ?? "",
      email: participant.email ?? undefined,
      linkedinUrl: participant.linkedinUrl ?? undefined,
      xHandle: participant.handle ?? undefined,
      company: participant.company ?? undefined,
      title: participant.title ?? undefined,
    });
    const confident = best && best.confidence >= DUPLICATE_MERGE_CONFIDENCE;
    return {
      attendeeId: row.id,
      name: row.fullName ?? row.email ?? "Unnamed guest",
      outcome: confident ? "match" : "create",
      matchedContactId: confident ? best.contact.id : null,
      matchedContactName: confident ? best.contact.fullName : null,
      confidence: best?.confidence ?? 0,
    };
  });
}

/** Provenance for the timeline badge — which acquisition path this person came from. */
function connectSource(event: EventRecord): string {
  return event.provider ? `event:${event.provider}` : "event";
}
