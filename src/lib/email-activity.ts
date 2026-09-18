/**
 * Turning a synced mailbox into relationship activity.
 *
 * Orbit already knows who you know. What it did not know is when you last actually spoke to
 * them, unless you logged it by hand — so `last_interaction_at` drifted, the dormancy and
 * cadence queues nagged about people you emailed last week, and "waiting on a reply" could
 * only see follow-ups sent from inside the app.
 *
 * Three rules shape everything here, and each exists because the obvious alternative is
 * worse:
 *
 * 1. METADATA ONLY. Participants, subject, date. No body, and deliberately not the snippet
 *    either, even though the Gmail client already fetches one for recruiter detection: a
 *    snippet is the first line of the message, which is the part most likely to be private.
 *    `emailEventsFrom` has no parameter that could carry one.
 *
 * 2. NEVER CREATE CONTACTS. A mailbox contains every newsletter, receipt and recruiter
 *    blast you have ever received. Syncing one that creates people would fill the network
 *    with strangers and, on a metered plan, bill for them. Activity is recorded only against
 *    people already in the network; the caller enforces this with `createsContacts: false`.
 *
 * 3. A MESSAGE IS NOT ALWAYS A CONVERSATION. Automated senders and mass recipients are
 *    filtered here rather than at the query, because the filter has to be visible and
 *    testable — "why did Orbit think I had coffee with noreply@" is not a question anyone
 *    should have to debug from a Gmail query string.
 *
 * Pure: no database, no network. `email-activity-server.ts` does both.
 */
import type { NetworkEvent } from "@/lib/ingest/events";

/**
 * Recipients past which a message stops being correspondence.
 *
 * An email to fourteen people is an announcement, not a conversation, and recording it as a
 * touch with each of them would reset the dormancy clock on a room full of people the user
 * has not actually spoken to. Ten is generous for a real thread.
 */
export const MAX_EMAIL_PARTICIPANTS = 10;

/**
 * Local-parts that mean "do not reply", matched on the whole part rather than a substring.
 *
 * Substring matching fails in both directions here: it would catch `noreply` inside a real
 * name like `arnoreply`, and miss nothing useful. The list is short on purpose — anything
 * more aggressive starts dropping real people, and a missed filter costs one junk row while
 * an over-eager one silently loses a relationship.
 */
const AUTOMATED_LOCAL_PARTS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "notifications",
  "notification",
  "mailer-daemon",
  "postmaster",
  "bounce",
  "bounces",
  "automated",
  "alerts",
]);

export type EmailParticipant = { name: string | null; email: string };

export type EmailHeader = {
  id: string;
  threadId?: string | null;
  /** Raw `From` header. */
  from: string;
  /** Raw `To` header, comma-separated as the wire format has it. */
  to?: string | null;
  /** Raw `Cc` header. */
  cc?: string | null;
  subject?: string | null;
  /** Epoch milliseconds, as Gmail's `internalDate` gives it. */
  internalDate?: number | null;
};

/** Lowercased and trimmed; the form `contact_identities` stores for `kind = 'email'`. */
export function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return null;
  return trimmed;
}

/**
 * Pull addresses out of one raw header value.
 *
 * Handles the two shapes that actually appear on the wire — `Ada Lovelace <ada@x.com>` and a
 * bare `ada@x.com` — across a comma-separated list. Deliberately not a full RFC 5322 parser:
 * a quoted display name containing a comma splits wrongly here, and the cost of that is one
 * mangled name on an interaction, against the cost of hand-rolling a grammar nobody will
 * maintain. Addresses, which is what matching runs on, survive either way.
 */
export function parseAddressList(header: string | null | undefined): EmailParticipant[] {
  if (!header) return [];
  const out: EmailParticipant[] = [];
  for (const part of header.split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;
    const angled = chunk.match(/^(.*?)<([^>]+)>$/);
    const email = normalizeEmail(angled ? angled[2] : chunk);
    if (!email) continue;
    const rawName = angled ? angled[1].trim().replace(/^"|"$/g, "").trim() : "";
    out.push({ name: rawName || null, email });
  }
  return out;
}

/** Whether an address is a machine that cannot be corresponded with. */
export function isAutomatedAddress(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  // `ada+github@x.com` is still Ada; the tag is hers, not the sender's identity.
  const base = local.split("+")[0];
  return AUTOMATED_LOCAL_PARTS.has(base);
}

export type EmailActivityInput = {
  headers: EmailHeader[];
  /** Every address the user sends from, already normalized. */
  selfEmails: Set<string>;
  /**
   * Addresses belonging to contacts already in the network, already normalized.
   *
   * Passed in rather than looked up here so the matching rule stays visible: an address that
   * is not in this set produces no activity and no contact.
   */
  knownEmails: Set<string>;
};

/**
 * The events worth recording, ready for `ingestEvents`.
 *
 * One event per message, carrying only the counterparts that are already contacts. Direction
 * is taken from the sender: a message the user sent is `out`, which is what makes a synced
 * mailbox feed the "waiting on a reply" queue rather than just moving the last-touch date.
 */
export function emailEventsFrom(input: EmailActivityInput): NetworkEvent[] {
  const events: NetworkEvent[] = [];

  for (const header of input.headers) {
    const sender = parseAddressList(header.from)[0];
    if (!sender) continue;

    const recipients = [
      ...parseAddressList(header.to),
      ...parseAddressList(header.cc),
    ];
    const everyone = [sender, ...recipients];

    // A blast is not a conversation. Counted before filtering to contacts, because the
    // question is how many people were in the room, not how many of them Orbit knows.
    const distinct = new Set(everyone.map((p) => p.email));
    if (distinct.size > MAX_EMAIL_PARTICIPANTS) continue;

    const outbound = input.selfEmails.has(sender.email);
    // An inbound message from a machine is noise. An OUTBOUND one addressed to a machine is
    // equally not a conversation, so the check runs over whoever is not the user.
    if (!outbound && isAutomatedAddress(sender.email)) continue;

    const timestamp =
      typeof header.internalDate === "number" && Number.isFinite(header.internalDate)
        ? new Date(header.internalDate)
        : null;
    if (!timestamp || Number.isNaN(timestamp.getTime())) continue;

    const counterparts = everyone.filter(
      (p) =>
        !input.selfEmails.has(p.email) &&
        input.knownEmails.has(p.email) &&
        !isAutomatedAddress(p.email)
    );
    // Dedupe: the same person can appear on both To and Cc.
    const byEmail = new Map(counterparts.map((p) => [p.email, p]));
    if (byEmail.size === 0) continue;

    const subject = (header.subject ?? "").trim();
    events.push({
      // Ingest appends `:${contactId}`, so two recipients of one message do not collide.
      externalIdBase: `gmail:${header.id}`,
      type: "email",
      timestamp,
      direction: outbound ? "out" : "in",
      participants: [...byEmail.values()].map((p) => ({ name: p.name, email: p.email })),
      // The subject, and nothing else. No snippet, no body — see the file header.
      summary: subject ? `${outbound ? "Sent" : "Received"}: ${subject}` : null,
      notes: null,
    });
  }

  return events;
}
