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
import { persistEventCover } from "@/lib/events/cover";
import { resolveThemeColor } from "@/lib/events/theme";
import { parseRosterCsv, parseRosterText } from "@/lib/events/parse-roster";
import {
  createEventForUser,
  deleteEventForUser,
  getEventForUser,
  listEventsForUser,
  listRosterForUser,
  setSpokeToForUser,
  unlinkAttendeeForUser,
  updateEventForUser,
  upsertEventAttendees,
  type EventListRow,
} from "@/lib/events/store";
import { connectAttendees, previewConnect, type ConnectPreviewRow } from "@/lib/events/connect";
import {
  deleteEventConnection,
  listEventConnections,
  upsertEventConnection,
  type EventConnectionSummary,
} from "@/lib/events/connections";
import { buildEventbriteAuthUrl, eventbriteOAuthConfig } from "@/lib/events/connectors/eventbrite-oauth";
import { listCalendarEvents } from "@/lib/events/connectors/luma";
import type { ConnectSummary, RosterRow } from "@/lib/events/types";
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

  const event = await createEventForUser(userId, {
    title,
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    venue: input.venue ?? null,
    city: input.city ?? null,
    url: input.url ?? null,
    role: input.role ?? "attended",
    notes: input.notes ?? null,
    // Seeded from the title so the card has an identity immediately; enrichment may improve
    // it, but nothing renders grey in the meantime.
    ...seedTheme(input.url ?? title),
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

async function enrichEventInternal(
  userId: string,
  eventId: string,
  url: string
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
    await updateEventForUser(userId, eventId, {
      // The user's own typing wins over anything scraped — they were there, the page is a
      // marketing asset. Only blanks get filled.
      title: existing?.title || details.title || "Untitled event",
      startsAt: existing?.startsAt ?? details.startsAt,
      endsAt: existing?.endsAt ?? details.endsAt,
      venue: existing?.venue ?? details.venue,
      city: existing?.city ?? details.city,
      description: existing?.description ?? details.description,
      url: details.canonicalUrl ?? url,
      source: "page",
      coverImageUrl,
      coverSourceUrl,
      // A locked theme is the user's explicit choice and is never overwritten.
      ...(existing?.themeLocked === 1
        ? {}
        : { themeColor: theme.color, themeSource: theme.source }),
      enrichedAt: new Date(),
      enrichError: null,
    });
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

export async function updateEvent(
  eventId: string,
  patch: { title?: string; startsAt?: string | null; venue?: string | null; city?: string | null; notes?: string | null; role?: "attended" | "hosted" }
): Promise<void> {
  const userId = await requireUserForSurface(SURFACE);
  await updateEventForUser(userId, eventId, {
    ...patch,
    startsAt: patch.startsAt === undefined ? undefined : patch.startsAt ? new Date(patch.startsAt) : null,
  });
  revalidateEvents(eventId);
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
