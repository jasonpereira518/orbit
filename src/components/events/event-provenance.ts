/**
 * How an auto-added event explains itself.
 *
 * An event the user never typed appearing on their page is either delightful or alarming, and
 * which one it is depends entirely on whether the card can say where it came from. "Found via
 * Luma feed" is the whole difference.
 *
 * Pure strings, in their own module so the server card and the client tabs can both read them
 * without either pulling the other's runtime along.
 */
import type { EventListRow } from "@/lib/events/store";

export const DISCOVERY_LABEL: Record<NonNullable<EventListRow["discoveredVia"]>, string> = {
  gcal: "Found in your calendar",
  ics: "Found in a calendar feed",
  luma_ics: "Found via Luma",
  partiful_ics: "Found via Partiful",
  gmail: "Found in a confirmation email",
};

/** Only states worth a chip. "Going" is the assumed case and badging it says nothing. */
export const RSVP_LABEL: Partial<Record<NonNullable<EventListRow["rsvpStatus"]>, string>> = {
  maybe: "Maybe",
  waitlist: "Waitlisted",
  invited: "Invited",
  cancelled: "Cancelled",
};
