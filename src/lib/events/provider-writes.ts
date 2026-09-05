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
import type { EventProviderId, ProviderAttendee, ProviderEvent } from "@/lib/events/types";

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
  provider: EventProviderId,
  event: ProviderEvent
): Promise<string> {
  const db = await getDb();
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO events
        (user_id, title, starts_at, ends_at, timezone, venue, city, url, role, source,
         provider, provider_event_id, description, cover_source_url, attendee_count)
      VALUES
        (${userId}, ${event.title}, ${event.startsAt}, ${event.endsAt}, ${event.timezone},
         ${event.venue}, ${event.city}, ${event.url}, 'hosted', ${provider},
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
