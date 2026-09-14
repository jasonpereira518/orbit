import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, runAtomicWrite } from "@/db";
import {
  outreachConversations,
  outreachConversationMessages,
  outreachProspects,
  outreachMessages,
  outreachCampaigns,
  interactions,
} from "@/db/schema";
import { resolveOrCreateContact } from "@/lib/contact-resolve";
import { fullBody } from "./policy";
import { campaignFor, messageFor } from "./store";
import { stableUuid, validateSender } from "./service";
import { gmail, graph } from "./mail";
import type { MailCursor } from "./types";

export async function ensureConversation(
  userId: string,
  campaignId: string,
  prospectId: string,
  threadId?: string | null,
  url?: string | null,
) {
  await campaignFor(userId, campaignId);
  const db = await getDb();
  const p = await db.query.outreachProspects.findFirst({
    where: and(
      eq(outreachProspects.id, prospectId),
      eq(outreachProspects.campaignId, campaignId),
    ),
  });
  if (!p) throw new Error("Person not found.");
  const [c] = await db
    .insert(outreachConversations)
    .values({ userId, campaignId, prospectId, providerThreadId: threadId, url })
    .onConflictDoUpdate({
      target: outreachConversations.prospectId,
      set: {
        ...(threadId ? { providerThreadId: threadId } : {}),
        ...(url ? { url } : {}),
        nextSyncAt: new Date(),
      },
    })
    .returning();
  return c;
}
export type Incoming = {
  externalId: string;
  direction: "inbound" | "outbound";
  kind: "human" | "automatic" | "bounce" | "accepted";
  subject?: string;
  body: string;
  sentAt: Date;
  internetMessageId?: string;
};
export async function ingestMessage(
  userId: string,
  conversationId: string,
  entry: Incoming,
) {
  const db = await getDb();
  const c = await db.query.outreachConversations.findFirst({
    where: and(
      eq(outreachConversations.id, conversationId),
      eq(outreachConversations.userId, userId),
    ),
  });
  if (!c) throw new Error("Conversation not found.");
  if (
    entry.direction === "outbound" &&
    !entry.externalId.startsWith("browser:")
  ) {
    const placeholders = await db.query.outreachConversationMessages.findMany({
      where: and(
        eq(outreachConversationMessages.conversationId, c.id),
        eq(outreachConversationMessages.direction, "outbound"),
        eq(outreachConversationMessages.body, entry.body),
        sql`${outreachConversationMessages.externalId} LIKE 'browser:%'`,
        sql`abs(extract(epoch FROM (${outreachConversationMessages.sentAt}-${entry.sentAt}::timestamptz)))<300`,
      ),
    });
    if (placeholders.length === 1) {
      await db
        .update(outreachConversationMessages)
        .set({ externalId: entry.externalId, sentAt: entry.sentAt })
        .where(eq(outreachConversationMessages.id, placeholders[0].id));
      return false;
    }
  }
  const inbound = entry.direction === "inbound";
  const human = inbound && entry.kind === "human";
  const accepted = inbound && entry.kind === "accepted";
  const bounce = inbound && entry.kind === "bounce";
  const optedOut =
    human &&
    /\b(stop contacting|remove me|do not contact|don't contact|unsubscribe)\b/i.test(
      entry.body,
    );
  const positive =
    human &&
    /\b(happy to|let'?s (?:chat|connect|meet)|sounds good|available (?:on|next)|glad to)\b/i.test(
      entry.body,
    );
  const outcome = optedOut
    ? "unsubscribed"
    : bounce
      ? "bounced"
      : positive
        ? "positive_reply"
        : "neutral_reply";
  // Update state and append the deduplicated event in one transaction. Replayed
  // events never restore unread state or undo the user's outcome classification.
  const unseen = sql`NOT EXISTS (SELECT 1 FROM outreach_conversation_messages WHERE conversation_id=${c.id} AND external_id=${entry.externalId})`;
  const eventId = randomUUID();
  await runAtomicWrite(db, (w) => [
    ...(inbound
      ? [
          w
            .update(outreachConversations)
            .set({
              ...(human
                ? {
                    unread: true,
                    lastHumanReplyAt: sql`GREATEST(last_human_reply_at,${entry.sentAt}::timestamptz)`,
                  }
                : {}),
              ...(accepted
                ? {
                    acceptedAt: sql`COALESCE(accepted_at,${entry.sentAt}::timestamptz)`,
                  }
                : {}),
              ...(human || bounce
                ? {
                    outcome: sql`CASE WHEN opted_out THEN outcome WHEN last_human_reply_at IS NULL OR last_human_reply_at<=${entry.sentAt}::timestamptz THEN ${outcome} ELSE outcome END`,
                  }
                : {}),
              ...(optedOut
                ? { optedOut: true, closed: true }
                : bounce
                  ? { closed: true }
                  : {}),
              // An automatic message is recorded without clearing an unread human reply.
              nextSyncAt: new Date(Date.now() + 300000),
            })
            .where(and(eq(outreachConversations.id, c.id), unseen)),
        ]
      : []),
    ...(human || bounce
      ? [
          w
            .update(outreachMessages)
            .set({ outcome, ...(human ? { repliedAt: entry.sentAt } : {}) })
            .where(
              and(
                eq(outreachMessages.prospectId, c.prospectId),
                eq(outreachMessages.executionStatus, "confirmed"),
                unseen,
              ),
            ),
        ]
      : []),
    w
      .insert(outreachConversationMessages)
      .values({ id: eventId, conversationId, ...entry })
      .onConflictDoNothing(),
  ]);
  if (human || accepted) await promoteContact(userId, c.prospectId);
  await attachHistory(userId, c.id);
  return Boolean(
    await db.query.outreachConversationMessages.findFirst({
      where: eq(outreachConversationMessages.id, eventId),
      columns: { id: true },
    }),
  );
}
export async function promoteContact(userId: string, prospectId: string) {
  const db = await getDb();
  const p = await db.query.outreachProspects.findFirst({
    where: eq(outreachProspects.id, prospectId),
  });
  if (!p) throw new Error("Person not found.");
  await campaignFor(userId, p.campaignId);
  if (p.research?.ambiguous) return; // Human resolves ambiguous identities before promotion.
  let contactId = p.contactId;
  if (!contactId) {
    // Identifiers only: do not auto-merge a name/company lookalike.
    const resolved = await resolveOrCreateContact(
      userId,
      {
        fullName: p.fullName,
        email: p.email ?? undefined,
        linkedinUrl: p.linkedinUrl ?? undefined,
        source: "outreach",
      },
      {
        skipRevalidate: true,
        skipEmbedding: true,
        skipSummary: true,
        skipCloseness: true,
        source: "outreach",
      },
    );
    contactId = resolved.contactId;
    await db
      .update(outreachProspects)
      .set({ contactId })
      .where(eq(outreachProspects.id, p.id));
  }
  const c = await db.query.outreachConversations.findFirst({
    where: eq(outreachConversations.prospectId, p.id),
  });
  if (c) await attachHistory(userId, c.id);
  return contactId;
}
async function attachHistory(userId: string, conversationId: string) {
  const db = await getDb();
  const c = await db.query.outreachConversations.findFirst({
    where: and(
      eq(outreachConversations.id, conversationId),
      eq(outreachConversations.userId, userId),
    ),
  });
  if (!c) return;
  const p = await db.query.outreachProspects.findFirst({
    where: eq(outreachProspects.id, c.prospectId),
  });
  if (!p?.contactId) return;
  const messages = await db.query.outreachConversationMessages.findMany({
    where: and(
      eq(outreachConversationMessages.conversationId, c.id),
      sql`${outreachConversationMessages.interactionId} IS NULL`,
    ),
  });
  for (const m of messages) {
    const id = stableUuid(`outreach-interaction:${m.id}`);
    await runAtomicWrite(db, (w) => [
      w
        .insert(interactions)
        .values({
          id,
          userId,
          contactId: p.contactId!,
          interactionType: "email",
          direction: m.direction === "inbound" ? "in" : "out",
          rawNotes: m.body,
          interactionDate: m.sentAt,
        })
        .onConflictDoNothing(),
      w
        .update(outreachConversationMessages)
        .set({ interactionId: id })
        .where(eq(outreachConversationMessages.id, m.id)),
    ]);
  }
}
export async function recordSent(
  userId: string,
  messageId: string,
  result: {
    externalId: string;
    threadId: string | null;
    status: string;
    url: string | null;
  },
) {
  const {
    message: m,
    prospect: p,
    campaign: c,
  } = await messageFor(userId, messageId);
  const db = await getDb();
  await db
    .update(outreachMessages)
    .set({
      executionStatus: result.status,
      status: result.status === "confirmed" ? "sent" : "generated",
      deliveryId: result.externalId,
      providerThreadId: result.threadId,
      sentAt: result.status === "confirmed" ? (m.sentAt ?? new Date()) : null,
    })
    .where(eq(outreachMessages.id, m.id));
  const conv = await ensureConversation(
    userId,
    c.id,
    p.id,
    result.threadId,
    result.url,
  );
  if (result.status === "confirmed") {
    await db
      .update(outreachProspects)
      .set({ status: "contacted" })
      .where(eq(outreachProspects.id, p.id));
    await ingestMessage(userId, conv.id, {
      externalId: result.externalId,
      direction: "outbound",
      kind: "human",
      subject: m.subject ?? undefined,
      body: fullBody(m.body, m.signature, m.channel),
      sentAt: m.sentAt ?? new Date(),
      internetMessageId:
        m.senderSnapshot?.transport === "gmail"
          ? `<orbit-${m.id}-${m.revision}@outreach.orbit>`
          : undefined,
    });
  }
}
type GmailMessage = {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: string[];
  payload: {
    headers?: Array<{ name: string; value: string }>;
    mimeType?: string;
    body?: { data?: string };
    parts?: GmailMessage["payload"][];
  };
};
function decodeBody(p: GmailMessage["payload"]): string {
  if (p.mimeType === "text/plain" && p.body?.data)
    return Buffer.from(p.body.data, "base64url").toString("utf8");
  const parts = p.parts?.map(decodeBody).filter(Boolean);
  if (parts?.length) return parts.join("\n");
  return p.body?.data
    ? Buffer.from(p.body.data, "base64url")
        .toString("utf8")
        .replace(/<[^>]*>/g, " ")
    : "";
}
export function classifyMail(
  headers: Record<string, string>,
  _body: string,
): Incoming["kind"] {
  if (
    headers["content-type"]?.includes("delivery-status") ||
    /mailer-daemon|postmaster/i.test(headers.from ?? "") ||
    /^delivery (?:status notification|failure)/i.test(headers.subject ?? "")
  )
    return "bounce";
  if (
    (headers["auto-submitted"] && headers["auto-submitted"] !== "no") ||
    headers["x-autoreply"] ||
    /^(?:automatic reply|out of office):/i.test(headers.subject ?? "")
  )
    return "automatic";
  return "human";
}
async function syncGmail(
  c: typeof outreachConversations.$inferSelect,
  sender: string,
) {
  let cursor = c.cursor ?? {};
  let changed = !cursor.historyId;
  if (cursor.historyId) {
    try {
      const delta = (await gmail(
        c.userId,
        `/history?startHistoryId=${encodeURIComponent(cursor.historyId)}&maxResults=100${cursor.nextPage ? `&pageToken=${encodeURIComponent(cursor.nextPage)}` : ""}`,
      )) as {
        historyId: string;
        nextPageToken?: string;
        history?: Array<{ messages?: Array<{ threadId: string }> }>;
      };
      changed = Boolean(
        delta.history?.some((h) =>
          h.messages?.some((m) => m.threadId === c.providerThreadId),
        ),
      );
      cursor = delta.nextPageToken
        ? { ...cursor, nextPage: delta.nextPageToken }
        : { historyId: delta.historyId };
    } catch (e) {
      if (e instanceof Error && e.message.includes("404")) {
        cursor = {};
        changed = true;
      } else throw e;
    }
  }
  if (changed) {
    const thread = (await gmail(
      c.userId,
      `/threads/${encodeURIComponent(c.providerThreadId!)}?format=full`,
    )) as { historyId: string; messages?: GmailMessage[] };
    for (const m of thread.messages ?? []) {
      const headers = Object.fromEntries(
        (m.payload.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
      );
      const from = headers.from
        ?.match(/[^\s<>";,]+@[^\s<>";,]+/)?.[0]
        ?.toLowerCase();
      const direction = from === sender.toLowerCase() ? "outbound" : "inbound";
      await ingestMessage(c.userId, c.id, {
        externalId: m.id,
        direction,
        kind: classifyMail(headers, decodeBody(m.payload)),
        subject: headers.subject,
        body: decodeBody(m.payload),
        sentAt: new Date(Number(m.internalDate)),
        internetMessageId: headers["message-id"],
      });
    }
    if (!cursor.historyId) cursor = { historyId: thread.historyId };
  }
  return cursor;
}
type GraphMessage = {
  id: string;
  conversationId: string;
  subject: string;
  body?: { content: string; contentType: string };
  from?: { emailAddress: { address: string } };
  sentDateTime: string;
  internetMessageId: string;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  isDraft?: boolean;
};
async function syncOutlook(
  c: typeof outreachConversations.$inferSelect,
  sender: string,
): Promise<MailCursor> {
  const cursor = { ...c.cursor };
  for (const folder of ["inbox", "sentitems"] as const) {
    const field = folder === "inbox" ? "deltaLink" : "sentDeltaLink",
      pageField = folder === "inbox" ? "pageLink" : "sentPageLink";
    const initial = `/mailFolders/${folder}/messages/delta?$select=id,conversationId,subject,body,from,sentDateTime,internetMessageId,internetMessageHeaders,isDraft&$top=50`;
    let data: {
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };
    try {
      data = await (
        await graph(c.userId, cursor[pageField] ?? cursor[field] ?? initial)
      ).json();
    } catch (e) {
      if (e instanceof Error && /\((410|404)\)/.test(e.message))
        data = await (await graph(c.userId, initial)).json();
      else throw e;
    }
    for (const m of data.value ?? []) {
      if (m.conversationId !== c.providerThreadId || m.isDraft || !m.body)
        continue;
      const headers = Object.fromEntries(
        (m.internetMessageHeaders ?? []).map((h) => [
          h.name.toLowerCase(),
          h.value,
        ]),
      );
      headers.subject = m.subject;
      headers.from = m.from?.emailAddress.address ?? "";
      const body =
        m.body.contentType.toLowerCase() === "html"
          ? m.body.content.replace(/<[^>]*>/g, " ")
          : m.body.content;
      await ingestMessage(c.userId, c.id, {
        externalId: m.id,
        direction:
          headers.from.toLowerCase() === sender.toLowerCase()
            ? "outbound"
            : "inbound",
        kind: classifyMail(headers, body),
        subject: m.subject,
        body,
        sentAt: new Date(m.sentDateTime),
        internetMessageId: m.internetMessageId,
      });
    }
    cursor[pageField] = data["@odata.nextLink"];
    if (data["@odata.deltaLink"]) cursor[field] = data["@odata.deltaLink"];
  }
  return cursor;
}
export async function syncConversation(userId: string, id: string) {
  const db = await getDb();
  const [c] = await db
    .update(outreachConversations)
    .set({ leaseUntil: new Date(Date.now() + 90000) })
    .where(
      and(
        eq(outreachConversations.id, id),
        eq(outreachConversations.userId, userId),
        sql`(${outreachConversations.leaseUntil} IS NULL OR ${outreachConversations.leaseUntil}<now())`,
      ),
    )
    .returning();
  if (!c) return;
  const campaign = await campaignFor(userId, c.campaignId);
  const sender = campaign.sender;
  try {
    if (
      !sender ||
      !c.providerThreadId ||
      !["gmail", "outlook"].includes(sender.transport)
    )
      return;
    await validateSender(userId, sender, campaign.defaultChannel ?? "email");
    const cursor =
      sender.transport === "gmail"
        ? await syncGmail(c, sender.address)
        : await syncOutlook(c, sender.address);
    const accepted = await db.query.outreachMessages.findMany({
      where: and(
        eq(outreachMessages.prospectId, c.prospectId),
        eq(outreachMessages.executionStatus, "accepted"),
      ),
    });
    for (const m of accepted)
      if (m.deliveryId && sender.transport === "outlook") {
        const sent = await (
          await graph(
            userId,
            `/messages/${encodeURIComponent(m.deliveryId)}?$select=id,isDraft,conversationId,webLink`,
          )
        ).json();
        if (sent.isDraft === false)
          await recordSent(userId, m.id, {
            externalId: sent.id,
            threadId: sent.conversationId,
            status: "confirmed",
            url: sent.webLink,
          });
      }
    await db
      .update(outreachConversations)
      .set({
        cursor,
        lastCheckedAt: new Date(),
        error: null,
        nextSyncAt: new Date(Date.now() + 300000),
      })
      .where(eq(outreachConversations.id, id));
  } catch (e) {
    await db
      .update(outreachConversations)
      .set({
        error: e instanceof Error ? e.message : "Sync failed",
        nextSyncAt: new Date(Date.now() + 300000),
      })
      .where(eq(outreachConversations.id, id));
  } finally {
    await db
      .update(outreachConversations)
      .set({ leaseUntil: null })
      .where(eq(outreachConversations.id, id));
  }
}
export async function syncDue(limit = 100, deadline = Date.now() + 90000) {
  const db = await getDb();
  const due = await db
    .select({
      id: outreachConversations.id,
      userId: outreachConversations.userId,
    })
    .from(outreachConversations)
    .innerJoin(
      outreachCampaigns,
      eq(outreachCampaigns.id, outreachConversations.campaignId),
    )
    .where(
      sql`${outreachConversations.nextSyncAt}<=now() AND ${outreachCampaigns.sender}->>'transport' IN ('gmail','outlook')`,
    )
    .orderBy(outreachConversations.nextSyncAt)
    .limit(limit);
  let checked = 0;
  for (let i = 0; i < due.length && Date.now() < deadline - 30000; i += 4) {
    await Promise.all(
      due.slice(i, i + 4).map((c) => syncConversation(c.userId, c.id)),
    );
    checked += Math.min(4, due.length - i);
  }
  return checked;
}
