import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { contactIdentities, gmailConnections } from "@/db/schema";
import {
  emailEventsFrom,
  normalizeEmail,
  type EmailHeader,
} from "@/lib/email-activity";
import {
  fetchGmailHeaders,
  getValidAccessToken,
  listGmailMessagePage,
} from "@/lib/gmail";
import {
  finalizeIngest,
  ingestEvents,
  openIngestContext,
} from "@/lib/ingest/events";

export const EMAIL_ACTIVITY_SOURCE = "gmail_activity";

/** Messages pulled per pass. One page of ids, then one metadata fetch each. */
export const EMAIL_ACTIVITY_PAGE_SIZE = 100;

/**
 * How far back a first sync reaches.
 *
 * A mailbox goes back years, and importing all of it would rewrite every contact's
 * last-touch date in one pass — turning the dormancy queue inside out on the strength of a
 * conversation from 2019. Ninety days is the window in which "when did we last speak"
 * changes any decision the app makes.
 */
export const EMAIL_ACTIVITY_FIRST_SYNC_DAYS = 90;

export type EmailActivityDeps = {
  getAccessToken: typeof getValidAccessToken;
  listPage: typeof listGmailMessagePage;
  fetchHeaders: typeof fetchGmailHeaders;
};

const DEFAULT_DEPS: EmailActivityDeps = {
  getAccessToken: getValidAccessToken,
  listPage: listGmailMessagePage,
  fetchHeaders: fetchGmailHeaders,
};

export type EmailActivityStats = {
  fetched: number;
  matched: number;
  interactionsLogged: number;
  contactsCreated: number;
};

/**
 * Gmail's search query for one pass.
 *
 * `-in:chats` because Hangouts/Chat messages surface through the same API and are not mail.
 * `-category:promotions -category:social` drops the two buckets that are mass mail by
 * definition; the automated-sender filter in `email-activity.ts` catches the rest, and it is
 * the one that is visible and tested. Anchored on a date rather than a history id so a
 * connection that has been idle for months resumes with a bounded window instead of
 * replaying everything since it was last seen.
 */
export function buildActivityQuery(since: Date): string {
  const epochSeconds = Math.floor(since.getTime() / 1000);
  return `after:${epochSeconds} -in:chats -category:promotions -category:social`;
}

/**
 * Every address the network already knows, and every address the user sends from.
 *
 * Read from `contact_identities` rather than `contacts.email`, because that table is the
 * identity of record: it holds the secondary addresses a merge folded in, which is exactly
 * where a real thread tends to come from.
 */
async function loadAddressSets(userId: string, selfEmail: string) {
  const db = await getDb();
  const rows = await db.query.contactIdentities.findMany({
    where: and(
      eq(contactIdentities.userId, userId),
      inArray(contactIdentities.kind, ["email"])
    ),
    columns: { value: true },
  });

  const knownEmails = new Set<string>();
  for (const row of rows) {
    const email = normalizeEmail(row.value);
    if (email) knownEmails.add(email);
  }

  const selfEmails = new Set<string>();
  const self = normalizeEmail(selfEmail);
  if (self) selfEmails.add(self);
  // The user's own address must never count as a contact, even if some import once wrote it
  // as one — that would log every sent message as a conversation with yourself.
  for (const address of selfEmails) knownEmails.delete(address);

  return { knownEmails, selfEmails };
}

/**
 * Record one pass of email activity for a connected mailbox.
 *
 * Deliberately records activity ONLY against people already in the network
 * (`createsContacts: false`). A mailbox holds every newsletter and recruiter blast the user
 * has ever received; a sync that created contacts would fill the network with strangers and,
 * on a metered plan, charge for them.
 *
 * `matchConfidence: 0.95` is the "Same email" tier in `duplicates.ts`, and nothing below it
 * is allowed to match. The calendar path can afford fuzzier matching because an attendee
 * list is curated; a mailbox is not, and folding "sarah@" into the wrong Sarah by name
 * writes a conversation onto someone who never had it.
 *
 * Note the ceiling: the highest confidence any matcher produces is 0.98, so a threshold of 1
 * silently matches NOTHING — the sync runs, reports messages fetched, and records nothing at
 * all. That is what this was set to first, and only the smoke test noticed.
 */
export async function syncEmailActivity(
  userId: string,
  options: { selfEmail: string; since: Date; pageToken?: string | null },
  deps: Partial<EmailActivityDeps> = {}
): Promise<EmailActivityStats & { nextPageToken: string | null }> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const stats: EmailActivityStats = {
    fetched: 0,
    matched: 0,
    interactionsLogged: 0,
    contactsCreated: 0,
  };

  const { knownEmails, selfEmails } = await loadAddressSets(userId, options.selfEmail);
  // Nothing in the network has an email address, so nothing can match. Skipped before the
  // provider call rather than after it: the request would be answered and thrown away.
  if (knownEmails.size === 0) return { ...stats, nextPageToken: null };

  const accessToken = await d.getAccessToken(userId);
  const page = await d.listPage(accessToken, {
    query: buildActivityQuery(options.since),
    pageToken: options.pageToken ?? null,
    maxResults: EMAIL_ACTIVITY_PAGE_SIZE,
  });
  if (page.messages.length === 0) {
    return { ...stats, nextPageToken: page.nextPageToken };
  }

  const headers = await d.fetchHeaders(accessToken, page.messages);
  stats.fetched = headers.length;

  const events = emailEventsFrom({
    headers: headers as EmailHeader[],
    selfEmails,
    knownEmails,
  });
  stats.matched = events.length;
  if (events.length === 0) {
    return { ...stats, nextPageToken: page.nextPageToken };
  }

  const ctx = await openIngestContext(userId, {
    source: EMAIL_ACTIVITY_SOURCE,
    createsContacts: false,
    matchConfidence: 0.95,
  });
  const ingested = await ingestEvents(ctx, events);
  await finalizeIngest(ctx);

  stats.interactionsLogged = ingested.interactionsLogged;
  stats.contactsCreated = ingested.contactsCreated;
  return { ...stats, nextPageToken: page.nextPageToken };
}

/** When this connection should resume from. */
export async function emailActivitySince(userId: string): Promise<Date> {
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { lastSyncedAt: true },
  });
  const firstWindow = new Date(
    Date.now() - EMAIL_ACTIVITY_FIRST_SYNC_DAYS * 24 * 60 * 60 * 1000
  );
  if (!conn?.lastSyncedAt) return firstWindow;
  // Never reach further back than the first-sync window, however long the connection has
  // been idle: a mailbox that has not synced since last year should not replay a year.
  const last = new Date(conn.lastSyncedAt);
  return last > firstWindow ? last : firstWindow;
}
