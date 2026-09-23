/**
 * The BCC logging address: `log-<token>@<domain>`.
 *
 * A person BCCs (or forwards) a message to their own address and the people on it become an
 * interaction in Orbit. It is the only Tier 1 connector that needs no OAuth at all, which is
 * the point — it works from Apple Mail, Outlook desktop, a phone's stock client, anything
 * that can put an address in a header.
 *
 * ## What this module is, and is not
 *
 * Parsing and mapping only. It issues no database statement except the token lookup, and it
 * knows nothing about any mail provider's webhook shape: a route hands it an
 * `InboundMessage`, which is the small normalised thing every provider can produce. Keeping
 * the provider adapter outside this file is what lets the receiving service change without
 * touching the part that decides who a message is about.
 *
 * ## The address is a bearer credential
 *
 * Anyone who learns it can write interactions into that account. So the column stores only
 * the token's SHA-256, exactly as `user_settings.calendar_feed_token` does and for the same
 * reason — a copy of the table grants nobody a write path. The plaintext exists once, when
 * it is minted, and rotating is how a person gets a new one.
 *
 * ## Who the interaction is with
 *
 * Everyone on the message except the user and except the log address itself. A BCC'd message
 * carries the real recipients in To/Cc, so the counterparties are simply those minus self —
 * the same shape `counterpartsOf` computes for a calendar event's attendees.
 */
import { createHash, randomBytes } from "crypto";
import type { NetworkEvent, NetworkParticipant } from "@/lib/ingest/events";
import { mailExternalIdBase } from "@/lib/ingest/external-id";

/** The local part's fixed prefix, so a human reading a header knows what the address is. */
const LOCAL_PREFIX = "log-";

/**
 * One inbound message, normalised.
 *
 * Deliberately the intersection of what every inbound provider gives you, not the union:
 * a field that only one of them supplies would quietly become a dependency on that one.
 */
export type InboundMessage = {
  /** RFC 5322 Message-ID, without angle brackets. The dedupe key; a message without one is dropped. */
  messageId: string | null;
  /** Envelope/header date. Falls back to receipt time when a client omits or mangles it. */
  sentAt: Date | null;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string | null;
  /** First lines of the body, already stripped of markup by the provider. Optional. */
  snippet?: string | null;
};

export type MailAddress = { email: string; name?: string | null };

export function generateInboundLogToken(): string {
  // 18 bytes → 24 base64url characters. Short enough to retype from a phone, far past
  // guessing: an attacker would need ~10^43 tries, and the route rate-limits anyway.
  return randomBytes(18).toString("base64url");
}

/** What `user_settings.inbound_log_token` stores. Same convention as the calendar feed's. */
export function hashInboundLogToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The address a person BCCs. The domain is configuration, not a constant, so it can move. */
export function inboundLogAddress(token: string, domain: string): string {
  return `${LOCAL_PREFIX}${token}@${domain}`;
}

/**
 * Pull the token out of whichever recipient is ours.
 *
 * A BCC'd message lists the log address nowhere a client shows, but every provider hands the
 * envelope recipient to the webhook, and a forwarded one has it in To. So every address on
 * the message is checked and the first that matches the shape and domain wins. Returns null
 * rather than throwing: a message that reaches the endpoint without our address on it is a
 * misconfiguration or a probe, not an exception.
 */
export function tokenFromRecipients(
  recipients: Array<string | MailAddress>,
  domain: string
): string | null {
  for (const entry of recipients) {
    const email = (typeof entry === "string" ? entry : entry.email).trim().toLowerCase();
    const at = email.lastIndexOf("@");
    if (at < 0) continue;
    if (email.slice(at + 1) !== domain.toLowerCase()) continue;
    const local = email.slice(0, at);
    if (!local.startsWith(LOCAL_PREFIX)) continue;
    const token = local.slice(LOCAL_PREFIX.length);
    if (token.length > 0) return token;
  }
  return null;
}

/**
 * Everyone the message is with, from the user's point of view.
 *
 * `self` is every address that IS the user — their own sending address and any alias the
 * connection knows — and the log address is removed by shape, so rotating it or owning
 * several never leaks one into a contact list. Order is preserved and duplicates collapse on
 * lowercased address, because the same person often appears in both To and Cc.
 */
export function counterpartsOf(
  message: InboundMessage,
  opts: { self: string[]; domain: string }
): NetworkParticipant[] {
  const selfSet = new Set(opts.self.map((s) => s.trim().toLowerCase()));
  const seen = new Set<string>();
  const people: NetworkParticipant[] = [];

  for (const addr of [message.from, ...message.to, ...message.cc]) {
    if (!addr?.email) continue;
    const email = addr.email.trim().toLowerCase();
    if (!email || selfSet.has(email)) continue;
    // The log address itself, however many a person has minted.
    const at = email.lastIndexOf("@");
    if (at > 0 && email.slice(at + 1) === opts.domain.toLowerCase() && email.startsWith(LOCAL_PREFIX)) {
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    people.push({ email: addr.email.trim(), name: addr.name?.trim() || null });
  }

  return people;
}

/**
 * Shape one message for ingest, or null when there is nothing to log.
 *
 * Null for two reasons, both of which are normal rather than faults: no Message-ID, so the
 * message cannot be deduped and a re-send would double-log it; and nobody on it but the
 * user, which is what a note-to-self looks like and is not a relationship touch.
 */
export function toNetworkEvent(
  message: InboundMessage,
  opts: { self: string[]; domain: string; receivedAt: Date }
): NetworkEvent | null {
  if (!message.messageId) return null;
  const participants = counterpartsOf(message, opts);
  if (participants.length === 0) return null;

  return {
    externalIdBase: mailExternalIdBase(message.messageId),
    type: "email",
    timestamp: message.sentAt ?? opts.receivedAt,
    participants,
    summary: message.subject?.trim() || null,
    notes: message.snippet?.trim() || null,
  };
}

/**
 * Mint an address for this user, replacing any existing one.
 *
 * Returns the plaintext token — the only moment it exists outside the person's mail client.
 * Rotating is how somebody who pasted the address somewhere public gets a new one, and it
 * invalidates the old one immediately, by construction: nothing stores it to compare against.
 */
export async function mintInboundLogToken(userId: string): Promise<string> {
  const token = generateInboundLogToken();
  const { getDb } = await import("@/db");
  const { userSettings } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  await db
    .update(userSettings)
    .set({
      inboundLogToken: hashInboundLogToken(token),
      inboundLogTokenCreatedAt: new Date(),
      inboundLogLastReceivedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));
  return token;
}

/** Stop accepting mail at this account's address. */
export async function clearInboundLogToken(userId: string): Promise<void> {
  const { getDb } = await import("@/db");
  const { userSettings } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  await db
    .update(userSettings)
    .set({
      inboundLogToken: null,
      inboundLogTokenCreatedAt: null,
      inboundLogLastReceivedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.userId, userId));
}

/**
 * Whose address is this token, if anyone's.
 *
 * One indexed lookup on the hash. Returns null for an unknown token rather than throwing,
 * because the common cause is a rotated address still sitting in someone's mail rules — an
 * expected event, not an error to page on.
 */
export async function userForInboundToken(token: string): Promise<string | null> {
  const { getDb } = await import("@/db");
  const { userSettings } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  const [row] = await db
    .select({ userId: userSettings.userId })
    .from(userSettings)
    .where(eq(userSettings.inboundLogToken, hashInboundLogToken(token)))
    .limit(1);
  return row?.userId ?? null;
}

export type LogMailResult =
  | { ok: true; interactionsLogged: number; contactsCreated: number }
  | { ok: false; reason: "unknown-token" | "not-loggable" };

/**
 * Turn one delivered message into interactions.
 *
 * `createsContacts` is TRUE: a person the user is emailing is a person they know, which is
 * the same judgement calendar sync makes for a meeting's attendees. The one-shot file import
 * is the deliberate opposite — a file is somebody else's list, so it gets a review screen.
 */
export async function logInboundMail(
  message: InboundMessage,
  opts: { token: string; domain: string; self?: string[]; receivedAt?: Date }
): Promise<LogMailResult> {
  const userId = await userForInboundToken(opts.token);
  if (!userId) return { ok: false, reason: "unknown-token" };

  const receivedAt = opts.receivedAt ?? new Date();
  const event = toNetworkEvent(message, {
    self: opts.self ?? [],
    domain: opts.domain,
    receivedAt,
  });
  if (!event) return { ok: false, reason: "not-loggable" };

  const { openIngestContext, ingestEvents, finalizeIngest } = await import("@/lib/ingest/events");
  const ctx = await openIngestContext(userId, { source: "inbound_mail", createsContacts: true });
  const stats = await ingestEvents(ctx, [event]);
  await finalizeIngest(ctx);

  const { getDb } = await import("@/db");
  const { userSettings } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ inboundLogLastReceivedAt: receivedAt })
    .where(eq(userSettings.userId, userId));

  return {
    ok: true,
    interactionsLogged: stats.interactionsLogged,
    contactsCreated: stats.contactsCreated,
  };
}
