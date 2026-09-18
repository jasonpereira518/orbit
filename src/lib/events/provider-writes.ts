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
 * ## The `WHERE` on the conflict target is not decoration
 *
 * `events_provider_uidx` is a PARTIAL index (`WHERE provider_event_id IS NOT NULL`). Postgres
 * will only infer a partial index as an arbiter when the statement repeats its predicate, and
 * without it the server does not fall back to a full-table check — it raises "there is no
 * unique or exclusion constraint matching the ON CONFLICT specification" and the whole sync
 * fails. That is what it did: every Luma and Eventbrite sync threw on its first event, which
 * `runEventSyncPass` then recorded as a retryable connection failure, so the pass backed off
 * and tried again forever instead of saying anything. `smoke-event-roster.ts` now runs this
 * statement against the real DDL, which is what turns that into a test failure.
 *
 * The COALESCE direction is deliberate and opposite for two groups. Provider-owned facts
 * (title, dates, venue, cover) take the provider's newer value: the host renamed the event or
 * moved the venue and we should follow. `theme_color` takes the EXISTING value first, because
 * it may have been derived from the cover client-side or picked by the user, and a sync must
 * not silently repaint an event the user has already looked at.
 *
 * `role` is set to `hosted` on conflict as well as on insert. Only a host-scoped credential
 * can list an event here at all — that is what the Luma API key and the Eventbrite organiser
 * token mean — so the API listing it IS the evidence that the user hosts it. Without this, an
 * event that reached the table by some other route first kept `attended` forever and the UI
 * went on telling the user to paste a guest list it was already syncing.
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
      ON CONFLICT (user_id, provider, provider_event_id)
        WHERE provider_event_id IS NOT NULL
      DO UPDATE SET
        title            = excluded.title,
        role             = 'hosted',
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
      // Both connectors compute this (luma.ts, eventbrite.ts) and it used to be dropped
      // right here, so every row landed with a NULL role.
      attendeeRole: a.attendeeRole ?? null,
      externalRef: a.externalRef,
      phone: a.phone,
      identityKey,
    });
  }
  return upsertEventAttendees(userId, eventId, parsed, provider);
}
