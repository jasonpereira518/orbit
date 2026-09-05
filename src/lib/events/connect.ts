/**
 * Turning "I spoke to these people" into contacts.
 *
 * This is the point of the whole feature. A roster is inert until the user picks the handful
 * of people they actually talked to; this module takes that selection and folds it into the
 * network through `src/lib/ingest/events.ts` — the one write path every source goes through.
 *
 * **No contact SQL lives here.** `contact-writes.ts` warns that two writers is already one too
 * many, and ingest owns contact create/merge plus the interaction insert in about three
 * statements per batch. This module's job is to build `NetworkEvent`s and record the outcome.
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
 * `previewConnect` exists so the user sees which way each person is about to go before
 * anything is written. That is the honest answer to a genuinely ambiguous match, and it is
 * affordable here in a way a background sync could never afford.
 */
import { DUPLICATE_MERGE_CONFIDENCE, findDuplicateCandidatesIndexed } from "@/lib/duplicates";
import { eventExternalIdBase } from "@/lib/ingest/external-id";
import {
  finalizeIngest,
  ingestEvents,
  openIngestContext,
  type IngestStats,
  type NetworkEvent,
  type NetworkParticipant,
} from "@/lib/ingest/events";
import { deadlineAfter, deadlineReached } from "@/lib/time-budget";
import {
  linkAttendeesToContacts,
  loadAttendeesForUser,
  setSpokeToForUser,
} from "@/lib/events/store";
import { attendeeIdentityKey } from "@/lib/events/identity";
import type { ConnectSummary } from "@/lib/events/types";
import type { EventAttendeeRecord, EventRecord } from "@/db/schema";

/**
 * Matches `CHUNK_SIZE` in the import engine. A roster is normally a room's worth of people, so
 * this rarely bites — but "select all" on a 2,000-row conference export must not become one
 * enormous statement.
 */
const CHUNK_SIZE = 250;

/** Leaves room under the route's `maxDuration = 300`, the same shape the sync pass uses. */
const BUDGET_MS = 240_000;

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

function buildNetworkEvent(event: EventRecord, rows: EventAttendeeRecord[]): NetworkEvent {
  return {
    // Ingest appends `:${contactId}`. Doing it here would make every attendee of one event
    // collide on `interactions_user_external_uidx` — see external-id.ts.
    externalIdBase: eventExternalIdBase(event.id),
    // `NetworkEventType` has no "event" member; the stored interaction type comes from
    // `IngestOptions.interactionType` below, which is where "event" actually lands.
    type: "meeting",
    timestamp: eventTimestamp(event),
    participants: rows.map(toParticipant),
    summary: event.title,
    notes: meetingNote(event),
  };
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

/**
 * Connect the selected attendees.
 *
 * Returns what actually happened, including how many were refused by the plan cap — that
 * number is carried to the UI rather than folded into a success message, because "we added
 * everyone" and "we silently dropped four people" must not look the same.
 */
export async function connectAttendees(
  userId: string,
  event: EventRecord,
  attendeeIds: string[]
): Promise<ConnectSummary & { remaining: number }> {
  const rows = await loadAttendeesForUser(userId, event.id, attendeeIds);
  // Rows with nothing to identify them cannot be matched or created; ingest would drop them
  // silently, so they are excluded here and reported as `unmatched` instead.
  const usable = rows.filter((r) => attendeeIdentityKey(r) !== null && !r.contactId);

  // Mark intent first. If the run is cut short by the budget, the selection survives and the
  // user can pick up where it stopped rather than re-ticking every box.
  await setSpokeToForUser(userId, event.id, usable.map((r) => r.id), true);

  const ctx = await openIngestContext(userId, {
    source: connectSource(event),
    createsContacts: true,
    matchConfidence: DUPLICATE_MERGE_CONFIDENCE,
    // The stored `interactions.interaction_type`. Already a member of INTERACTION_TYPES —
    // "Met them at a conference, talk or mixer" — so the timeline renders it with the right
    // icon and colour with no new vocabulary.
    interactionType: "event",
    metContext: "event",
    howMet: () => `Met at ${event.title}`,
    reportResolutions: true,
  });

  const totals: ConnectSummary = {
    created: 0,
    matched: 0,
    interactionsLogged: 0,
    blockedByPlan: 0,
    unmatched: rows.length - usable.length,
  };
  const links: Array<{ attendeeId: string; contactId: string }> = [];
  const deadline = deadlineAfter(BUDGET_MS);
  let processed = 0;

  for (let i = 0; i < usable.length; i += CHUNK_SIZE) {
    // Checked BEFORE the chunk, not after: starting work we cannot finish is how a run gets
    // killed mid-write instead of stopping cleanly with everything so far recorded.
    if (i > 0 && deadlineReached(deadline)) break;
    const chunk = usable.slice(i, i + CHUNK_SIZE);
    const stats: IngestStats = await ingestEvents(ctx, [buildNetworkEvent(event, chunk)]);

    totals.created += stats.contactsCreated;
    totals.matched += stats.contactsMatched;
    totals.interactionsLogged += stats.interactionsLogged;
    totals.blockedByPlan += stats.blockedByPlan;
    processed += chunk.length;

    // Map each resolved participant back to the attendee row it came from. Keyed on identity
    // rather than array position: ingest collapses duplicate participants within an event, so
    // the resolutions it returns do not line up index-for-index with the chunk.
    const byKey = new Map(chunk.map((r) => [attendeeIdentityKey(r)!, r.id]));
    for (const { participant, contactId } of stats.resolutions ?? []) {
      const attendeeId = byKey.get(
        attendeeIdentityKey({
          linkedinUrl: participant.linkedinUrl,
          email: participant.email,
          xHandle: participant.handle,
          fullName: participant.name,
        }) ?? ""
      );
      if (attendeeId) links.push({ attendeeId, contactId });
    }
  }

  await linkAttendeesToContacts(userId, links);
  // Once per run, never per chunk — it marks the closeness cohort dirty and kicks the
  // embedding backfill, both of which are debounced downstream.
  await finalizeIngest(ctx);

  return { ...totals, remaining: usable.length - processed };
}
