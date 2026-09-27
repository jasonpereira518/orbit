"use server";

/**
 * Send a chat draft from the user's own Gmail.
 *
 * Outbound and irreversible, so it is built to the rule at the top of `src/lib/mcp/server.ts`:
 * an agent composes, a human sends. The model wrote the draft and nothing else. This is a
 * Clerk-authed action reached only from a button in a confirmation dialog that shows From, To,
 * Subject and the final body. It takes NO recipient from the client: the address is the
 * contact record's, and the contact must be one this message actually recommended. The client's
 * `shownTo` is only compared, so a contact whose address changed after the card rendered is
 * refused rather than mailed at the new one unseen.
 *
 * A send is CLAIMED before it happens. There is no draft row to lock, so the claim is an
 * `interactions` row with a deterministic `external_id`; the unique index on
 * `(user_id, external_id)` makes the second of two clicks a no-op. If Gmail definitely refused,
 * the claim is released so a retry is allowed. If the outcome is ambiguous — the request may
 * have landed — the claim is KEPT and the person is told to check their Sent folder, because an
 * automatic retry could email the same person twice.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages, contacts, gmailConnections, interactions } from "@/db/schema";
import { getGmailSendIdentity } from "@/actions/gmail";
import { requireUserForSurface } from "@/lib/plan-guards";
import { PaywallError, requireEntitlement } from "@/lib/entitlements";
import { getValidAccessToken, hasSendScope } from "@/lib/gmail";
import { sendGmailMessage } from "@/lib/gmail-send";
import { settleWrittenInteraction } from "@/lib/contact-writes";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { reportActionError } from "@/lib/action-failure";
import {
  CHAT_SEND_DAILY_CAP,
  DEFAULT_SEND_SUBJECT,
  checkContent,
  checkRecipient,
  chatSendExternalId,
  classifySendError,
  isUuid,
} from "@/lib/chat-send";

export type ChatSendReason =
  | "plan"
  | "not_connected"
  | "needs_reconnect"
  | "missing_scope"
  | "no_email"
  | "invalid_recipient"
  | "placeholder"
  | "changed_recipient"
  | "already_sent"
  | "invalid"
  | "rate_limited"
  | "daily_limit"
  | "failed"
  | "ambiguous";

export type ChatSendResult =
  | { ok: true; sentAt: string; to: string }
  | { ok: false; reason: ChatSendReason; message: string };

const COPY: Record<ChatSendReason, string> = {
  plan: "Sending from Gmail is a Pro feature. You can copy the draft or open it in your mail app instead.",
  not_connected: "Connect Gmail to send from your own address.",
  needs_reconnect: "Gmail needs to be reconnected before it can send.",
  missing_scope: "Orbit doesn’t have Google’s permission to send as you yet.",
  no_email: "There’s no email address on this contact yet.",
  invalid_recipient: "The email address on this contact doesn’t look like a single valid address, so nothing was sent.",
  placeholder: "That’s a placeholder address, so there’s no real inbox to send to.",
  changed_recipient: "This contact’s email changed since you opened this. Reopen the draft to see where it will go.",
  already_sent: "This message was already sent to them.",
  invalid: "That message can’t be sent as written.",
  rate_limited: "You’re sending quickly — wait a few minutes and try again.",
  daily_limit: "You’ve reached today’s limit for sending from Chat. Try again tomorrow.",
  failed: "Couldn’t send that — nothing was sent. Try again?",
  ambiguous: "That may have been sent. Check your Sent folder before trying again.",
};

const fail = (reason: ChatSendReason): { ok: false; reason: ChatSendReason; message: string } => ({
  ok: false,
  reason,
  message: COPY[reason],
});

/**
 * The contact a message recommended, loaded by the user's own ids.
 *
 * Both halves are checked: the message must be this user's and must have RECOMMENDED this
 * contact, and the contact must be this user's. A forged `contactId` therefore reaches nobody,
 * and neither does a real message id paired with someone the answer never named.
 */
async function loadTarget(userId: string, messageId: string, contactId: string) {
  if (!isUuid(messageId) || !isUuid(contactId)) return null;
  const db = await getDb();
  const message = await db.query.chatMessages.findFirst({
    where: and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId), eq(chatMessages.role, "assistant")),
    columns: { id: true, recommendations: true },
  });
  if (!message) return null;
  const recommended = (message.recommendations ?? []).some((r) => r.contact_id === contactId);
  if (!recommended) return null;
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, preferredName: true, email: true },
  });
  return contact ?? null;
}

export type ChatSendContext = {
  /** False on a plan without Gmail send: the dialog offers Copy and a mail link instead. */
  planAllows: boolean;
  identity: { connected: boolean; canSend: boolean; sendingAs: string | null; displayName: string | null };
  contactName: string;
  /** The address the message will go to, or null when there is none worth showing. */
  to: string | null;
  /** Why it cannot go to that address, when it cannot. */
  recipientProblem: "no_email" | "invalid_recipient" | "placeholder" | null;
  defaultSubject: string;
  alreadySent: { at: string; to: string | null } | null;
};

/** Everything the confirm dialog shows before anything is sent. Read-only. */
export async function getChatSendContext(messageId: string, contactId: string): Promise<ChatSendContext | null> {
  const userId = await requireUserForSurface("page.chat");
  const contact = await loadTarget(userId, messageId, contactId);
  if (!contact) return null;
  const db = await getDb();

  let planAllows = true;
  try {
    await requireEntitlement(userId, "sync");
  } catch (err) {
    if (err instanceof PaywallError) planAllows = false;
    else throw err;
  }

  const identity = planAllows
    ? await getGmailSendIdentity()
    : { connected: false, canSend: false, sendingAs: null, displayName: null };
  const check = checkRecipient(contact.email);
  const claimed = await db.query.interactions.findFirst({
    where: and(eq(interactions.userId, userId), eq(interactions.externalId, chatSendExternalId(messageId, contactId))),
    columns: { interactionDate: true },
  });

  return {
    planAllows,
    identity: {
      connected: identity.connected,
      canSend: identity.canSend,
      sendingAs: identity.sendingAs,
      displayName: identity.displayName,
    },
    contactName: contact.preferredName || contact.fullName,
    to: check.ok ? check.email : (contact.email?.trim() || null),
    recipientProblem: check.ok ? null : check.reason,
    defaultSubject: DEFAULT_SEND_SUBJECT,
    alreadySent: claimed ? { at: claimed.interactionDate.toISOString(), to: check.ok ? check.email : null } : null,
  };
}

export async function sendChatDraftViaGmail(input: {
  messageId: string;
  contactId: string;
  subject?: string | null;
  body: string;
  /** The address the dialog showed. Compared only; it is never where the mail goes. */
  shownTo: string;
}): Promise<ChatSendResult> {
  const userId = await requireUserForSurface("page.chat");

  try {
    await requireEntitlement(userId, "sync");
  } catch (err) {
    if (err instanceof PaywallError) return fail("plan");
    throw err;
  }

  const db = await getDb();
  const contact = await loadTarget(userId, input.messageId, input.contactId);
  if (!contact) return fail("invalid");

  const recipient = checkRecipient(contact.email);
  if (!recipient.ok) return fail(recipient.reason === "placeholder" ? "placeholder" : recipient.reason);
  if (recipient.email.toLowerCase() !== (input.shownTo ?? "").trim().toLowerCase()) return fail("changed_recipient");

  const content = checkContent({ subject: input.subject, body: input.body });
  if (!content.ok) return fail("invalid");

  // Connection state up front, so a missing scope is a clear prompt and not a 403 after the fact.
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { status: true, scopes: true },
  });
  if (!conn) return fail("not_connected");
  if (conn.status !== "active") return fail("needs_reconnect");
  if (!hasSendScope(conn.scopes)) return fail("missing_scope");
  const identity = await getGmailSendIdentity();
  if (!identity.connected || !identity.canSend || !identity.sendingAs) return fail("not_connected");

  try {
    await consumeBucket("chatSend", userId, RATE_LIMITS.chatSend);
  } catch (err) {
    if (isRateLimitedError(err)) return fail("rate_limited");
    throw err;
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(interactions)
    .where(and(eq(interactions.userId, userId), eq(interactions.source, "chat_send"), gte(interactions.interactionDate, dayAgo)));
  if (n >= CHAT_SEND_DAILY_CAP) return fail("daily_limit");

  // A token that cannot be had is a definite failure: nothing has been requested yet.
  try {
    await getValidAccessToken(userId);
  } catch (err) {
    return fail(classifySendError(err) === "needs_reconnect" ? "needs_reconnect" : "not_connected");
  }

  // CLAIM. No row back means another click got here first (or it was already sent).
  const externalId = chatSendExternalId(input.messageId, input.contactId);
  const sentAt = new Date();
  const [claim] = await db
    .insert(interactions)
    .values({
      userId,
      contactId: input.contactId,
      interactionType: "email",
      direction: "out",
      source: "chat_send",
      externalId,
      interactionDate: sentAt,
      sameDayOrder: 0,
      rawNotes: content.body,
      aiSummary: `Sent from Chat: ${content.subject}`,
    })
    .onConflictDoNothing()
    .returning(); // bare: a field selector breaks over the Db union
  if (!claim) return fail("already_sent");

  try {
    await sendGmailMessage(userId, {
      to: recipient.email,
      subject: content.subject,
      body: content.body,
      from: { name: identity.displayName, email: identity.sendingAs },
    });
  } catch (err) {
    const kind = classifySendError(err);
    if (kind === "ambiguous") {
      // Kept on purpose. Deleting it would let a retry mail them a second time.
      await reportActionError(err, "chat.send-gmail-ambiguous", { level: "warning" }).catch(() => null);
      return fail("ambiguous");
    }
    // Gmail answered and said no (or the grant is dead): nothing went, so free the claim.
    await db.delete(interactions).where(and(eq(interactions.id, claim.id), eq(interactions.userId, userId)));
    if (kind === "needs_reconnect") return fail("missing_scope");
    await reportActionError(err, "chat.send-gmail", { level: "warning" }).catch(() => null);
    return fail("failed");
  }

  // Sent. Everything after this is best-effort: a failed rescore must never read as a failed send.
  try {
    await settleWrittenInteraction(userId, input.contactId, sentAt);
  } catch (err) {
    await reportActionError(err, "chat.send-settle", { level: "warning" }).catch(() => null);
  }
  try {
    const { clearContactFollowUp } = await import("@/actions/reminders");
    await clearContactFollowUp(input.contactId);
  } catch (err) {
    await reportActionError(err, "chat.send-clear-followup", { level: "warning" }).catch(() => null);
  }

  return { ok: true, sentAt: sentAt.toISOString(), to: recipient.email };
}
