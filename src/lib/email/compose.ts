import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contactIdentities, contacts } from "@/db/schema";
import { DRAFT_MAX_CHARS, sanitizeDraft } from "@/lib/chat-draft";
import { SEND_SUBJECT_MAX } from "@/lib/chat-send";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { contactSearchCondition } from "@/lib/contact-search-rank";
import { UNDO_DELAY_MS } from "@/lib/email/config";
import { ENQUEUE_COPY, enqueueEmail, type EnqueueRefusal } from "@/lib/email/outbox";
import { getSendCapability, type SendCapability } from "@/lib/email/sender";
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
};

export type ComposeResult =
  | { ok: true; sendId: string; sendAt: string; to: string[] }
  | { ok: false; reason: EnqueueRefusal | "empty_body" | "too_long" | "not_retryable"; message: string };

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
    delayMs: UNDO_DELAY_MS,
  });
  if (!queued.ok) return queued;
  return { ok: true, sendId: queued.id, sendAt: queued.sendAt.toISOString(), to: queued.to };
}
