import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  outreachJobs,
  outreachMessages,
  outreachSendDays,
  outreachConversations,
  outreachConversationMessages,
} from "@/db/schema";
import { getValidAccessToken as googleToken } from "@/lib/gmail";
import { getValidAccessToken as microsoftToken } from "@/lib/outlook";
import { sendGmailMessage } from "@/lib/gmail-send";
import { messageFor } from "./store";
import { fullBody } from "./policy";
import { validateSender } from "./service";

export async function graph(
  userId: string,
  path: string,
  init: RequestInit = {},
) {
  const url = path.startsWith("https://")
    ? path
    : `https://graph.microsoft.com/v1.0/me${path}`;
  if (new URL(url).origin !== "https://graph.microsoft.com")
    throw new Error("Invalid Microsoft sync URL.");
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${await microsoftToken(userId)}`,
      "Content-Type": "application/json",
      Prefer: 'IdType="ImmutableId"',
      ...init.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok)
    throw new Error(
      `Outlook request failed (${res.status}).${res.status === 401 || res.status === 403 ? " Reconnect Outlook with mail permissions." : ""}`,
    );
  return res;
}
export async function gmail(userId: string, path: string) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me${path}`,
    {
      headers: { Authorization: `Bearer ${await googleToken(userId)}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) throw new Error(`Gmail request failed (${res.status}).`);
  return res.json();
}
export async function reserveSendDay(userId: string) {
  const db = await getDb();
  const day = new Date().toISOString().slice(0, 10);
  // Include legacy sends when initializing today's counter; subsequent v2 reservations
  // include pending attempts as well as completed sends.
  await db.execute(sql`INSERT INTO outreach_send_days(user_id,day,used)
    SELECT ${userId},${day},count(*)::int FROM outreach_messages m JOIN outreach_prospects p ON p.id=m.prospect_id JOIN outreach_campaigns c ON c.id=p.campaign_id
    WHERE c.user_id=${userId} AND c.version=1 AND m.channel='email' AND m.sent_at>=${day}::date
    ON CONFLICT(user_id,day) DO NOTHING`);
  const [row] = await db
    .update(outreachSendDays)
    .set({ used: sql`${outreachSendDays.used}+1` })
    .where(
      and(
        eq(outreachSendDays.userId, userId),
        eq(outreachSendDays.day, day),
        sql`${outreachSendDays.used}<50`,
      ),
    )
    .returning();
  return Boolean(row);
}
export class DailyLimitError extends Error {}
export async function sendConnected(job: typeof outreachJobs.$inferSelect) {
  const {
    message: m,
    campaign: c,
    prospect: p,
  } = await messageFor(job.userId, job.payload.messageId!);
  if (c.paused) throw new Error("Campaign paused.");
  if (
    !m.senderSnapshot ||
    m.approvedRevision !== m.revision ||
    m.executionStatus !== "queued"
  )
    throw new Error("The exact draft is no longer approved for sending.");
  await validateSender(job.userId, m.senderSnapshot, m.channel);
  const db = await getDb();
  const conversation = await db.query.outreachConversations.findFirst({
    where: eq(outreachConversations.prospectId, p.id),
  });
  if (
    conversation?.optedOut ||
    (m.messageKind === "follow_up" &&
      (conversation?.lastHumanReplyAt || conversation?.closed))
  )
    throw new Error("Follow-up cancelled because the conversation changed.");
  if (m.messageKind !== "initial" && !conversation?.providerThreadId)
    throw new Error(
      "The original provider conversation is unavailable. Verify its thread before replying.",
    );
  if (!(await reserveSendDay(job.userId)))
    throw new DailyLimitError(
      "Daily email limit reached; queued for tomorrow.",
    );
  const body = fullBody(m.body, m.signature, m.channel);
  const [claimedMessage] = await db
    .update(outreachMessages)
    .set({ executionStatus: "sending" })
    .where(
      and(
        eq(outreachMessages.id, m.id),
        eq(outreachMessages.executionStatus, "queued"),
        sql`EXISTS (SELECT 1 FROM outreach_jobs WHERE id=${job.id} AND lease_token=${job.leaseToken} AND status='running' AND lease_until>now())`,
      ),
    )
    .returning();
  if (!claimedMessage)
    throw new Error(
      "Execution lease expired or another worker already started this message.",
    );
  const verifyLease = async () => {
    const current = await db.query.outreachJobs.findFirst({
      where: and(
        eq(outreachJobs.id, job.id),
        eq(outreachJobs.leaseToken, job.leaseToken!),
        eq(outreachJobs.status, "running"),
        sql`${outreachJobs.leaseUntil}>now()`,
      ),
    });
    if (!current)
      throw new Error(
        "Execution lease expired before sending; verify the provider state.",
      );
    const campaign = await (
      await import("./store")
    ).campaignFor(job.userId, c.id);
    if (campaign.paused)
      throw new Error(
        "Campaign paused before sending; verify the provider state.",
      );
    await db
      .update(outreachJobs)
      .set({ result: { ...current.result, phase: "clicked" } })
      .where(
        and(
          eq(outreachJobs.id, job.id),
          eq(outreachJobs.leaseToken, job.leaseToken!),
          eq(outreachJobs.status, "running"),
        ),
      );
  };
  const outboundId = `<orbit-${m.id}-${m.revision}@outreach.orbit>`;
  await db
    .update(outreachJobs)
    .set({ result: { phase: "prepared", outboundId } })
    .where(
      and(
        eq(outreachJobs.id, job.id),
        eq(outreachJobs.leaseToken, job.leaseToken!),
      ),
    );
  if (m.senderSnapshot.transport === "gmail") {
    const ref = conversation
      ? await db.query.outreachConversationMessages.findFirst({
          where: and(
            eq(outreachConversationMessages.conversationId, conversation.id),
          ),
          orderBy: sql`sent_at DESC`,
        })
      : null;
    await verifyLease();
    const sent = await sendGmailMessage(job.userId, {
      to: m.toAddress!,
      subject: m.subject!,
      body,
      from: { name: null, email: m.senderSnapshot.address },
      threadId: conversation?.providerThreadId,
      inReplyToMessageId: ref?.internetMessageId,
      messageId: outboundId,
    });
    return {
      externalId: sent.gmailMessageId,
      threadId: sent.gmailThreadId,
      status: "confirmed",
      url: sent.gmailThreadId
        ? `https://mail.google.com/mail/u/0/#all/${sent.gmailThreadId}`
        : null,
    };
  }
  const message = {
    subject: m.subject,
    body: { contentType: "Text", content: body },
    toRecipients: [{ emailAddress: { address: m.toAddress } }],
    internetMessageHeaders: [
      { name: "x-orbit-message-id", value: `${m.id}:${m.revision}` },
    ],
  };
  const inbound = conversation
    ? await db.query.outreachConversationMessages.findFirst({
        where: and(
          eq(outreachConversationMessages.conversationId, conversation.id),
        ),
        orderBy: sql`sent_at DESC`,
      })
    : null;
  const draft = (await (
    await graph(
      job.userId,
      inbound
        ? `/messages/${encodeURIComponent(inbound.externalId)}/createReply`
        : "/messages",
      { method: "POST", body: JSON.stringify(inbound ? {} : message) },
    )
  ).json()) as { id: string; conversationId?: string; webLink?: string };
  if (inbound)
    await graph(job.userId, `/messages/${encodeURIComponent(draft.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        body: message.body,
        toRecipients: message.toRecipients,
        subject: m.subject,
      }),
    });
  await db
    .update(outreachJobs)
    .set({
      result: {
        phase: "prepared",
        providerId: draft.id,
        threadId: draft.conversationId,
      },
    })
    .where(eq(outreachJobs.id, job.id));
  await verifyLease();
  await graph(job.userId, `/messages/${encodeURIComponent(draft.id)}/send`, {
    method: "POST",
  });
  return {
    externalId: draft.id,
    threadId: draft.conversationId ?? null,
    status: "accepted",
    url: draft.webLink ?? null,
  };
}
