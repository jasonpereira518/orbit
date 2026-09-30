import { and, desc, eq, like, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { emailSends, interactions } from "@/db/schema";
import { stripReply } from "@/lib/email/reply-subject";

export { replySubject, stripReply } from "@/lib/email/reply-subject";

/**
 * Which conversation a Compose send replies into (direct-email P5). The composer lists
 * targets; the send carries only the key, and the server re-reads it here by owner — the
 * client never supplies a Message-ID, subject or thread id.
 *
 *   orbit:<sendId>          a thread Orbit sent (email_sends, status sent)
 *   logged:<interactionId>  a message the user BCC-logged (external_id mail:<Message-ID>:<contactId>)
 *   inbox:<provider>:<id>   the latest mailbox message (dark: feature.reply-inbox)
 *   copy:<sendId>           a queued/failed row's own reply fields (Edit, Retry)
 */
export type ReplySource = "orbit" | "logged" | "inbox";
export type ReplyTarget = {
  key: string;
  source: ReplySource;
  /** The original subject, without any Re: prefix. */
  subject: string;
  /** ISO time of the message replied to. */
  at: string;
};
export type ResolvedReply = {
  /** With angle brackets. */
  rfcMessageId: string;
  subject: string;
  inReplyToSendId: string | null;
  /** Where a provider thread id is valid: only a send from this exact mailbox may use it. */
  thread: { provider: "gmail" | "outlook"; email: string; threadId: string } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bracket(id: string) {
  return `<${id.trim().replace(/^<|>$/g, "")}>`;
}

/** `mail:<Message-ID>:<contactId>` → the Message-ID (which may itself contain colons). */
function messageIdFromExternal(externalId: string, contactId: string): string | null {
  const suffix = `:${contactId}`;
  if (!externalId.startsWith("mail:") || !externalId.endsWith(suffix)) return null;
  const id = externalId.slice("mail:".length, -suffix.length);
  return id ? bracket(id) : null;
}

async function latestOrbitSend(userId: string, contactId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ id: emailSends.id, subject: emailSends.subject, sentAt: emailSends.sentAt })
    .from(emailSends)
    .where(
      and(
        eq(emailSends.userId, userId),
        eq(emailSends.status, "sent"),
        sql`${emailSends.contactIds} @> ${JSON.stringify([contactId])}::jsonb`
      )
    )
    .orderBy(desc(emailSends.sentAt))
    .limit(1);
  return row ?? null;
}

async function latestLogged(userId: string, contactId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ id: interactions.id, subject: interactions.aiSummary, at: interactions.interactionDate })
    .from(interactions)
    .where(
      and(
        eq(interactions.userId, userId),
        eq(interactions.contactId, contactId),
        eq(interactions.interactionType, "email"),
        like(interactions.externalId, "mail:%")
      )
    )
    .orderBy(desc(interactions.interactionDate))
    .limit(1);
  return row ?? null;
}

/** Newest first, at most one per source. */
export async function listReplyTargets(userId: string, contactId: string): Promise<ReplyTarget[]> {
  const [sent, logged] = await Promise.all([latestOrbitSend(userId, contactId), latestLogged(userId, contactId)]);
  const out: ReplyTarget[] = [];
  if (sent?.sentAt) {
    out.push({ key: `orbit:${sent.id}`, source: "orbit", subject: stripReply(sent.subject), at: sent.sentAt.toISOString() });
  }
  if (logged) {
    out.push({ key: `logged:${logged.id}`, source: "logged", subject: stripReply(logged.subject ?? ""), at: logged.at.toISOString() });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export async function resolveReplyTarget(userId: string, key: string): Promise<ResolvedReply | null> {
  const [kind, ...rest] = String(key ?? "").split(":");
  const id = rest.join(":");
  const db = await getDb();
  if (kind === "orbit" && UUID.test(id)) {
    const row = await db.query.emailSends.findFirst({
      where: and(eq(emailSends.id, id), eq(emailSends.userId, userId), eq(emailSends.status, "sent")),
    });
    if (!row) return null;
    const threadId = row.providerThreadId;
    return {
      rfcMessageId: row.rfcMessageId,
      subject: stripReply(row.subject),
      inReplyToSendId: row.id,
      thread:
        threadId && (row.provider === "gmail" || row.provider === "outlook")
          ? { provider: row.provider, email: row.fromEmail, threadId }
          : null,
    };
  }
  if (kind === "logged" && UUID.test(id)) {
    const row = await db.query.interactions.findFirst({
      where: and(eq(interactions.id, id), eq(interactions.userId, userId), eq(interactions.interactionType, "email")),
    });
    const rfc = row?.externalId ? messageIdFromExternal(row.externalId, row.contactId) : null;
    if (!row || !rfc) return null;
    return { rfcMessageId: rfc, subject: stripReply(row.aiSummary ?? ""), inReplyToSendId: null, thread: null };
  }
  if (kind === "copy" && UUID.test(id)) {
    const row = await db.query.emailSends.findFirst({ where: and(eq(emailSends.id, id), eq(emailSends.userId, userId)) });
    if (!row?.inReplyToRfcId) return null;
    return {
      rfcMessageId: row.inReplyToRfcId,
      subject: stripReply(row.subject),
      inReplyToSendId: row.inReplyToSendId,
      thread:
        row.providerThreadId && row.provider === "gmail"
          ? { provider: "gmail", email: row.fromEmail, threadId: row.providerThreadId }
          : null,
    };
  }
  return null;
}
