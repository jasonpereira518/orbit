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

export type EventProviderId = "luma" | "eventbrite";
export type EventRole = "attended" | "hosted";
export type EventSource = "manual" | "page" | EventProviderId;
export type AttendeeSource = "paste" | "csv" | "screenshot" | EventProviderId;
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
