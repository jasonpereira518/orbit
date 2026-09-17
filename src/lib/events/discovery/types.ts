/**
 * One candidate event, as some source reported it.
 *
 * Three sources feed this shape — a Google Calendar page, an ICS feed, a mailbox scan — and
 * they converge here precisely so that dedup, tombstones, role inference and the write are
 * written once rather than three times with three sets of edge cases.
 *
 * Pure types only, for the reason `src/lib/events/types.ts` records: a client component that
 * transitively imports `@/db` fails the build with a `node:fs` chunking error naming neither
 * file.
 */
import type { EventPlatform } from "@/lib/events/platforms";
import type { ProviderAttendee } from "@/lib/events/types";

/**
 * Where a candidate came from, and what the event card's badge says.
 *
 * `ics` is a user-added calendar subscription (Apple Calendar and anything else with a feed);
 * `luma_ics` and `partiful_ics` are the platforms' own personal feeds, which are worth
 * distinguishing because they are the only free way to see events the user merely attended.
 */
export type DiscoverySource = "gcal" | "ics" | "luma_ics" | "partiful_ics" | "gmail";

export type RsvpStatus = "going" | "maybe" | "waitlist" | "invited" | "cancelled";

/** One alias key: the pair that `event_aliases` is unique on, per user. */
export type AliasKey = {
  kind: "provider" | "url" | "source_ref";
  value: string;
};

export type DiscoveryCandidate = {
  source: DiscoverySource;
  /**
   * The SOURCE's own id for this report — a calendar `iCalUID`, a Gmail message id. This is
   * what makes re-reading the same feed idempotent even when the event's public identity is
   * still unknown, so it is required.
   */
  sourceRef: string;
  /**
   * Source refs folded in by `mergeCandidates` when two reports turned out to be one event.
   * Kept so every report's own key is still written — otherwise the losing feed reports its
   * event again on the next pass and has to be re-resolved by a weaker key every time.
   */
  alsoRefs?: string[];
  /** The event's public page, canonicalised. Null when the source only gave us a title. */
  url: string | null;
  platform: EventPlatform | null;
  providerEventId: string | null;
  title: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  /** IANA zone name from a calendar TZID, where there was one. */
  timezone: string | null;
  location: string | null;
  /** What the source suggests, never what the user said. See `events.role_source`. */
  roleHint: "hosted" | "attended" | null;
  rsvpHint: RsvpStatus | null;
  /**
   * Other guests, and ONLY ever from a calendar invite where the organiser chose to let
   * guests see each other. Never a scraped guest list — see `fetch-page.ts`.
   */
  attendees: ProviderAttendee[];
  /** Why we think this is an event. Shown to the user; never a message body. */
  evidence: Record<string, unknown>;
};

export type DiscoveryStats = {
  /** New event rows. */
  created: number;
  /** Reports that resolved to an event we already had. */
  attached: number;
  /** Reports refused because the user dismissed or deleted this event before. */
  suppressed: number;
  /** Events queued for a background read of their public page. */
  enrichQueued: number;
  /**
   * Reports of events the user is not going to — waitlisted, pending, maybe, invited — that
   * matched nothing we hold, and so created nothing. See `attendance.ts`.
   */
  notAttending: number;
};

export function emptyDiscoveryStats(): DiscoveryStats {
  return { created: 0, attached: 0, suppressed: 0, enrichQueued: 0, notAttending: 0 };
}
