/**
 * Shared shapes for the events feature.
 *
 * ## "Event" means two things in this codebase — do not conflate them
 *
 *   - `NetworkEvent` (`src/lib/ingest/events.ts`) is an *interaction*: a meeting, an email, a
 *     call. It is the unit every connector produces and `ingestEvents` writes to the
 *     `interactions` table, and `POST /api/v1/events` is its public ingest endpoint.
 *   - `EventRecord` (this feature) is a *place you went*: a conference with a public page, a
 *     cover image and a guest list.
 *
 * They meet in exactly one place, deliberately: connecting an attendee produces a
 * `NetworkEvent` with `externalIdBase = eventExternalIdBase(eventId)` whose interaction lands
 * as `interaction_type: "event"` — a value `src/lib/interaction-types.ts` already defines as
 * "Met them at a conference, talk or mixer". Nothing in `src/lib/events/` may export a type
 * named `NetworkEvent`.
 *
 * This module is pure types only, so client components can import it without dragging `@/db`
 * into the browser bundle — the failure `src/lib/surfaces.ts` documents, where a client
 * component transitively importing the database fails the build with a `node:fs` chunking
 * error naming neither file.
 */

/**
 * The stand-in title used when someone adds an event by link alone.
 *
 * It is a real stored value (`events.title` is NOT NULL), but it is NOT a choice the user
 * made, and enrichment has to be able to tell those apart — otherwise the placeholder wins
 * over the title fetched from the page and the event stays "Untitled event" forever.
 */
export const UNTITLED_EVENT = "Untitled event";

/**
 * Which title an enriched event should end up with.
 *
 * The rule is "the user's own typing beats anything scraped" — they were there, the page is a
 * marketing asset. The subtlety is that `UNTITLED_EVENT` is not typing: it is what
 * `createEvent` stores when someone adds an event by pasting a link and nothing else. Counting
 * it as a real choice made the page's title lose to a placeholder, so every added-by-link
 * event stayed "Untitled event" — which defeats the reason for pasting a link at all.
 */
export function resolveEventTitle(
  existingTitle: string | null | undefined,
  fetchedTitle: string | null | undefined
): string {
  const existing = existingTitle?.trim();
  if (existing && existing !== UNTITLED_EVENT) return existing;
  return fetchedTitle?.trim() || UNTITLED_EVENT;
}

/** A platform whose API we can sync from, and the only values `events.provider` may hold. */
export type EventProviderId = "luma" | "eventbrite";

/**
 * What a row in `event_provider_connections` connects to.
 *
 * A superset of `EventProviderId`, and deliberately a different type. The connections table
 * is unique on `(user_id, provider)`, so its `provider` column doubles as the KIND of
 * connection — and a personal iCal feed is not the same thing as a host API key even when it
 * points at the same platform. A Luma feed lists everything the user registered for; a Luma
 * API key lists the calendars they run, and nothing else.
 *
 * Conflating the two would mean a user could have one or the other, never both — which is
 * exactly backwards, because the people who host Luma events are the people most likely to
 * attend them too.
 */
export type EventConnectionProvider =
  | EventProviderId
  | "luma_ics"
  | "partiful_ics"
  /** Not a platform: the user's existing Google grant, opted in to a mailbox scan. */
  | "gmail";

export type EventConnectionAuthKind =
  | "api_key"
  | "oauth"
  /** A secret URL. No account, no token, no refresh — anyone holding it sees the feed. */
  | "ics"
  /** Nothing stored here: the token comes from the Gmail connection the user already has. */
  | "google_grant";

export type EventRole = "attended" | "hosted";
export type EventSource = "manual" | "page" | EventProviderId;
/**
 * `page` is a speaker or published host read from the event page — never a guest list.
 * `calendar` is a fellow guest on an invite the user was on, which is a different claim
 * again: the host did not announce them, they were just in the same room.
 */
export type AttendeeSource =
  | "paste"
  | "csv"
  | "screenshot"
  | "page"
  | "calendar"
  | EventProviderId;
export type AttendeeRole = "attendee" | "host" | "speaker";

/** One event as a provider reports it. Producers map to this; nothing else touches their JSON. */
export type ProviderEvent = {
  providerEventId: string;
  title: string;
  startsAt: Date | null;
  endsAt: Date | null;
  timezone: string | null;
  venue: string | null;
  city: string | null;
  url: string | null;
  description: string | null;
  coverImageUrl: string | null;
  attendeeCount: number | null;
};

/** One guest as a provider reports it. Every field optional — sources differ in what they know. */
export type ProviderAttendee = {
  externalRef: string | null;
  fullName: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  xHandle: string | null;
  phone: string | null;
  attendeeRole: AttendeeRole | null;
};

/** A page of provider results, cursored. Null cursor means the listing is complete. */
export type ProviderPage<T> = { items: T[]; nextCursor: string | null };

/**
 * What the roster UI renders per row.
 *
 * `contactId` non-null means this person is already in the network — the row links to them
 * and its checkbox is disabled, because connecting twice is a no-op the user should not be
 * invited to attempt.
 */
export type RosterRow = {
  id: string;
  fullName: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  xHandle: string | null;
  attendeeRole: AttendeeRole | null;
  source: AttendeeSource;
  spokeTo: boolean;
  contactId: string | null;
};

/**
 * What a connect run did.
 *
 * `blockedByPlan` is carried all the way to the UI on purpose: it is the difference between
 * "we added everyone" and "we silently dropped people because your plan is full", and folding
 * it into a success count would make the second look like the first.
 */
export type ConnectSummary = {
  created: number;
  matched: number;
  interactionsLogged: number;
  blockedByPlan: number;
  unmatched: number;
};
