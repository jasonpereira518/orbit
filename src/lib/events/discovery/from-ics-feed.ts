/**
 * The user's personal Luma / Partiful calendar feed.
 *
 * ## Why this is the best source we have for events you did not host
 *
 * No platform's API will tell you about an event you merely attended — Luma's key is scoped
 * to calendars you own, Eventbrite's attendee endpoints need organiser scope, Partiful has no
 * API at all. Every one of them will, however, hand the user a personal iCal URL listing
 * everything they registered for, because that is how a calendar subscription works.
 *
 * So this is the one free, supported, terms-respecting way to answer "which events did I
 * actually go to" — and it needs no OAuth app, no paid plan, and no scraping. The user pastes
 * a link once.
 *
 * ## The link is a secret
 *
 * A Luma feed URL shows everything its holder has registered for, to anyone who has it. It is
 * stored encrypted (`api_key_encrypted`, same as a real key) and the query string is redacted
 * out of any error we record. It is also a user-supplied URL fetched by a background job with
 * nobody watching, which makes it an SSRF primitive — hence `guardedFetchText` rather than the
 * plain `fetch` that `calendar-sync.ts` still uses for its own feeds.
 *
 * Nothing here becomes a contact. Same rule as every other discovery path.
 */
import { parseIcsEvents } from "@/lib/calendar-import";
import { EventPageError, guardedFetchText } from "@/lib/events/guarded-fetch";
import { calendarEventsToCandidates } from "@/lib/events/discovery/from-calendar";
import { recordDiscoveryCandidates } from "@/lib/events/discovery/record";
import type { DiscoverySource, DiscoveryStats } from "@/lib/events/discovery/types";
import type { FetchPageDeps } from "@/lib/events/guarded-fetch";

/** A calendar is text. 2 MB is a decade of events and still bounded. */
const MAX_ICS_BYTES = 2_000_000;

const ICS_CONTENT_TYPES = ["text/calendar", "text/plain", "application/octet-stream"] as const;

/** A feed URL the user can no longer reach: revoked, regenerated, or the account is gone. */
export class IcsFeedGoneError extends Error {}

export function feedSourceOf(provider: string): DiscoverySource {
  if (provider === "luma_ics") return "luma_ics";
  if (provider === "partiful_ics") return "partiful_ics";
  return "ics";
}

/**
 * Fetch one feed and record what it holds.
 *
 * A 404 or 410 means the URL itself is dead — regenerating a feed link is how these platforms
 * revoke one — so it raises rather than counting as a transient failure. Retrying a revoked
 * URL every half hour tells the user nothing; "reconnect" does.
 */
export async function syncIcsFeed(
  userId: string,
  feedUrl: string,
  provider: string,
  deps?: FetchPageDeps
): Promise<DiscoveryStats> {
  let text: string;
  try {
    const page = await guardedFetchText(feedUrl, {
      accept: "text/calendar, text/plain;q=0.9, */*;q=0.1",
      contentTypes: ICS_CONTENT_TYPES,
      maxBytes: MAX_ICS_BYTES,
      wrongTypeMessage: "That link did not return a calendar feed.",
      deps,
    });
    text = page.text;
  } catch (error) {
    if (error instanceof EventPageError && /returned (404|410)/.test(error.message)) {
      throw new IcsFeedGoneError(
        "That calendar link no longer works. Copy a fresh one and reconnect."
      );
    }
    throw error;
  }

  if (!/BEGIN:VCALENDAR/i.test(text) && !/BEGIN:VEVENT/i.test(text)) {
    throw new IcsFeedGoneError("That link did not return a calendar feed.");
  }

  const events = parseIcsEvents(text);
  // `selfEmails` is empty on purpose: a personal feed carries no ATTENDEE lines at all, so
  // there is nobody to filter out, and inventing an identity for the user here would be
  // guessing at something no other source has to guess at.
  return recordDiscoveryCandidates(
    userId,
    calendarEventsToCandidates(events, [], feedSourceOf(provider))
  );
}

/** The feed URL with its query string removed, for anything user-visible. */
export function redactFeedUrl(feedUrl: string): string {
  try {
    const url = new URL(feedUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "that calendar link";
  }
}
