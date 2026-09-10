"use server";

/**
 * Server actions for the events surface.
 *
 * Every export is an async function, per the house rule — non-async helpers would fail the
 * "use server" contract, which is why shared logic lives in `src/lib/events/*` instead.
 *
 * Every action re-asserts auth itself. Layouts do not re-run for server-action POSTs, and
 * actions are reachable by direct POST, so a check anywhere else is not a check.
 */
import { cookies } from "next/headers";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSyncUser, requireUserForSurface } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { fetchEventPage, EventPageError } from "@/lib/events/fetch-page";
import { canonicalizeEventUrl } from "@/lib/events/canonical-url";
import {
  diffEventAgainstPage,
  resolveField,
  type EventFieldChange,
} from "@/lib/events/resync";
import { persistEventCover } from "@/lib/events/cover";
import { resolveThemeColor } from "@/lib/events/theme";
import {
  parseRosterCsv,
  parseRosterText,
  speakersNotOnRoster,
  speakersToAttendees,
} from "@/lib/events/parse-roster";
import {
  createEventForUser,
  deleteEventForUser,
  getEventForUser,
  listEventsForUser,
  listRosterForUser,
  setSpokeToForUser,
  unlinkAttendeeForUser,
  updateEventForUser,
  updateAttendeeForUser,
  deleteAttendeeForUser,
  upsertEventAttendees,
  type EventListRow,
  type UpdateAttendeeResult,
} from "@/lib/events/store";
import {
  connectAttendees,
  previewConnect,
  restampEventInteractions,
  type ConnectPreviewRow,
} from "@/lib/events/connect";
import {
  deleteEventConnection,
  listEventConnections,
  upsertEventConnection,
  type EventConnectionSummary,
} from "@/lib/events/connections";
import { buildEventbriteAuthUrl, eventbriteOAuthConfig } from "@/lib/events/connectors/eventbrite-oauth";
import { listCalendarEvents } from "@/lib/events/connectors/luma";
import { resolveEventTitle } from "@/lib/events/types";
import type { AttendeeRole, ConnectSummary, RosterRow } from "@/lib/events/types";
import type { EventRecord } from "@/db/schema";

const OAUTH_STATE_COOKIE = "orbit_eventbrite_oauth_state";
const SURFACE = "page.events";

function revalidateEvents(eventId?: string) {
  revalidatePath("/events");
  if (eventId) revalidatePath(`/events/${eventId}`);
}

export async function listEvents(): Promise<EventListRow[]> {
  const userId = await requireUserForSurface(SURFACE);
  return listEventsForUser(userId);
}

export async function getEvent(eventId: string): Promise<EventRecord | null> {
  const userId = await requireUserForSurface(SURFACE);
  return getEventForUser(userId, eventId);
}

export async function getRoster(eventId: string): Promise<RosterRow[]> {
  const userId = await requireUserForSurface(SURFACE);
  return listRosterForUser(userId, eventId);
}

export async function createEvent(input: {
  title: string;
  startsAt?: string | null;
  venue?: string | null;
  city?: string | null;
  url?: string | null;
  role?: "attended" | "hosted";
  notes?: string | null;
}): Promise<{ id: string }> {
  const userId = await requireUserForSurface(SURFACE);
  const title = input.title.trim();
  if (!title) throw new Error("An event needs a name.");

  // Cleaned before the row is written, not just before it is fetched. Enrichment can fail —
  // the host is down, the link needs a login — and the pasted URL would otherwise persist
  // with the user's own Luma guest token in it, rendered back as a link on the event page.
  const outcome = input.url ? canonicalizeEventUrl(input.url) : null;
  const url = outcome?.kind === "ok" ? outcome.candidates[0]! : input.url ?? null;

  const event = await createEventForUser(userId, {
    title,
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    venue: input.venue ?? null,
    city: input.city ?? null,
    url,
    role: input.role ?? "attended",
    notes: input.notes ?? null,
    // Seeded from the title so the card has an identity immediately; enrichment may improve
    // it, but nothing renders grey in the meantime.
    ...seedTheme(url ?? title),
  });

  if (input.url) {
    // Off the request path: the user should land on their event, not wait on someone
    // else's web server. `enrich_status` on the row is how the UI shows this is in flight.
    after(() => enrichEventInternal(userId, event.id, input.url!).catch(() => {}));
  }
  revalidateEvents();
  return { id: event.id };
}

function seedTheme(seed: string) {
  const theme = resolveThemeColor({ seed });
  return { themeColor: theme.color, themeSource: theme.source };
}

/**
 * Pull details from a public event page.
 *
 * Rate-limited per user because it makes an outbound request to an address the user chose:
 * without a bucket this action is an open proxy for scanning, and the SSRF guard stops it
 * reaching anything internal but does not stop the volume.
 */
export async function enrichEventFromUrl(
  eventId: string,
  url: string
): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserForSurface(SURFACE);
  try {
    await consumeBucket(userId, "eventEnrich", RATE_LIMITS.eventEnrich);
  } catch (error) {
    if (isRateLimitedError(error)) {
      return { ok: false, error: "Too many lookups just now — try again in a few minutes." };
    }
    throw error;
  }
  const result = await enrichEventInternal(userId, eventId, url);
  revalidateEvents(eventId);
  return result;
}

/**
 * `fill` only completes blanks, which is right for a first read and useless afterwards.
 * `replace` lets the page win, which is what a resync is for — see `resync.ts`.
 */
type EnrichMode = "fill" | "replace";

async function enrichEventInternal(
  userId: string,
  eventId: string,
  url: string,
  mode: EnrichMode = "fill"
): Promise<{ ok: boolean; error?: string }> {
  try {
    const details = await fetchEventPage(url);
    const theme = resolveThemeColor({
      metaColor: details.themeColor,
      seed: new URL(details.canonicalUrl ?? url).host,
    });

    let coverImageUrl: string | null = null;
    let coverSourceUrl: string | null = null;
    if (details.imageUrl) {
      const cover = await persistEventCover(eventId, details.imageUrl);
      coverImageUrl = cover?.url ?? null;
      coverSourceUrl = cover?.sourceUrl ?? null;
    }

    const existing = await getEventForUser(userId, eventId);
    // `fill` keeps whatever is already stored; `replace` lets the page win — but neither ever
    // CLEARS a field the page simply did not mention, which is what `resolveField` encodes.
    // A host reshuffling their markup must not blank the venue on every event it produced.
    const take = <T>(fetched: T | null, current: T | null): T | null =>
      mode === "replace" ? resolveField(fetched, current) : current ?? fetched;

    await updateEventForUser(userId, eventId, {
      // The untitled placeholder counts as blank in both modes. See `resolveEventTitle`.
      title:
        mode === "replace"
          ? details.title?.trim() || resolveEventTitle(existing?.title, details.title)
          : resolveEventTitle(existing?.title, details.title),
      startsAt: take(details.startsAt, existing?.startsAt ?? null),
      endsAt: take(details.endsAt, existing?.endsAt ?? null),
      timezone: take(details.timezone, existing?.timezone ?? null),
      venue: take(details.venue, existing?.venue ?? null),
      city: take(details.city, existing?.city ?? null),
      description: take(details.description, existing?.description ?? null),
      organizerName: take(details.organizerName, existing?.organizerName ?? null),
      organizerUrl: take(details.organizerUrl, existing?.organizerUrl ?? null),
      attendanceMode: take(details.attendanceMode, existing?.attendanceMode ?? null),
      url: details.canonicalUrl ?? url,
      source: "page",
      // Only overwrite the cover when this read actually produced one, or a page that briefly
      // stops serving `og:image` would strip the artwork off the event.
      ...(coverImageUrl ? { coverImageUrl, coverSourceUrl } : {}),
      // A locked theme is the user's explicit choice and is never overwritten.
      ...(existing?.themeLocked === 1
        ? {}
        : { themeColor: theme.color, themeSource: theme.source }),
      enrichedAt: new Date(),
      enrichError: null,
    });

    // Enrichment can change the title and date too — most visibly when it replaces the
    // untitled placeholder — so the interactions written from this event follow along.
    await restampFromEvent(userId, eventId, existing ?? null);

    // The host's published line-up, as unconfirmed roster rows tagged `page`. Deliberately
    // NOT ingested: `connectAttendees` is still the only path to a contact, and it still
    // needs a human. This only puts names on the roster for the user to confirm or delete.
    const speakers = speakersToAttendees(details.speakers);
    if (speakers.length > 0) {
      // Filtered against who is already listed, or refreshing would re-add a name-only row
      // for every speaker whose roster entry the user has since corrected. See
      // `speakersNotOnRoster` for why a name comparison is the right tool here specifically.
      const roster = await listRosterForUser(userId, eventId);
      const fresh = speakersNotOnRoster(speakers, roster.map((r) => r.fullName));
      if (fresh.length > 0) await upsertEventAttendees(userId, eventId, fresh, "page");
    }
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof EventPageError ? error.message : "That page could not be read.";
    await updateEventForUser(userId, eventId, {
      enrichedAt: new Date(),
      enrichError: message,
    });
    return { ok: false, error: message };
  }
}

/**
 * Edit an event by hand.
 *
 * Dates arrive as ISO instants already converted from the venue's wall clock by
 * `wall-clock.ts` — deliberately NOT as the raw `datetime-local` string, which carries no
 * zone and would be read here in the server's.
 */
export async function updateEvent(
  eventId: string,
  patch: {
    title?: string;
    startsAt?: string | null;
    endsAt?: string | null;
    venue?: string | null;
    city?: string | null;
    url?: string | null;
    description?: string | null;
    organizerName?: string | null;
    organizerUrl?: string | null;
    attendanceMode?: "offline" | "online" | "mixed" | null;
    notes?: string | null;
    role?: "attended" | "hosted";
  }
): Promise<void> {
  const userId = await requireUserForSurface(SURFACE);
  // Read before and after so the interactions already written from this event can be brought
  // back in step — the note and date they carry are derived from exactly these fields.
  const before = await getEventForUser(userId, eventId);

  // A link pasted here goes through the same cleaning as one pasted into "Add event",
  // or editing would be a way to put a personal ticket token back into the database.
  let url = patch.url;
  if (typeof url === "string" && url.trim()) {
    const outcome = canonicalizeEventUrl(url);
    if (outcome.kind === "ok") url = outcome.candidates[0]!;
  }

  const asDate = (value: string | null | undefined) =>
    value === undefined ? undefined : value ? new Date(value) : null;

  await updateEventForUser(userId, eventId, {
    ...patch,
    ...(url === undefined ? {} : { url: url || null }),
    startsAt: asDate(patch.startsAt),
    endsAt: asDate(patch.endsAt),
  });
  await restampFromEvent(userId, eventId, before);
  revalidateEvents(eventId);
}

/**
 * What a resync would change, without changing it.
 *
 * Rate-limited on the same bucket as enrichment: it is the same outbound request to a
 * user-chosen address, and a preview that were free would make the bucket meaningless.
 */
export async function previewResync(
  eventId: string
): Promise<{ ok: true; changes: EventFieldChange[] } | { ok: false; error: string }> {
  const userId = await requireUserForSurface(SURFACE);
  const event = await getEventForUser(userId, eventId);
  if (!event) return { ok: false, error: "That event no longer exists." };
  if (!event.url) return { ok: false, error: "This event has no link to refresh from." };

  try {
    await consumeBucket(userId, "eventEnrich", RATE_LIMITS.eventEnrich);
  } catch (error) {
    if (isRateLimitedError(error)) {
      return { ok: false, error: "Too many lookups just now — try again in a few minutes." };
    }
    throw error;
  }

  try {
    const details = await fetchEventPage(event.url);
    return { ok: true, changes: diffEventAgainstPage(event, details) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof EventPageError ? error.message : "That page could not be read.",
    };
  }
}

/**
 * Apply the refresh.
 *
 * Fetches again rather than trusting values round-tripped through the client: this writes to
 * the database, and a preview's output arriving back from a browser is not evidence of what
 * the page says. The cost is a second request; the alternative is letting the client dictate
 * the contents of a row.
 */
export async function resyncEvent(eventId: string): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserForSurface(SURFACE);
  const event = await getEventForUser(userId, eventId);
  if (!event) return { ok: false, error: "That event no longer exists." };
  if (!event.url) return { ok: false, error: "This event has no link to refresh from." };

  try {
    await consumeBucket(userId, "eventEnrich", RATE_LIMITS.eventEnrich);
  } catch (error) {
    if (isRateLimitedError(error)) {
      return { ok: false, error: "Too many lookups just now — try again in a few minutes." };
    }
    throw error;
  }

  const result = await enrichEventInternal(userId, eventId, event.url, "replace");
  revalidateEvents(eventId);
  return result;
}

/**
 * Re-derive this event's interactions after its details changed.
 *
 * Never allowed to fail the edit that triggered it: the user's change is already committed,
 * and a restamp failure means some notes are stale, not that the edit should be undone.
 */
async function restampFromEvent(
  userId: string,
  eventId: string,
  before: EventRecord | null
): Promise<void> {
  if (!before) return;
  try {
    const after = await getEventForUser(userId, eventId);
    if (!after) return;
    const touched = await restampEventInteractions(userId, before, after);
    if (touched > 0) revalidatePath("/contacts");
  } catch {
    // Deliberately swallowed — see above.
  }
}

export async function deleteEvent(eventId: string): Promise<void> {
  const userId = await requireUserForSurface(SURFACE);
  await deleteEventForUser(userId, eventId);
  revalidateEvents();
}

/** The dominant cover colour, sampled in the browser. Ignored once the user picks their own. */
export async function setEventThemeColor(
  eventId: string,
  color: string,
  source: "image" | "manual"
): Promise<void> {
  const userId = await requireUserForSurface(SURFACE);
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  const existing = await getEventForUser(userId, eventId);
  if (!existing) return;
  // A probe must never overwrite a colour the user chose, or the hero would flicker back
  // every time the hero image reloads.
  if (existing.themeLocked === 1 && source === "image") return;
  await updateEventForUser(userId, eventId, {
    themeColor: color.toLowerCase(),
    themeSource: source === "manual" ? "meta" : "image",
    themeLocked: source === "manual" ? 1 : 0,
  });
  revalidateEvents(eventId);
}

export async function importAttendeesFromText(
  eventId: string,
  text: string,
  kind: "paste" | "screenshot" = "paste"
): Promise<{ added: number; skipped: number; deduped: number }> {
  const userId = await requireUserForSurface(SURFACE);
  const parsed = parseRosterText(text);
  await upsertEventAttendees(userId, eventId, parsed.attendees, kind);
  revalidateEvents(eventId);
  return { added: parsed.attendees.length, skipped: parsed.skipped, deduped: parsed.deduped };
}

export async function importAttendeesFromCsv(
  eventId: string,
  csv: string
): Promise<{ added: number; skipped: number; deduped: number }> {
  const userId = await requireUserForSurface(SURFACE);
  const parsed = parseRosterCsv(csv);
  await upsertEventAttendees(userId, eventId, parsed.attendees, "csv");
  revalidateEvents(eventId);
  return { added: parsed.attendees.length, skipped: parsed.skipped, deduped: parsed.deduped };
}

export async function setSpokeTo(
  eventId: string,
  attendeeIds: string[],
  spokeTo: boolean
): Promise<void> {
  const userId = await requireUserForSurface(SURFACE);
  await setSpokeToForUser(userId, eventId, attendeeIds, spokeTo);
  revalidateEvents(eventId);
}

/**
 * Correct one attendee's details.
 *
 * Returns the failure rather than throwing it, because both failure modes are things the
 * user resolves in the dialog: nothing identifying left, or another row on this roster
 * already holding the new identity. See `updateAttendeeForUser` for why the second is a
 * refusal rather than a merge.
 */
export async function updateAttendee(
  eventId: string,
  attendeeId: string,
  patch: {
    fullName: string | null;
    email: string | null;
    company: string | null;
    title: string | null;
    linkedinUrl: string | null;
    xHandle: string | null;
    attendeeRole: AttendeeRole | null;
  }
): Promise<UpdateAttendeeResult> {
  const userId = await requireUserForSurface(SURFACE);
  const blank = (value: string | null) => {
    const text = value?.trim();
    return text ? text : null;
  };
  const result = await updateAttendeeForUser(userId, attendeeId, {
    fullName: blank(patch.fullName),
    email: blank(patch.email)?.toLowerCase() ?? null,
    company: blank(patch.company),
    title: blank(patch.title),
    linkedinUrl: blank(patch.linkedinUrl),
    xHandle: blank(patch.xHandle)?.replace(/^@/, "") ?? null,
    attendeeRole: patch.attendeeRole,
  });
  if (result.ok) revalidateEvents(eventId);
  return result;
}

/**
 * Remove one person from the roster.
 *
 * Leaves their contact and this event's interaction alone if they were connected — the
 * roster row is a guest-list entry, not the record of having met them.
 */
export async function deleteAttendee(eventId: string, attendeeId: string): Promise<void> {
  const userId = await requireUserForSurface(SURFACE);
  await deleteAttendeeForUser(userId, attendeeId);
  revalidateEvents(eventId);
}

/**
 * Who on this roster is already in your network.
 *
 * Built on `previewConnect` rather than a second, cheaper matcher on purpose. The badge this
 * feeds and the connect preview must never disagree — "already a contact" above a preview
 * that says "create" reads as a bug — and reuse is the only way to guarantee they agree at
 * the same threshold against the same index.
 *
 * Only unconnected rows are asked about: a row with a `contactId` is already known to be
 * linked, and asking would pay for a match we already have.
 */
export async function matchRosterToNetwork(eventId: string): Promise<ConnectPreviewRow[]> {
  const userId = await requireUserForSurface(SURFACE);
  const event = await getEventForUser(userId, eventId);
  if (!event) return [];
  const roster = await listRosterForUser(userId, eventId);
  const unlinked = roster.filter((r) => !r.contactId).map((r) => r.id);
  if (unlinked.length === 0) return [];
  return previewConnect(userId, event, unlinked);
}

/** A dry run, so the user sees who will merge and who will be created before committing. */
export async function previewConnectAttendees(
  eventId: string,
  attendeeIds: string[]
): Promise<ConnectPreviewRow[]> {
  const userId = await requireUserForSurface(SURFACE);
  const event = await getEventForUser(userId, eventId);
  if (!event) throw new Error("That event no longer exists.");
  return previewConnect(userId, event, attendeeIds);
}

export async function addSpokenToConnections(
  eventId: string,
  attendeeIds: string[]
): Promise<ConnectSummary & { remaining: number }> {
  const userId = await requireUserForSurface(SURFACE);
  const event = await getEventForUser(userId, eventId);
  if (!event) throw new Error("That event no longer exists.");

  const summary = await connectAttendees(userId, event, attendeeIds);
  revalidateEvents(eventId);
  // These people are now contacts, so the surfaces that count them are stale.
  revalidatePath("/contacts");
  revalidatePath("/dashboard");
  return summary;
}

export async function removeSpokenToConnection(
  eventId: string,
  attendeeId: string
): Promise<void> {
  const userId = await requireUserForSurface(SURFACE);
  // Deliberately does not delete the contact — see the confirmation copy in the roster.
  await unlinkAttendeeForUser(userId, attendeeId);
  revalidateEvents(eventId);
  revalidatePath("/contacts");
}

// --- Provider connections -------------------------------------------------------------------

export async function getEventConnections(): Promise<{
  connections: EventConnectionSummary[];
  eventbriteConfigured: boolean;
}> {
  const userId = await requireUserForSurface(SURFACE);
  return {
    connections: await listEventConnections(userId),
    eventbriteConfigured: eventbriteOAuthConfig().configured,
  };
}

/**
 * Store a Luma API key.
 *
 * Validated by making one real call before it is saved: a key that cannot list a calendar is
 * a key that will fail silently in a background sync three hours from now, and the user is
 * standing right here with the ability to fix it.
 */
export async function connectLuma(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireSyncUser();
  const key = apiKey.trim();
  if (!key) return { ok: false, error: "Paste your Luma API key." };

  try {
    await listCalendarEvents(key, null);
  } catch {
    return {
      ok: false,
      error: "Luma rejected that key. It must be a calendar key from a Luma Plus account.",
    };
  }

  await upsertEventConnection(userId, {
    provider: "luma",
    authKind: "api_key",
    secret: key,
    label: "Luma calendar",
  });
  revalidateEvents();
  return { ok: true };
}

export async function startEventbriteOAuth(): Promise<{ url: string }> {
  const userId = await requireSyncUser();
  const config = eventbriteOAuthConfig();
  if (!config.configured) {
    throw new Error(
      "Eventbrite is not configured. Set EVENTBRITE_CLIENT_ID and EVENTBRITE_CLIENT_SECRET."
    );
  }
  const state = `${userId}:${crypto.randomUUID()}`;
  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return { url: buildEventbriteAuthUrl(state) };
}

/** Read once and delete, so a state cannot be replayed. */
export async function consumeEventbriteOAuthState(state: string | null): Promise<string> {
  const jar = await cookies();
  const expected = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);
  if (!state || !expected || state !== expected) throw new Error("Invalid OAuth state");
  const [userId] = state.split(":");
  if (!userId) throw new Error("Invalid OAuth state");
  return userId;
}

export async function disconnectEventProvider(provider: "luma" | "eventbrite"): Promise<void> {
  const userId = await requireSyncUser();
  await deleteEventConnection(userId, provider);
  revalidateEvents();
}
