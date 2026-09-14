/**
 * Writing what a provider reported into the event tables.
 *
 * Kept apart from `store.ts` so the connectors stay pure: `luma.ts` and `eventbrite.ts` map
 * their JSON to `ProviderEvent` / `ProviderAttendee` and never touch a database, and this is
 * the one module that turns those shapes into rows.
 *
 * Attendees still go through `upsertEventAttendees` in `store.ts` — the single chokepoint
 * every acquisition path shares — rather than a second insert written here.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { events } from "@/db/schema";
import { attendeeIdentityKey } from "@/lib/events/identity";
import { upsertEventAttendees } from "@/lib/events/store";
import type { ParsedAttendee } from "@/lib/events/parse-roster";
import type {
  CalendarEventProviderId,
  EventProviderId,
  ProviderAttendee,
  ProviderEvent,
} from "@/lib/events/types";
import type { GroupEventCandidate } from "@/lib/connectors/calendar-shared";

/**
 * Create or update the event row, returning its id.
 *
 * Keyed on `events_provider_uidx` — `(user_id, provider, provider_event_id)` — so re-syncing
 * updates rather than accumulating a copy of every event on every run.
 *
 * The COALESCE direction is deliberate and opposite for two groups. Provider-owned facts
 * (title, dates, venue, cover) take the provider's newer value: the host renamed the event or
 * moved the venue and we should follow. `theme_color` takes the EXISTING value first, because
 * it may have been derived from the cover client-side or picked by the user, and a sync must
 * not silently repaint an event the user has already looked at.
 */
export async function upsertProviderEvent(
  userId: string,
  provider: EventProviderId | CalendarEventProviderId,
  event: ProviderEvent,
  /** Luma/Eventbrite connections are always host-scoped; calendar sync is the first caller
   *  that can genuinely be either. */
  role: "attended" | "hosted" = "hosted"
): Promise<string> {
  const db = await getDb();
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO events
        (user_id, title, starts_at, ends_at, timezone, venue, city, url, role, source,
         provider, provider_event_id, description, cover_source_url, attendee_count)
      VALUES
        (${userId}, ${event.title}, ${event.startsAt}, ${event.endsAt}, ${event.timezone},
         ${event.venue}, ${event.city}, ${event.url}, ${role}, ${provider},
         ${provider}, ${event.providerEventId}, ${event.description},
         ${event.coverImageUrl}, ${event.attendeeCount})
      ON CONFLICT (user_id, provider, provider_event_id) DO UPDATE SET
        title            = excluded.title,
        starts_at        = COALESCE(excluded.starts_at, events.starts_at),
        ends_at          = COALESCE(excluded.ends_at, events.ends_at),
        timezone         = COALESCE(excluded.timezone, events.timezone),
        venue            = COALESCE(excluded.venue, events.venue),
        city             = COALESCE(excluded.city, events.city),
        url              = COALESCE(excluded.url, events.url),
        role             = excluded.role,
        description      = COALESCE(excluded.description, events.description),
        cover_source_url = COALESCE(excluded.cover_source_url, events.cover_source_url),
        attendee_count   = COALESCE(excluded.attendee_count, events.attendee_count),
        updated_at       = now()
      RETURNING id
    `)
  );
  const id = rows[0]?.id;
  if (id) return id;

  // The partial unique index does not cover a NULL provider_event_id, so ON CONFLICT cannot
  // fire for one. A provider event without an id should not exist, but reading the row back
  // is cheaper than letting a null propagate into the caller.
  const existing = await db.query.events.findFirst({
    where: and(
      eq(events.userId, userId),
      eq(events.provider, provider),
      eq(events.providerEventId, event.providerEventId)
    ),
    columns: { id: true },
  });
  if (!existing) throw new Error("Could not upsert the provider event.");
  return existing.id;
}

/**
 * Store a provider's guest list.
 *
 * Maps to the same `ParsedAttendee` shape the paste and CSV paths produce, so all four
 * sources converge on `upsertEventAttendees` and dedupe identically. Guests with nothing
 * identifiable are dropped here rather than sent on — `identity_key` is NOT NULL.
 */
export async function upsertProviderAttendees(
  userId: string,
  eventId: string,
  attendees: ProviderAttendee[],
  provider: EventProviderId
): Promise<number> {
  const parsed: ParsedAttendee[] = [];
  const seen = new Set<string>();
  for (const a of attendees) {
    const identityKey = attendeeIdentityKey(a);
    if (!identityKey || seen.has(identityKey)) continue;
    seen.add(identityKey);
    parsed.push({
      fullName: a.fullName,
      email: a.email,
      company: a.company,
      title: a.title,
      linkedinUrl: a.linkedinUrl,
      xHandle: a.xHandle,
      identityKey,
    });
  }
  return upsertEventAttendees(userId, eventId, parsed, provider);
}

/**
 * Store one calendar-detected panel/webinar and its roster.
 *
 * Unlike Luma/Eventbrite, a calendar invite's attendee list is available REGARDLESS of
 * `role` — Google/Graph both hand back every guest whether the calendar owner organized the
 * event or merely accepted an invite to it. So `hostedBySelf` decides `events.role`, and the
 * roster is built accordingly: everyone else on the invite when the owner is the host, or the
 * organizer (tagged `attendeeRole: "host"`) plus any co-attendees when the owner is a guest.
 *
 * Contacts are never created here. `upsertEventAttendees` never writes `contact_id` — that is
 * only ever set by a human clicking "connect" in the roster UI, the same policy every other
 * event source already follows.
 */
export async function upsertCalendarGroupEvent(
  userId: string,
  provider: CalendarEventProviderId,
  candidate: GroupEventCandidate
): Promise<{ eventId: string; attendeesUpserted: number }> {
  const { event, hostedBySelf, organizer, attendees } = candidate;

  const eventId = await upsertProviderEvent(
    userId,
    provider,
    {
      providerEventId: event.uid,
      title: event.summary || "Untitled event",
      startsAt: event.start,
      endsAt: event.end,
      timezone: null,
      venue: event.location || null,
      city: null,
      url: null,
      description: event.description ? event.description.slice(0, 2000) : null,
      coverImageUrl: null,
      attendeeCount: hostedBySelf ? attendees.length : attendees.length + (organizer ? 1 : 0),
    },
    hostedBySelf ? "hosted" : "attended"
  );

  const roster: ParsedAttendee[] = [];
  const seen = new Set<string>();
  const addToRoster = (person: { name: string; email: string }, attendeeRole: ParsedAttendee["attendeeRole"]) => {
    const identityKey = attendeeIdentityKey({ email: person.email, fullName: person.name });
    if (!identityKey || seen.has(identityKey)) return;
    seen.add(identityKey);
    roster.push({
      fullName: person.name || null,
      email: person.email || null,
      company: null,
      title: null,
      linkedinUrl: null,
      xHandle: null,
      attendeeRole,
      identityKey,
    });
  };

  if (!hostedBySelf && organizer) addToRoster(organizer, "host");
  for (const attendee of attendees) addToRoster(attendee, hostedBySelf ? "attendee" : null);

  const attendeesUpserted = await upsertEventAttendees(userId, eventId, roster, provider);
  return { eventId, attendeesUpserted };
}
