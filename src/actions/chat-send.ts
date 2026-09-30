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
 * The send goes through the email outbox (`src/lib/email/outbox.ts`) with a 10-second undo
 * window. Its idempotency key is the same `chat-send:<message>:<contact>` key the interaction
 * is logged under, so a second click is refused while the first is queued or sent, and the
 * card's "already sent" lookup in `src/actions/chat.ts` keeps working unchanged. Ambiguous
 * provider outcomes are the outbox's to handle: it checks Sent before any retry and never
 * resends blind.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages, contacts, emailSends, interactions } from "@/db/schema";
import { getCurrentUserProfile } from "@/lib/auth";
import { requireUserForSurface } from "@/lib/plan-guards";
import { UNDO_DELAY_MS } from "@/lib/email/config";
import { ENQUEUE_COPY, enqueueEmail, type EnqueueRefusal } from "@/lib/email/outbox";
import { scheduleDispatch } from "@/lib/email/schedule";
import { getSendCapability, type MailboxId, type SendBlockReason } from "@/lib/email/sender";
import {
  DEFAULT_SEND_SUBJECT,
  checkContent,
  checkRecipient,
  chatSendExternalId,
  isUuid,
} from "@/lib/chat-send";

export type ChatSendReason =
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
  | "cap_reached";

export type ChatSendResult =
  | { ok: true; sendId: string; sendAt: string; to: string }
  | { ok: false; reason: ChatSendReason; message: string };

const COPY: Record<ChatSendReason, string> = {
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
  cap_reached: ENQUEUE_COPY.cap_reached,
};

const CHAT_REASON_FOR: Record<EnqueueRefusal, ChatSendReason> = {
  not_connected: "not_connected",
  no_send_scope: "missing_scope",
  needs_reauth: "needs_reconnect",
  cap_reached: "cap_reached",
  rate_limited: "rate_limited",
  duplicate: "already_sent",
  no_recipient: "no_email",
  too_many: "invalid_recipient",
  invalid_recipient: "invalid_recipient",
  placeholder: "placeholder",
  empty_body: "invalid",
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
  /**
   * The mailbox this send would leave from (Gmail or Outlook — whichever `resolveSender`
   * picks), or why nothing can send right now and which mailbox to fix.
   */
  identity: {
    canSend: boolean;
    sendingAs: string | null;
    displayName: string | null;
    block: { reason: SendBlockReason | "cap_reached"; provider: MailboxId | null } | null;
    outlookAvailable: boolean;
  };
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
  const key = chatSendExternalId(messageId, contactId);

  const [capability, profile] = await Promise.all([
    getSendCapability(userId),
    getCurrentUserProfile().catch(() => null),
  ]);
  const check = checkRecipient(contact.email);
  const [logged, pending] = await Promise.all([
    db.query.interactions.findFirst({
      where: and(eq(interactions.userId, userId), eq(interactions.externalId, key)),
      columns: { interactionDate: true },
    }),
    // A send still inside its undo window, or mid-flight, has no interaction yet.
    db.query.emailSends.findFirst({
      where: and(
        eq(emailSends.userId, userId),
        eq(emailSends.idempotencyKey, key),
        inArray(emailSends.status, ["queued", "sending"])
      ),
      columns: { sendAt: true },
    }),
  ]);
  const sentAt = logged?.interactionDate ?? pending?.sendAt ?? null;

  return {
    identity: {
      canSend: capability.ok,
      sendingAs: capability.ok ? capability.fromEmail : null,
      displayName: profile?.name?.trim() || null,
      block: capability.ok ? null : { reason: capability.reason, provider: capability.provider },
      outlookAvailable: capability.outlookAvailable,
    },
    contactName: contact.preferredName || contact.fullName,
    to: check.ok ? check.email : (contact.email?.trim() || null),
    recipientProblem: check.ok ? null : check.reason,
    defaultSubject: DEFAULT_SEND_SUBJECT,
    alreadySent: sentAt ? { at: sentAt.toISOString(), to: check.ok ? check.email : null } : null,
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
  const contact = await loadTarget(userId, input.messageId, input.contactId);
  if (!contact) return fail("invalid");
  const recipient = checkRecipient(contact.email);
  if (!recipient.ok) return fail(recipient.reason === "placeholder" ? "placeholder" : recipient.reason);
  if (recipient.email.toLowerCase() !== (input.shownTo ?? "").trim().toLowerCase()) return fail("changed_recipient");
  const content = checkContent({ subject: input.subject, body: input.body });
  if (!content.ok) return fail("invalid");

  const profile = await getCurrentUserProfile().catch(() => null);
  const queued = await enqueueEmail(userId, {
    to: [recipient.email],
    subject: content.subject,
    bodyText: content.body,
    fromName: profile?.name?.trim() || null,
    origin: "chat",
    originRef: input.messageId,
    idempotencyKey: chatSendExternalId(input.messageId, input.contactId),
    contactIds: [input.contactId],
    delayMs: UNDO_DELAY_MS,
  });
  if (!queued.ok) return fail(CHAT_REASON_FOR[queued.reason]);
  scheduleDispatch(queued.id, queued.sendAt);
  return { ok: true, sendId: queued.id, sendAt: queued.sendAt.toISOString(), to: recipient.email };
}
