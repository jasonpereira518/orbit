/**
 * "You wrote nine days ago and nobody has answered."
 *
 * The landing page says Orbit "tracks who replied — and nudges you about who you still owe a
 * follow-up." Half of that was true: reminders chase what you owe. The other half existed
 * only inside paid outreach campaigns, where `outreach_messages.replied_at` is recorded. The
 * personal follow-up loop — a job seeker emailing twenty people in a week — had no notion of
 * waiting for an answer at all, so a message sent and ignored looked exactly like a message
 * sent and answered.
 *
 * ## How a reply is known without asking anyone to log one
 *
 * There is no inbound feed to read, so this does not try to detect a reply. It asks a
 * narrower question that the stored data can actually answer: is the MOST RECENT thing
 * recorded against this contact something the user sent?
 *
 * That makes the state self-clearing. Anything logged afterwards — a reply, a call, a note
 * saying "they got back to me" — becomes the most recent row and the contact drops out, with
 * no extra button to press and no second state to keep in sync. It also means the claim the
 * UI makes is exactly the claim the data supports: not "they have not replied", which Orbit
 * cannot know, but "nothing has been recorded since you reached out".
 *
 * Pure: no database. `buildOutreachSuggestions` does the query and passes rows here.
 */

/** The last interaction recorded against one contact. */
export type LastTouch = {
  contactId: string;
  /** `"out"` = the user sent it, `"in"` = they did, `null` = never recorded. */
  direction: "in" | "out" | null;
  interactionDate: Date | string | null;
};

/**
 * Don't nag before a reply is even late.
 *
 * Under five days the silence means nothing — people answer on their own time and a nudge
 * this early trains users to ignore the queue. Chosen to sit clear of a working week.
 */
export const AWAITING_REPLY_MIN_DAYS = 5;

/**
 * Past this, `dormant_high_value` takes over at 30 days and says something more useful
 * ("gone quiet"). Stopping here keeps the two from competing for the same contact and
 * keeps this suggestion about a specific unanswered message rather than a cold relationship.
 */
export const AWAITING_REPLY_MAX_DAYS = 30;

export type AwaitingReply = { contactId: string; daysWaiting: number };

function wholeDaysSince(value: Date | string | null, now: Date): number | null {
  if (!value) return null;
  const then = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

/**
 * Contacts whose last recorded touch was outbound and old enough to be worth a nudge.
 *
 * A `null` direction is deliberately NOT treated as outbound. Most interactions in this app
 * carry no direction — a pasted note, an imported connection — and reading "unknown" as
 * "I sent it" would put half a LinkedIn import into a queue claiming the user is waiting on
 * a reply they never asked for. Only a row explicitly marked `out` counts.
 */
export function awaitingReplies(
  touches: LastTouch[],
  now: Date = new Date()
): AwaitingReply[] {
  const out: AwaitingReply[] = [];
  for (const t of touches) {
    if (t.direction !== "out") continue;
    const days = wholeDaysSince(t.interactionDate, now);
    if (days === null) continue;
    if (days < AWAITING_REPLY_MIN_DAYS || days > AWAITING_REPLY_MAX_DAYS) continue;
    out.push({ contactId: t.contactId, daysWaiting: days });
  }
  // Longest wait first: the message most likely to need a different approach.
  out.sort((a, b) => b.daysWaiting - a.daysWaiting);
  return out;
}

/** What the card says. Phrased as what Orbit knows, not as what the other person did. */
export function awaitingReplyDescription(daysWaiting: number): string {
  return `You reached out ${daysWaiting} day${daysWaiting === 1 ? "" : "s"} ago — nothing back yet`;
}
