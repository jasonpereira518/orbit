import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactIdentities,
  contacts,
  emailSends,
  type EmailAttachmentRef,
  type EmailFailureKind,
  type EmailOrigin,
} from "@/db/schema";
import { DRAFT_MAX_CHARS, sanitizeDraft } from "@/lib/chat-draft";
import { SEND_SUBJECT_MAX } from "@/lib/chat-send";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { contactSearchCondition } from "@/lib/contact-search-rank";
import { verifyAttachmentRefs, type AttachmentFailure, type AttachmentInput } from "@/lib/email/attachments";
import { UNDO_DELAY_MS } from "@/lib/email/config";
import { ENQUEUE_COPY, enqueueEmail, type EnqueueRefusal } from "@/lib/email/outbox";
import { getSendCapability, resolveSender, type MailboxId, type SendCapability } from "@/lib/email/sender";
import { loadEmailSettings } from "@/lib/email/settings";
import { appendSignature } from "@/lib/email/signature";

/**
 * Compose, request-free: what the composer shows before anything is typed, who a recipient
 * might be, and queuing what was written. The `"use server"` wrappers in
 * `src/actions/email-compose.ts` add auth, the surface gate, and `scheduleDispatch`.
 */

export type ComposeRecipient = {
  email: string;
  contactId: string | null;
  name: string | null;
  avatarUrl: string | null;
};

export type ComposeContext = {
  capability: SendCapability;
  signature: string | null;
  contact: {
    id: string;
    name: string;
    firstName: string | null;
    avatarUrl: string | null;
    /** Primary email first, then identity emails; lowercased and deduped. */
    emails: string[];
  } | null;
};

/** Null for a contact that isn't this user's. */
export async function getComposeContext(userId: string, contactId: string | null): Promise<ComposeContext | null> {
  const db = await getDb();
  const [capability, { signature }] = await Promise.all([getSendCapability(userId), loadEmailSettings(userId)]);
  if (!contactId) return { capability, signature, contact: null };
  const [row] = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      preferredName: contacts.preferredName,
      firstName: contacts.firstName,
      email: contacts.email,
      avatarUrl: clientAvatarUrlSql.as("avatar_url"),
    })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
  if (!row) return null;
  const identities = await db
    .select({ value: contactIdentities.value })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.userId, userId),
        eq(contactIdentities.contactId, contactId),
        eq(contactIdentities.kind, "email")
      )
    );
  const emails: string[] = [];
  for (const e of [row.email, ...identities.map((i) => i.value)]) {
    const v = e?.trim().toLowerCase();
    if (v && !emails.includes(v)) emails.push(v);
  }
  return {
    capability,
    signature,
    contact: {
      id: row.id,
      name: row.preferredName || row.fullName,
      firstName: row.firstName,
      avatarUrl: row.avatarUrl,
      emails,
    },
  };
}

/** Recipient suggestions: one row per address — a contact's primary email and identity emails. */
export async function searchRecipients(userId: string, q: string, limit = 8): Promise<ComposeRecipient[]> {
  const term = q.trim();
  if (!term) return [];
  const db = await getDb();
  const like = `%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const matched = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      preferredName: contacts.preferredName,
      email: contacts.email,
      avatarUrl: clientAvatarUrlSql.as("avatar_url"),
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        or(contactSearchCondition(term), sql`lower(coalesce(${contacts.email}, '')) like ${like}`)
      )
    )
    .limit(limit);
  const ids = matched.map((m) => m.id);
  const identities = ids.length
    ? await db
        .select({ contactId: contactIdentities.contactId, value: contactIdentities.value })
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.userId, userId),
            eq(contactIdentities.kind, "email"),
            inArray(contactIdentities.contactId, ids)
          )
        )
    : [];
  const out: ComposeRecipient[] = [];
  const seen = new Set<string>();
  for (const m of matched) {
    const addresses = [m.email, ...identities.filter((i) => i.contactId === m.id).map((i) => i.value)];
    for (const a of addresses) {
      const email = a?.trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      out.push({ email, contactId: m.id, name: m.preferredName || m.fullName, avatarUrl: m.avatarUrl });
    }
  }
  return out.slice(0, limit);
}

export type ComposeInput = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  contactId: string | null;
  fromName: string | null;
  /** Send from this mailbox (the From picker). Omitted = the user's default. */
  provider?: MailboxId;
  /** Uploaded files (pathnames under the user's prefix), verified here before queueing. */
  attachments?: AttachmentInput[];
  /** ISO instant for a scheduled send; omitted = send after the undo window. */
  scheduledFor?: string;
};

export type ComposeResult =
  | { ok: true; sendId: string; sendAt: string; to: string[]; scheduled: boolean }
  | { ok: false; reason: EnqueueRefusal | "empty_body" | "too_long" | "not_retryable"; message: string };

const ATTACHMENT_REFUSAL: Record<AttachmentFailure["reason"], EnqueueRefusal> = {
  too_many: "too_many_files",
  too_large: "too_large",
  blocked_type: "blocked_type",
  not_found: "file_missing",
};

/** Queue a composed email: cleaned, signed, sent after the undo window. */
export async function sendComposed(userId: string, input: ComposeInput): Promise<ComposeResult> {
  const body = sanitizeDraft(input.body);
  if (!body) return { ok: false, reason: "empty_body", message: ENQUEUE_COPY.empty_body };
  if (Array.from(body).length > DRAFT_MAX_CHARS) {
    return { ok: false, reason: "too_long", message: "That message is too long to send" };
  }
  const subject = (sanitizeDraft(input.subject) ?? "").replace(/\s+/g, " ").trim();
  if (Array.from(subject).length > SEND_SUBJECT_MAX) {
    return { ok: false, reason: "too_long", message: "That subject is too long" };
  }
  let sendAt: Date | undefined;
  if (input.scheduledFor) {
    sendAt = new Date(input.scheduledFor);
    if (Number.isNaN(sendAt.getTime())) return { ok: false, reason: "bad_schedule", message: ENQUEUE_COPY.bad_schedule };
  }
  // Files are checked against the mailbox this send will actually use (Outlook takes ~3 MB).
  let refs: EmailAttachmentRef[] = [];
  if (input.attachments?.length) {
    const sender = await resolveSender(userId, input.provider ?? null);
    if (!sender.ok) return { ok: false, reason: sender.reason, message: ENQUEUE_COPY[sender.reason] };
    const verified = await verifyAttachmentRefs(userId, input.attachments, sender.provider);
    if (!verified.ok) return { ok: false, reason: ATTACHMENT_REFUSAL[verified.reason], message: verified.message };
    refs = verified.refs;
  }
  const { signature } = await loadEmailSettings(userId);
  const queued = await enqueueEmail(userId, {
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject,
    bodyText: appendSignature(body, signature),
    fromName: input.fromName,
    origin: "compose",
    originRef: input.contactId,
    provider: input.provider,
    delayMs: UNDO_DELAY_MS,
    sendAt,
    attachments: refs,
  });
  if (!queued.ok) return queued;
  return { ok: true, sendId: queued.id, sendAt: queued.sendAt.toISOString(), to: queued.to, scheduled: Boolean(sendAt) };
}

export type PendingSend = {
  id: string;
  status: "queued" | "sending" | "failed";
  subject: string;
  to: string[];
  sendAt: string;
  failureKind: EmailFailureKind | null;
  origin: EmailOrigin;
  bodyText: string;
  /** Set when this is a scheduled send (P4), not one waiting out its undo window. */
  scheduledFor: string | null;
  attachments: { filename: string; size: number; pathname: string }[];
};

/** Failed sends these surfaces can resend; agent and recruiter failures are handled on their own screens. */
const RETRYABLE_ORIGINS: ReadonlySet<EmailOrigin> = new Set(["compose", "follow_up", "chat"]);

/**
 * What's waiting or went wrong for this contact — the outbox rows the timeline doesn't show:
 * queued and in-flight sends, and failures from the last 7 days that nobody dismissed.
 */
export async function listContactPendingSends(userId: string, contactId: string): Promise<PendingSend[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(emailSends)
    .where(
      and(
        eq(emailSends.userId, userId),
        sql`${emailSends.contactIds} @> ${JSON.stringify([contactId])}::jsonb`,
        or(
          inArray(emailSends.status, ["queued", "sending"]),
          and(
            eq(emailSends.status, "failed"),
            isNull(emailSends.dismissedAt),
            gte(emailSends.updatedAt, sql`now() - interval '7 days'`)
          )
        )
      )
    )
    .orderBy(desc(emailSends.createdAt))
    .limit(10);
  return rows.map((r) => ({
    id: r.id,
    status: r.status as PendingSend["status"],
    subject: r.subject,
    to: r.to,
    sendAt: r.sendAt.toISOString(),
    failureKind: r.failureKind,
    origin: r.origin,
    bodyText: r.bodyText,
    scheduledFor:
      r.status === "queued" && r.sendAt.getTime() > r.createdAt.getTime() + UNDO_DELAY_MS + 5_000
        ? r.sendAt.toISOString()
        : null,
    attachments: r.attachments.map((a) => ({ filename: a.filename, size: a.size, pathname: a.blobKey })),
  }));
}

/**
 * Send a definitely-failed email again, as a fresh row with its own undo window. The old row
 * is dismissed. Its idempotency key is reusable: a failed, non-ambiguous row no longer holds it.
 */
export async function retryFailedSend(userId: string, sendId: string, fromName: string | null): Promise<ComposeResult> {
  const db = await getDb();
  const old = await db.query.emailSends.findFirst({
    where: and(eq(emailSends.id, sendId), eq(emailSends.userId, userId)),
  });
  if (!old || old.status !== "failed" || old.dismissedAt) {
    return { ok: false, reason: "not_retryable", message: "That email isn’t waiting to be retried" };
  }
  if (old.failureKind === "ambiguous") {
    return { ok: false, reason: "not_retryable", message: "That may have sent — check your Sent folder first" };
  }
  if (!RETRYABLE_ORIGINS.has(old.origin)) {
    return { ok: false, reason: "not_retryable", message: "Retry that from where you sent it" };
  }
  const queued = await enqueueEmail(userId, {
    to: old.to,
    cc: old.cc,
    bcc: old.bcc,
    subject: old.subject,
    bodyText: old.bodyText,
    fromName: fromName ?? old.fromName,
    origin: old.origin,
    originRef: old.originRef,
    idempotencyKey: old.idempotencyKey,
    contactIds: old.contactIds,
    threadId: old.providerThreadId,
    attachments: old.attachments,
    delayMs: UNDO_DELAY_MS,
  });
  if (!queued.ok) return queued;
  await db.update(emailSends).set({ dismissedAt: new Date() }).where(eq(emailSends.id, old.id));
  return { ok: true, sendId: queued.id, sendAt: queued.sendAt.toISOString(), to: queued.to, scheduled: false };
}

/** Hide a failed send from the contact page and the account alert. Only its owner can. */
export async function dismissFailedSend(userId: string, sendId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(emailSends)
    .set({ dismissedAt: new Date() })
    .where(and(eq(emailSends.id, sendId), eq(emailSends.userId, userId), eq(emailSends.status, "failed")))
    .returning();
  return rows.length > 0;
}
