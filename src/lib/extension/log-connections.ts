/**
 * "Log at an event" from LinkedIn's Connections page.
 *
 * The user opens My Network → Connections (newest first), clicks the Orbit icon, picks one of
 * their recent events and ticks the people they connected with there. What arrives is the
 * ticked names and their LinkedIn profile links — read from the page their own session
 * rendered, on their click, nothing scrolled or paginated behind their back.
 *
 * Each person lands on the event's guest list (source `extension`, matched to a row already
 * there by LinkedIn URL or exact name), and the ids go back so the panel can open the event's
 * debrief (`/capture?eventId=&attendees=`). None becomes a contact here: that happens in the
 * debrief's review, with a note and a follow-up, like every other "who I met".
 */
import type {
  LogConnectionsRequest,
  LogConnectionsResponse,
  RecentEventsResponse,
} from "@/lib/extension/contract";
import { ExtensionRouteError } from "@/lib/extension/http";
import { linkedinSlug } from "@/lib/duplicates";
import { canonicalLinkedInUrl } from "@/lib/linkedin-paste";
import { attendeeIdentityKey } from "@/lib/events/identity";
import type { ParsedAttendee } from "@/lib/events/parse-roster";
import {
  assertEventOwnedBy,
  attendeeIdsByIdentityKey,
  EventNotFoundError,
  listEventsForUser,
  listRosterForUser,
  upsertEventAttendees,
} from "@/lib/events/store";
import { requireReleasedSurface, SurfaceHiddenError } from "@/lib/surface-visibility";

/** Matches MAX_DEBRIEF_GUESTS on /capture: the ids ride in that page's URL. */
export const MAX_LOGGED_CONNECTIONS = 25;

async function requireEvents(userId: string): Promise<void> {
  try {
    await requireReleasedSurface(userId, "page.events");
  } catch (error) {
    if (error instanceof SurfaceHiddenError) {
      throw new ExtensionRouteError("not_found", "Events aren’t available on your account yet.");
    }
    throw error;
  }
}

/** Events the user could have just been at: any that has started, plus the last few past. */
export async function recentEventsForExtension(userId: string, now = new Date()): Promise<RecentEventsResponse> {
  await requireEvents(userId);
  const [upcoming, past] = await Promise.all([
    listEventsForUser(userId, 10, { when: "upcoming", now }),
    listEventsForUser(userId, 8, { when: "past", now }),
  ]);
  // "Upcoming" lasts until an event ENDS, so one under way right now is in it.
  const underWay = upcoming.filter((e) => e.startsAt && e.startsAt.getTime() <= now.getTime());
  return {
    events: [...underWay, ...past].map((e) => ({
      id: e.id,
      title: e.title,
      startsAt: e.startsAt ? e.startsAt.toISOString() : null,
    })),
  };
}

const norm = (value: string | null | undefined) => value?.trim().toLowerCase().replace(/\s+/g, " ") || null;

export async function logConnectionsAtEvent(
  userId: string,
  input: LogConnectionsRequest
): Promise<LogConnectionsResponse> {
  await requireEvents(userId);
  try {
    await assertEventOwnedBy(userId, input.eventId);
  } catch (error) {
    if (error instanceof EventNotFoundError) throw new ExtensionRouteError("not_found", error.message);
    throw error;
  }

  const people = new Map<string, { fullName: string; linkedinUrl: string; title: string | null }>();
  for (const person of input.people) {
    const slug = linkedinSlug(person.profileUrl);
    if (!slug) continue;
    const linkedinUrl = canonicalLinkedInUrl(slug);
    if (people.has(linkedinUrl)) continue;
    people.set(linkedinUrl, {
      fullName: person.name.trim().replace(/\s+/g, " "),
      linkedinUrl,
      title: person.subtitle?.trim().slice(0, 300) || null,
    });
  }
  if (people.size === 0) {
    throw new ExtensionRouteError("invalid_request", "Tick the people you met — each needs a LinkedIn profile link.");
  }

  // Someone already on the list (a Luma roster, a paste) is that row, not a second line.
  const roster = await listRosterForUser(userId, input.eventId);
  const ids: string[] = [];
  const toAdd: ParsedAttendee[] = [];
  for (const person of people.values()) {
    const row =
      roster.find((r) => norm(r.linkedinUrl) && norm(r.linkedinUrl) === norm(person.linkedinUrl)) ??
      roster.find((r) => norm(r.fullName) && norm(r.fullName) === norm(person.fullName));
    if (row) {
      ids.push(row.id);
      continue;
    }
    toAdd.push({
      fullName: person.fullName,
      email: null,
      company: null,
      title: person.title,
      linkedinUrl: person.linkedinUrl,
      xHandle: null,
      identityKey: attendeeIdentityKey(person)!,
    });
  }
  if (toAdd.length) {
    await upsertEventAttendees(userId, input.eventId, toAdd, "extension");
    ids.push(...(await attendeeIdsByIdentityKey(userId, input.eventId, toAdd.map((a) => a.identityKey))));
  }
  return { eventId: input.eventId, attendeeIds: [...new Set(ids)], added: toAdd.length };
}
