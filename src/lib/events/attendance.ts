/**
 * "Did the user actually go to this?" — the one rule every discovery source answers to.
 *
 * ## Why this exists
 *
 * A personal Luma feed is not a list of events you went to. Luma's own help page says it holds
 * everything you HOST plus every registration in any state — approved, waitlisted, or pending
 * approval. Partiful's feed carries your Maybes. A platform's mailer sends "new event from a
 * calendar you follow" alongside "you're in". Treating all of that as attendance filled the
 * events page with things the user was merely near, and every co-attendee pattern built on top
 * of it was a pattern across rooms they were never in.
 *
 * So discovery only CREATES an event it can say the user is going to (or running). A report
 * that says waitlisted, pending, maybe, invited or cancelled creates nothing — and when the
 * same event later flips to "going" (off the waitlist, approved), the next sync creates it then.
 *
 * ## Unknown is not the same everywhere
 *
 * A personal calendar feed or a calendar entry with no status is, by construction, something
 * the user registered for; unknown there means going. A confirmation-email subject that says
 * nothing about registering is far more often a newsletter or an invitation than a ticket, so
 * for mail, unknown means no.
 *
 * Pure: no database, no network. `store.ts` carries the SQL twin of this rule for rows already
 * written before it existed.
 */
import type { DiscoverySource, RsvpStatus } from "@/lib/events/discovery/types";

/** Every RSVP state that means "not in the room". */
export const NOT_ATTENDING_RSVPS: readonly RsvpStatus[] = [
  "maybe",
  "waitlist",
  "invited",
  "cancelled",
];

export function isAttendingReport(report: {
  source: DiscoverySource;
  roleHint: "hosted" | "attended" | null;
  rsvpHint: RsvpStatus | null;
}): boolean {
  if (report.roleHint === "hosted") return true;
  if (report.rsvpHint === "going") return true;
  if (report.rsvpHint !== null) return false;
  return report.source !== "gmail";
}

/**
 * What a personal feed's own words say about the user's registration.
 *
 * Platforms put the state where a calendar app will show it — a status line in the
 * description, or a prefix on the title — rather than in a standard property, because no
 * calendar app renders one. Checked in order of how final the answer is.
 */
const CANCELLED_TEXT = /\b(event (?:was |has been )?cancell?ed|cancell?ed event|registration cancell?ed|you (?:cancelled|declined))\b/i;
// About the user's own registration, never the bare word: "we have a big waitlist" is a host
// talking about the event, and a false hit here takes an event they DID attend off their page.
const WAITLIST_TEXT =
  /\b(you(?:'re| are) (?:on the )?wait-?list(?:ed)?|(?:you(?:'ve| have) )?joined the wait-?list|waitlisted|on the waiting list|pending approval|awaiting (?:host )?approval|approval pending|registration (?:is )?pending|requested to (?:join|attend)|request (?:is )?pending)\b/i;
const MAYBE_TEXT = /\b(rsvp(?:'d|ed)? maybe|you(?:'re| are| said) maybe)\b/i;
const INVITED_TEXT = /\b(you(?:'re| are| have been) invited|you've been invited|hasn't responded|not yet rsvp)/i;

export function rsvpFromFeedText(text: string): RsvpStatus | null {
  if (!text) return null;
  if (CANCELLED_TEXT.test(text)) return "cancelled";
  if (WAITLIST_TEXT.test(text)) return "waitlist";
  if (MAYBE_TEXT.test(text)) return "maybe";
  if (INVITED_TEXT.test(text)) return "invited";
  return null;
}

/** An iCalendar `PARTSTAT` (or Google `responseStatus`) as an RSVP. */
export function rsvpFromParticipation(value: string | null | undefined): RsvpStatus | null {
  const v = value?.trim().toUpperCase().replace(/_/g, "-");
  if (!v) return null;
  if (v === "ACCEPTED") return "going";
  if (v === "TENTATIVE") return "maybe";
  if (v === "DECLINED") return "cancelled";
  if (v === "NEEDS-ACTION" || v === "NEEDSACTION") return "invited";
  return null;
}
