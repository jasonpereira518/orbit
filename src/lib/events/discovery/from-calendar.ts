/**
 * Calendar entries as event candidates.
 *
 * This is the source that needs no setup at all: a user who has connected Google Calendar for
 * meeting history is already receiving every Luma, Partiful and Eventbrite invite they have
 * ever accepted. The event is sitting in their calendar with its link in the description.
 *
 * ## The guest list is the reason this source matters
 *
 * No platform exposes the guest list of an event you merely attended. A calendar invite
 * sometimes does, because the organiser sent it to everyone — and for coffee-chat-shaped
 * events that is the whole room. It is also the most sensitive thing discovery touches, so
 * three rules apply and none of them is negotiable:
 *
 *   1. Only when the source says guests are visible (`guestsCanSeeOtherGuests`, and not
 *      truncated). Google returns the list to the calendar owner regardless; honouring the
 *      organiser's choice is on us.
 *   2. Never for a big list. Past a few hundred people this is a mailing list, not a room.
 *   3. Never a contact. These land as roster rows and stop there, like every other discovery
 *      write — `connectAttendees` remains the only path to a contact.
 *
 * Pure: no network, no database.
 */
import type { ParsedCalendarEvent } from "@/lib/calendar-import";
import { extractEventLinks, platformForEmailDomain, platformOf } from "@/lib/events/platforms";
import type {
  DiscoveryCandidate,
  DiscoverySource,
  RsvpStatus,
} from "@/lib/events/discovery/types";
import type { ProviderAttendee } from "@/lib/events/types";

/**
 * Past this, an invite is a broadcast rather than a room.
 *
 * Storing 900 strangers' email addresses because they were all bcc'd into the same webinar is
 * not a guest list anybody wanted us to keep.
 */
const MAX_INVITE_GUESTS = 300;

/** Shared inboxes and senders. Never people, and never worth a roster row. */
const ROLE_LOCALPART =
  /^(?:no-?reply|do-?not-?reply|noreply|invite|invites|calendar|events?|hello|hi|info|support|team|admin|billing|notifications?|updates?|mailer|bounce|postmaster|help|contact|sales|marketing)$/i;

export function isRoleEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const local = email.split("@")[0] ?? "";
  return ROLE_LOCALPART.test(local.trim());
}

/** Everywhere a calendar entry might be carrying its event link. */
function linkFieldsOf(event: ParsedCalendarEvent): string {
  return [event.url ?? "", event.location ?? "", event.summary ?? "", event.description ?? ""]
    .filter(Boolean)
    .join("\n");
}

/**
 * Is this calendar entry an event-platform invite rather than a meeting?
 *
 * Used in two places that must agree: discovery treats it as an event, and
 * `classifyCalendarEvent` stops treating it as a meeting. Disagreement here is what produced
 * the bug this fixes — a Luma party arriving as BOTH an event and a fabricated "1:1" with the
 * Luma mailer, which then created a contact called "invites".
 */
export function isEventPlatformInvite(event: ParsedCalendarEvent): boolean {
  if (event.url && platformOf(event.url)) return true;
  if (extractEventLinks(linkFieldsOf(event), { max: 1 }).length > 0) return true;
  const organizer = event.organizer?.email;
  return Boolean(organizer && platformForEmailDomain(organizer));
}

function rsvpFromStatus(status: string | null | undefined): RsvpStatus | null {
  const value = status?.trim().toUpperCase();
  if (!value) return null;
  if (value === "CANCELLED") return "cancelled";
  if (value === "TENTATIVE") return "maybe";
  if (value === "CONFIRMED") return "going";
  return null;
}

/**
 * Other guests on the invite, as roster rows.
 *
 * The calendar owner is dropped (they are not their own guest), and so is every platform
 * mailer and shared inbox — "events@lu.ma" was never in the room.
 */
function guestsOf(event: ParsedCalendarEvent, selfEmails: string[]): ProviderAttendee[] {
  if (event.guestsVisible === false) return [];
  const guests = event.attendees.filter((person) => person.email || person.name);
  if (guests.length === 0 || guests.length > MAX_INVITE_GUESTS) return [];

  const self = new Set(selfEmails.map((email) => email.trim().toLowerCase()).filter(Boolean));
  const out: ProviderAttendee[] = [];
  for (const person of guests) {
    const email = person.email?.trim().toLowerCase() || null;
    if (email && self.has(email)) continue;
    if (isRoleEmail(email)) continue;
    if (email && platformForEmailDomain(email)) continue;
    if (!email && !person.name) continue;
    out.push({
      externalRef: null,
      fullName: person.name || null,
      email,
      company: null,
      title: null,
      linkedinUrl: null,
      xHandle: null,
      phone: null,
      attendeeRole: "attendee",
    });
  }
  return out;
}

/**
 * Turn a page of calendar entries into candidates.
 *
 * Only platform invites become candidates. A calendar's ordinary meetings are already handled
 * — they become interactions through `applyNetworkingEvents` — and turning every lunch into an
 * "event" would bury the handful the user actually went to.
 */
export function calendarEventsToCandidates(
  events: ParsedCalendarEvent[],
  selfEmails: string[],
  source: DiscoverySource
): DiscoveryCandidate[] {
  const out: DiscoveryCandidate[] = [];

  for (const event of events) {
    if (!isEventPlatformInvite(event)) continue;

    const link =
      (event.url && platformOf(event.url) ? event.url : null) ??
      extractEventLinks(linkFieldsOf(event), { max: 1 })[0] ??
      null;
    const match = link ? platformOf(link) : null;

    // A cancelled event is still worth recording — the user may well have met people at the
    // one that DID happen, and "cancelled" is the honest label for the row either way.
    out.push({
      source,
      sourceRef: `${source === "gcal" ? "gcal" : "ics"}:${event.uid}`,
      url: link,
      platform: match?.platform ?? null,
      providerEventId: match?.providerEventId ?? null,
      title: event.summary?.trim() || null,
      startsAt: event.start,
      endsAt: event.end,
      timezone: event.timezone ?? null,
      location: event.location?.trim() || null,
      // A calendar invite never says who is running the event: the organiser is usually the
      // platform's mailer. `attended` is the honest default, and the page or the host API
      // corrects it later.
      roleHint: null,
      rsvpHint: rsvpFromStatus(event.status),
      attendees: guestsOf(event, selfEmails),
      evidence: {
        calendarSummary: event.summary?.slice(0, 200) ?? null,
        organizer: event.organizer?.email ?? null,
      },
    });
  }

  return out;
}
