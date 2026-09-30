import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import {
  emailSends,
  gmailConnections,
  type EmailFailureKind,
  type EmailOrigin,
  type EmailProviderId,
  type EmailAttachmentRef,
  type EmailSendRecord,
} from "@/db/schema";
import { logInteractionForUser } from "@/lib/contact-writes";
import {
  EMAIL_LEASE_SECONDS,
  EMAIL_SEND_DAILY_CAP,
  MAX_EMAIL_ATTEMPTS,
  SCHEDULE_MAX_LEAD_MS,
  SCHEDULE_MIN_LEAD_MS,
  emailBackoffSeconds,
} from "@/lib/email/config";
import { loadAttachmentBytes } from "@/lib/email/attachments";
import { resolveRecipientContacts } from "@/lib/email/contacts";
import { newRfcMessageId } from "@/lib/email/mime";
import { originHooks } from "@/lib/email/origins";
import { providerFor } from "@/lib/email/providers";
import { MailProviderError, type SendResult } from "@/lib/email/providers/types";
import { normalizeRecipients } from "@/lib/email/recipients";
import { countEmailSendsToday, resolveSender, type MailboxId } from "@/lib/email/sender";
import { getEntitlements } from "@/lib/entitlements";
import { markOutlookNeedsReauth } from "@/lib/outlook";
import { consumeBucket, isRateLimitedError, RATE_LIMITS } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";

/**
 * The person-to-person email outbox. Every 1:1 send in Orbit — Compose, follow-ups, Chat,
 * approved assistant drafts, recruiter replies — enters through `enqueueEmail` and leaves
 * through `dispatchEmailSend`. Spec: docs/superpowers/specs/2026-09-29-direct-email-design.md.
 *
 * Claim and settle follow `src/lib/connectors/outbox.ts`:
 *   1. A claim is one UPDATE that takes a `queued` row, or a `sending` row whose lease has
 *      lapsed, and stamps `claimed_by` + `lease_until = now() + …` on the DATABASE clock.
 *   2. Every settle write is guarded on `claimed_by`, so a dispatcher whose lease lapsed
 *      mid-send cannot overwrite the one that re-claimed the row.
 *   3. A retry of a send that may have reached the provider looks for its fixed Message-ID
 *      in Sent before sending again, and gives up rather than guess when it can't look.
 */

export type EnqueueRefusal =
  | "not_connected"
  | "no_send_scope"
  | "needs_reauth"
  | "cap_reached"
  | "rate_limited"
  | "no_recipient"
  | "too_many"
  | "invalid_recipient"
  | "placeholder"
  | "empty_body"
  | "duplicate"
  | "bad_schedule"
  | "too_many_files"
  | "too_large"
  | "blocked_type"
  | "file_missing";

export const ENQUEUE_COPY: Record<EnqueueRefusal, string> = {
  not_connected: "Connect your email to send from your own address",
  no_send_scope: "Allow Orbit to send from your email, then try again",
  needs_reauth: "Your email connection expired — reconnect to send",
  cap_reached: "You've reached today's email limit — it resets over the next 24 hours",
  rate_limited: "That's a lot of email in a few minutes — try again shortly",
  no_recipient: "Add at least one recipient",
  too_many: "That's more than 20 recipients — trim the list",
  invalid_recipient: "One of those addresses doesn't look right",
  placeholder: "That's a placeholder address, not a real inbox",
  empty_body: "Write something before sending",
  duplicate: "That message is already on its way",
  bad_schedule: "Pick a time between a minute and 30 days from now",
  too_many_files: "Attach up to 10 files",
  too_large: "Those attachments are too big to send",
  blocked_type: "One of those files can’t be sent by email",
  file_missing: "One of those files isn’t available — attach it again",
};

export type EnqueueInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  /** The sender's display name. Captured here because the drain has no request to ask Clerk. */
  fromName?: string | null;
  origin: EmailOrigin;
  originRef?: string | null;
  idempotencyKey?: string | null;
  /** 10s for interactive sends (the undo window), 0 for already-confirmed ones. */
  delayMs: number;
  /** Provider thread to reply into (recruiter replies). */
  threadId?: string | null;
  inReplyToRfcId?: string | null;
  /** Skip the lookup when the caller already knows (e.g. a contact-page send). */
  contactIds?: string[];
  /**
   * False when the caller already charged the burst bucket for a whole batch (recruiter
   * sends): a batch the person approved at once is one action, not twenty. The daily cap
   * still counts every message.
   */
  chargeBurst?: boolean;
  /**
   * Send from this mailbox specifically (Compose's From picker, recruiter replies). Honoured
   * only if it can send; an explicit choice is refused rather than silently swapped.
   */
  provider?: MailboxId;
  /** Already verified by the caller (`verifyAttachmentRefs`). */
  attachments?: EmailAttachmentRef[];
  /** Send at this time instead of after `delayMs` (a scheduled send, P4). */
  sendAt?: Date;
};

export type EnqueueResult =
  | { ok: true; id: string; sendAt: Date; to: string[]; provider: EmailProviderId }
  | { ok: false; reason: EnqueueRefusal; message: string };

const refuse = (reason: EnqueueRefusal): EnqueueResult => ({ ok: false, reason, message: ENQUEUE_COPY[reason] });

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

function cleanSubject(subject: string): string {
  const one = subject.replace(/\s+/g, " ").trim();
  return (one || "(no subject)").slice(0, 200);
}

/**
 * The only way a person-to-person email enters Orbit's outbox. Validates, checks the sender,
 * the burst bucket and the daily cap, then inserts a `queued` row due at now() + delayMs on
 * the database clock. It never sends: `dispatchEmailSend` does, from `after()` or the drain.
 */
export async function enqueueEmail(userId: string, input: EnqueueInput): Promise<EnqueueResult> {
  const bodyText = input.bodyText.replace(/\r\n/g, "\n").trim();
  if (!bodyText) return refuse("empty_body");

  const recipients = normalizeRecipients({ to: input.to, cc: input.cc, bcc: input.bcc });
  if (!recipients.ok) return refuse(recipients.reason);

  const sender = await resolveSender(userId, input.provider ?? null);
  if (!sender.ok) return refuse(sender.reason);
  if (input.provider && sender.provider !== input.provider) return refuse("not_connected");

  if (input.sendAt) {
    const lead = input.sendAt.getTime() - Date.now();
    if (!Number.isFinite(lead) || lead < SCHEDULE_MIN_LEAD_MS || lead > SCHEDULE_MAX_LEAD_MS) {
      return refuse("bad_schedule");
    }
  }

  if (input.chargeBurst !== false) {
    const limited = await chargeEmailBurst(userId);
    if (limited) return limited;
  }

  const [ent, used] = await Promise.all([getEntitlements(userId), countEmailSendsToday(userId)]);
  if (used >= EMAIL_SEND_DAILY_CAP[ent.plan]) return refuse("cap_reached");

  const contactIds = input.contactIds ?? (await resolveRecipientContacts(userId, recipients.all));
  const db = await getDb();
  try {
    const [row] = await db
      .insert(emailSends)
      .values({
        userId,
        provider: sender.provider,
        fromEmail: sender.fromEmail,
        fromName: input.fromName?.trim() || null,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject: cleanSubject(input.subject),
        bodyText,
        bodyHtml: input.bodyHtml ?? null,
        contactIds,
        origin: input.origin,
        originRef: input.originRef ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        status: "queued",
        sendAt: input.sendAt ?? sql`now() + (${Math.max(0, input.delayMs) / 1000}::double precision * interval '1 second')`,
        attachments: input.attachments ?? [],
        rfcMessageId: newRfcMessageId(),
        providerThreadId: input.threadId ?? null,
        inReplyToRfcId: input.inReplyToRfcId ?? null,
      })
      .returning(); // bare: a field selector breaks over the Db union
    return { ok: true, id: row!.id, sendAt: row!.sendAt, to: recipients.to, provider: sender.provider };
  } catch (err) {
    if (isUniqueViolation(err)) return refuse("duplicate");
    throw err;
  }
}

/** One unit of the `emailSend` burst bucket; a refusal when the bucket is empty. */
export async function chargeEmailBurst(userId: string): Promise<EnqueueResult | null> {
  try {
    await consumeBucket("emailSend", userId, RATE_LIMITS.emailSend);
    return null;
  } catch (err) {
    if (isRateLimitedError(err)) return refuse("rate_limited");
    throw err;
  }
}

/** Undo. Only a row nobody has claimed yet can be canceled. */
export async function cancelEmailSend(
  userId: string,
  id: string
): Promise<"canceled" | "already_sent" | "not_found"> {
  const db = await getDb();
  const canceled = await db
    .update(emailSends)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(and(eq(emailSends.id, id), eq(emailSends.userId, userId), eq(emailSends.status, "queued")))
    .returning();
  if (canceled.length) return "canceled";
  const existing = await db.query.emailSends.findFirst({
    where: and(eq(emailSends.id, id), eq(emailSends.userId, userId)),
    columns: { id: true },
  });
  return existing ? "already_sent" : "not_found";
}

export type DispatchOutcome = "sent" | "retry" | "failed" | "not_due" | "not_claimable";

/** Claim → (Sent check on retries) → send → settle. See the file header for the rules. */
export async function dispatchEmailSend(id: string, opts: { worker?: string } = {}): Promise<DispatchOutcome> {
  const db = await getDb();
  const worker = opts.worker ?? randomUUID();
  const claimed = rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE email_sends
         SET status = 'sending',
             claimed_by = ${worker}::uuid,
             lease_until = now() + (${EMAIL_LEASE_SECONDS}::double precision * interval '1 second'),
             attempts = attempts + 1,
             updated_at = now()
       WHERE id = ${id}::uuid
         AND send_at <= now()
         AND (status = 'queued' OR (status = 'sending' AND lease_until < now()))
      RETURNING id
    `)
  )[0];
  if (!claimed) {
    const probe = await db.query.emailSends.findFirst({
      where: eq(emailSends.id, id),
      columns: { status: true, sendAt: true },
    });
    if (probe?.status === "queued" && probe.sendAt.getTime() > Date.now()) return "not_due";
    return "not_claimable";
  }
  const send = (await db.query.emailSends.findFirst({ where: eq(emailSends.id, id) }))!;
  const provider = providerFor(send.provider);

  // A retry whose earlier attempt may have reached the provider: look in Sent first. A
  // definite earlier failure (transient) skips straight to sending when Sent can't be read.
  if (send.attempts > 1) {
    const prior = await provider
      .findSent(send.userId, { rfcMessageId: send.rfcMessageId, subject: send.subject, since: send.createdAt })
      .catch(() => "unknown" as const);
    if (prior && prior !== "unknown") return settleSent(send, worker, prior);
    if (prior === "unknown" && send.failureKind === "ambiguous") {
      return settleFailed(send, worker, "ambiguous", "May have sent — no read access to check Sent");
    }
  }

  let result: SendResult;
  try {
    // Inside the try: a Blob outage is transient, a vanished file permanent — same as a send.
    const files = send.attachments.length ? await loadAttachmentBytes(send.attachments) : undefined;
    result = await provider.send(
      send.userId,
      {
        from: { name: send.fromName, email: send.fromEmail },
        to: send.to,
        cc: send.cc,
        bcc: send.bcc,
        subject: send.subject,
        bodyText: send.bodyText,
        bodyHtml: send.bodyHtml,
        messageId: send.rfcMessageId,
        inReplyTo: send.inReplyToRfcId,
        references: send.inReplyToRfcId,
        attachments: files,
      },
      { threadId: send.providerThreadId, sendId: send.id }
    );
  } catch (err) {
    const kind = err instanceof MailProviderError ? err.kind : "ambiguous";
    const message = err instanceof Error ? err.message : String(err);
    if (kind === "auth" || kind === "permanent") return settleFailed(send, worker, kind, message);
    if (send.attempts >= MAX_EMAIL_ATTEMPTS) {
      return settleFailed(send, worker, kind === "ambiguous" ? "ambiguous" : "exhausted", message);
    }
    return settleRetry(send, worker, kind === "ambiguous", message);
  }
  return settleSent(send, worker, result);
}

async function settleSent(send: EmailSendRecord, worker: string, result: SendResult): Promise<DispatchOutcome> {
  const db = await getDb();
  const settled = await db
    .update(emailSends)
    .set({
      status: "sent",
      sentAt: new Date(),
      providerMessageId: result.providerMessageId,
      providerThreadId: result.providerThreadId ?? send.providerThreadId,
      claimedBy: null,
      leaseUntil: null,
      lastError: null,
      failureKind: null,
      updatedAt: new Date(),
    })
    .where(and(eq(emailSends.id, send.id), eq(emailSends.claimedBy, worker)))
    .returning();
  const done = settled[0];
  if (!done) return "not_claimable";
  const hooks = originHooks(done.origin);
  for (const contactId of done.contactIds) {
    // Logged at send time, never at enqueue: an undone send is not a touch.
    await logInteractionForUser(
      done.userId,
      {
        contactId,
        interactionType: "email",
        direction: "out",
        source: hooks.interactionSource,
        externalId: hooks.interactionExternalId(done, contactId),
        interactionDate: done.sentAt ?? new Date(),
        rawNotes: done.bodyText,
        aiSummary: `Emailed: ${done.subject}`,
      },
      { skipRevalidate: true }
    ).catch((err) => reportError(err, { where: "email.log-interaction", userId: done.userId, level: "warning" }));
  }
  await hooks
    .onSent?.(done)
    .catch((err) => reportError(err, { where: `email.on-sent.${done.origin}`, userId: done.userId }));
  return "sent";
}

async function settleFailed(
  send: EmailSendRecord,
  worker: string,
  kind: EmailFailureKind,
  message: string
): Promise<DispatchOutcome> {
  const db = await getDb();
  const settled = await db
    .update(emailSends)
    .set({
      status: "failed",
      failureKind: kind,
      lastError: message.slice(0, 500),
      claimedBy: null,
      leaseUntil: null,
      updatedAt: new Date(),
    })
    .where(and(eq(emailSends.id, send.id), eq(emailSends.claimedBy, worker)))
    .returning();
  const done = settled[0];
  if (!done) return "not_claimable";
  if (kind === "auth" && done.provider === "gmail") {
    // A refused token is flagged by `getValidAccessToken`; a 401/403 on the send itself isn't.
    await db
      .update(gmailConnections)
      .set({ status: "needs_reauth", nextSyncAt: null, updatedAt: new Date() })
      .where(eq(gmailConnections.userId, done.userId))
      .catch(() => null);
  }
  if (kind === "auth" && done.provider === "outlook") {
    await markOutlookNeedsReauth(done.userId).catch(() => null);
  }
  await originHooks(done.origin)
    .onFailed?.(done, kind, message)
    .catch((err) => reportError(err, { where: `email.on-failed.${done.origin}`, userId: done.userId }));
  return "failed";
}

async function settleRetry(
  send: EmailSendRecord,
  worker: string,
  ambiguous: boolean,
  message: string
): Promise<DispatchOutcome> {
  const db = await getDb();
  const settled = await db
    .update(emailSends)
    .set({
      status: "queued",
      sendAt: sql`now() + (${emailBackoffSeconds(send.attempts)}::double precision * interval '1 second')`,
      // Once ambiguous, always ambiguous until found in Sent: a later transient failure must
      // not launder it into a blind resend.
      failureKind: ambiguous || send.failureKind === "ambiguous" ? "ambiguous" : null,
      lastError: message.slice(0, 500),
      claimedBy: null,
      leaseUntil: null,
      updatedAt: new Date(),
    })
    .where(and(eq(emailSends.id, send.id), eq(emailSends.claimedBy, worker)))
    .returning();
  return settled.length ? "retry" : "not_claimable";
}

/**
 * The backstop. `after()` dispatches interactive sends; this catches everything it didn't —
 * a recycled function, a retry, a lapsed lease, and (P4) scheduled sends. Runs from the
 * ten-minute ops workflow. Rows go oldest-due first, one at a time, within the budget.
 */
export async function drainEmailSends(opts: { budgetMs: number; max: number }) {
  const db = await getDb();
  const deadline = Date.now() + opts.budgetMs;
  const stats = { attempted: 0, sent: 0, retried: 0, failed: 0, skipped: 0 };
  const due = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM email_sends
       WHERE send_at <= now()
         AND (status = 'queued' OR (status = 'sending' AND lease_until < now()))
       ORDER BY send_at
       LIMIT ${opts.max}
    `)
  );
  for (const { id } of due) {
    // One provider call is capped at 20s (60s for Gmail with files, plus a Blob read); stop while
    // there is room for a typical one — a slow item simply finishes in the next run.
    if (deadline - Date.now() < 30_000) break;
    stats.attempted++;
    const outcome = await dispatchEmailSend(id).catch((err) => {
      reportError(err, { where: "email.drain-item" });
      return "failed" as const;
    });
    if (outcome === "sent") stats.sent++;
    else if (outcome === "retry") stats.retried++;
    else if (outcome === "failed") stats.failed++;
    else stats.skipped++;
  }
  return stats;
}
