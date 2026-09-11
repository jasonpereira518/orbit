/**
 * Finding events in the confirmation emails the user already has.
 *
 * The last gap the other sources leave. A Partiful party never reaches Google Calendar unless
 * the user pressed "add to calendar"; a one-off Eventbrite ticket has no feed at all. But
 * every one of these platforms sends a "you're registered" email, and most people have years
 * of them sitting in their inbox.
 *
 * ## This reads the user's mail, so the rules are strict
 *
 * `gmail.readonly` is a Google RESTRICTED scope, governed by the Limited Use policy. Every
 * constraint below is load-bearing, not defensive tidiness:
 *
 *   - **Opt-in, per user.** No row in `event_provider_connections`, no scan. The row's
 *     existence IS the consent, and deleting it is a complete opt-out.
 *   - **Platform senders only.** The Gmail query names the domains outright, so nothing else
 *     in the mailbox is ever listed, let alone opened.
 *   - **Metadata first.** Headers decide; a message body is fetched only for mail that has
 *     already passed the sender check.
 *   - **DKIM must pass.** This path takes a link out of an email and then FETCHES it. A
 *     "From: lu.ma" header is free to forge, so without the signature check the feature is a
 *     way to make Orbit fetch a URL of a stranger's choosing. `Authentication-Results` is
 *     added by Google on receipt and cannot be set by the sender.
 *   - **Known platform hosts only.** Even in a signed Luma email, only a link that is itself a
 *     recognised event URL is followed.
 *   - **Nothing is stored.** No bodies, no snippets, no addresses. The alias evidence keeps a
 *     message id, a subject line and a sender domain, which is what "why is this event here?"
 *     needs and nothing more.
 *   - **Never to AI.** No mail content reaches a model on this path or any other.
 *
 * And the rule every discovery path shares: no contacts. A confirmation email is evidence the
 * user went somewhere, not that they met anybody.
 */
import { fetchGmailHeaders, fetchGmailMessageLinks, listGmailMessagePage } from "@/lib/gmail";
import {
  extractEventLinks,
  platformForEmailDomain,
  platformOf,
  type EventPlatform,
} from "@/lib/events/platforms";
import { recordDiscoveryCandidates } from "@/lib/events/discovery/record";
import type {
  DiscoveryCandidate,
  DiscoveryStats,
  RsvpStatus,
} from "@/lib/events/discovery/types";

/** The senders worth listing at all. Anything else is never even enumerated. */
export const EVENT_MAIL_SENDERS = [
  "lu.ma",
  "luma.com",
  "luma-mail.com",
  "partiful.com",
  "eventbrite.com",
  "meetup.com",
  "posh.vip",
] as const;

/** First run: a year back. Far enough to be useful, short enough to finish. */
export const FIRST_SCAN_DAYS = 365;

/** Per pass. Listing is cheap; opening messages is not, and the pass has other work. */
export const MAX_LISTED_PER_RUN = 100;
export const MAX_BODIES_PER_RUN = 40;

export type GmailScanCursor = {
  /** Unix seconds. Everything older has been scanned already. */
  after?: number;
  /** Gmail's own page token, so a budget stop resumes rather than restarting. */
  pageToken?: string | null;
};

export function buildEventMailQuery(afterEpochSeconds: number): string {
  const senders = EVENT_MAIL_SENDERS.map((domain) => `from:${domain}`).join(" OR ");
  return `(${senders}) after:${afterEpochSeconds}`;
}

/**
 * Did Google verify this message came from the domain it claims?
 *
 * Looks for a `dkim=pass` whose `header.d` (or `header.i`) is the sender's own domain — a
 * message can carry several DKIM results, including one for a mailing list that merely
 * relayed it, and only the sender's own signature says anything about the sender.
 */
export function senderIsAuthentic(authResults: string, senderDomain: string): boolean {
  if (!authResults || !senderDomain) return false;
  const domain = senderDomain.toLowerCase();
  for (const hit of authResults.matchAll(/dkim=(\w+)([^;]*)/gi)) {
    if (hit[1]?.toLowerCase() !== "pass") continue;
    const signer = /header\.(?:d|i)=([^\s;]+)/i.exec(hit[2] ?? "")?.[1]?.toLowerCase() ?? "";
    const signerDomain = signer.replace(/^@/, "").replace(/^.*@/, "");
    if (signerDomain && (domain === signerDomain || domain.endsWith(`.${signerDomain}`))) {
      return true;
    }
  }
  return false;
}

export function domainOf(fromHeader: string): string | null {
  const at = fromHeader.lastIndexOf("@");
  if (at < 0) return null;
  return (
    fromHeader
      .slice(at + 1)
      .replace(/[>\s].*$/, "")
      .trim()
      .toLowerCase() || null
  );
}

export type MailClassification = {
  platform: EventPlatform;
  roleHint: "hosted" | "attended" | null;
  rsvpHint: RsvpStatus | null;
};

/** Subjects that mean the user is RUNNING this one, not attending it. */
const HOST_SUBJECT =
  /\b(your event is live|you (?:just )?(?:created|published)|new (?:guest|registration|rsvp)|someone registered|ticket sold|your event on)\b/i;
const WAITLIST_SUBJECT = /\b(waitlist(?:ed)?|on the waiting list|pending approval|awaiting approval)\b/i;
const CANCELLED_SUBJECT = /\b(cancell?ed|has been called off|is no longer happening)\b/i;
const MAYBE_SUBJECT = /\b(maybe|tentative)\b/i;
const GOING_SUBJECT =
  /\b(you(?:'re| are) (?:in|going|registered|confirmed)|see you (?:there|at)|your ticket|registration confirmed|rsvp confirmed|thanks for registering|you're on the list)\b/i;

/**
 * What kind of mail this is, from its subject alone.
 *
 * Subject-only on purpose: it is the one piece of a message we were going to keep anyway (the
 * user needs it to answer "why is this event here?"), so classifying on it adds no new data to
 * the blast radius. A body-based classifier would be marginally more accurate and would mean
 * reading, and reasoning over, the contents of somebody's mail.
 *
 * Unknown is a fine answer: the default is `attended`, which is right far more often than not.
 */
export function classifyEventMail(
  fromHeader: string,
  subject: string
): MailClassification | null {
  const domain = domainOf(fromHeader);
  const platform = domain ? platformForEmailDomain(domain) : null;
  if (!platform) return null;

  return {
    platform,
    roleHint: HOST_SUBJECT.test(subject) ? "hosted" : null,
    rsvpHint: CANCELLED_SUBJECT.test(subject)
      ? "cancelled"
      : WAITLIST_SUBJECT.test(subject)
        ? "waitlist"
        : GOING_SUBJECT.test(subject)
          ? "going"
          : MAYBE_SUBJECT.test(subject)
            ? "maybe"
            : null,
  };
}

export type GmailScanDeps = {
  listPage: typeof listGmailMessagePage;
  headers: typeof fetchGmailHeaders;
  links: typeof fetchGmailMessageLinks;
};

const DEFAULT_DEPS: GmailScanDeps = {
  listPage: listGmailMessagePage,
  headers: fetchGmailHeaders,
  links: fetchGmailMessageLinks,
};

export type GmailScanResult = {
  stats: DiscoveryStats;
  cursor: GmailScanCursor;
  listed: number;
  opened: number;
  /** Messages from a platform domain whose DKIM did not verify. Dropped, and counted. */
  unauthenticated: number;
};

/**
 * One pass over the mailbox.
 *
 * Resumable: the cursor carries Gmail's page token and how far back has been covered, so a
 * pass that runs out of budget continues where it stopped rather than starting the year again.
 */
export async function scanGmailForEvents(
  userId: string,
  accessToken: string,
  cursor: GmailScanCursor | null,
  options: { now?: Date; deps?: GmailScanDeps } = {}
): Promise<GmailScanResult> {
  const deps = options.deps ?? DEFAULT_DEPS;
  const now = options.now ?? new Date();
  const after =
    cursor?.after ?? Math.floor((now.getTime() - FIRST_SCAN_DAYS * 86_400_000) / 1000);

  const page = await deps.listPage(accessToken, {
    query: buildEventMailQuery(after),
    pageToken: cursor?.pageToken ?? null,
    maxResults: MAX_LISTED_PER_RUN,
  });

  const result: GmailScanResult = {
    stats: { created: 0, attached: 0, suppressed: 0, enrichQueued: 0 },
    cursor: { after, pageToken: page.nextPageToken },
    listed: page.messages.length,
    opened: 0,
    unauthenticated: 0,
  };

  // The listing is complete: next time, start from today rather than a year ago. One day of
  // overlap, because Gmail's `after:` is date-granular and an event that arrives during a run
  // must not fall into the gap.
  if (!page.nextPageToken) {
    result.cursor = {
      after: Math.floor(now.getTime() / 1000) - 86_400,
      pageToken: null,
    };
  }

  if (page.messages.length === 0) return result;

  // Headers first. Cheap, and enough to drop anything that is not a signed platform mail —
  // so a body is only ever opened for mail we have already decided is a confirmation.
  const headers = await deps.headers(accessToken, page.messages);
  const keep: Array<{ id: string; subject: string; domain: string; classified: MailClassification }> =
    [];

  for (const header of headers) {
    const classified = classifyEventMail(header.from, header.subject);
    if (!classified) continue;
    const domain = domainOf(header.from);
    if (!domain) continue;
    keep.push({ id: header.id, subject: header.subject, domain, classified });
  }

  const ids = keep.slice(0, MAX_BODIES_PER_RUN).map((item) => item.id);
  if (ids.length === 0) return result;

  const messages = await deps.links(accessToken, ids);
  result.opened = messages.length;

  const candidates: DiscoveryCandidate[] = [];
  for (const message of messages) {
    const kept = keep.find((item) => item.id === message.id);
    if (!kept) continue;

    // The check that makes "from: lu.ma" mean something. Without it, anyone who can send the
    // user an email can choose a URL for Orbit to fetch.
    if (!senderIsAuthentic(message.authenticationResults, kept.domain)) {
      result.unauthenticated++;
      continue;
    }

    // Known platform hosts only, even inside a verified email — a tracking redirector or an
    // unsubscribe link in a genuine Luma mail is still not an event.
    const links = extractEventLinks(message.links.join("\n"), { max: 3 });
    const link = links.find((candidate) => platformOf(candidate)) ?? null;
    if (!link) continue;

    const match = platformOf(link);
    candidates.push({
      source: "gmail",
      sourceRef: `gmail:${message.id}`,
      url: link,
      platform: match?.platform ?? kept.classified.platform,
      providerEventId: match?.providerEventId ?? null,
      // The page read that follows will replace this with the event's real name. A subject
      // line is a decent placeholder and a poor title.
      title: null,
      startsAt: null,
      endsAt: null,
      timezone: null,
      location: null,
      roleHint: kept.classified.roleHint,
      rsvpHint: kept.classified.rsvpHint,
      // A confirmation email names one guest: the user. There is no guest list here.
      attendees: [],
      evidence: {
        subject: kept.subject.slice(0, 200),
        fromDomain: kept.domain,
        receivedAt: message.internalDate,
      },
    });
  }

  if (candidates.length > 0) {
    result.stats = await recordDiscoveryCandidates(userId, candidates);
  }
  return result;
}
