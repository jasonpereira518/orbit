import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { outreachJobs, outreachMessages } from "@/db/schema";
import { messageFor } from "./store";
import { gmail, graph } from "./mail";
import { recordSent } from "./conversations";
export async function reconcileSend(
  userId: string,
  jobId: string,
  manual?: boolean,
) {
  const db = await getDb();
  const job = await db.query.outreachJobs.findFirst({
    where: and(
      eq(outreachJobs.id, jobId),
      eq(outreachJobs.userId, userId),
      eq(outreachJobs.status, "needs_verification"),
    ),
  });
  if (!job) throw new Error("No interrupted send found.");
  const { message: m } = await messageFor(userId, job.payload.messageId!);
  let sent: boolean | undefined;
  let externalId = m.deliveryId ?? `browser:${m.id}:${m.revision}`,
    threadId = m.providerThreadId,
    url: string | null = null;
  if (job.kind === "browser_send") {
    if (manual === undefined)
      throw new Error(
        "Open the provider, verify the recipient and exact message, then confirm the result here.",
      );
    sent = manual;
  } else if (m.senderSnapshot?.transport === "gmail") {
    const id =
      typeof job.result?.outboundId === "string"
        ? job.result.outboundId
        : `<orbit-${m.id}-${m.revision}@outreach.orbit>`;
    const found = (await gmail(
      userId,
      `/messages?q=${encodeURIComponent(`in:sent rfc822msgid:${id}`)}`,
    )) as { messages?: Array<{ id: string; threadId: string }> };
    if (found.messages?.length === 1) {
      sent = true;
      externalId = found.messages[0].id;
      threadId = found.messages[0].threadId;
      url = `https://mail.google.com/mail/u/0/#all/${threadId}`;
    }
  } else if (
    m.senderSnapshot?.transport === "outlook" &&
    typeof job.result?.providerId === "string"
  ) {
    const found = await (
      await graph(
        userId,
        `/messages/${encodeURIComponent(job.result.providerId)}?$select=id,isDraft,conversationId,webLink`,
      )
    ).json();
    // A still-visible draft may be an eventually consistent accepted send.
    // Only a positive Sent observation resolves an ambiguous provider request.
    if (found.isDraft === false) sent = true;
    externalId = found.id;
    threadId = found.conversationId;
    url = found.webLink;
  }
  if (sent === undefined)
    throw new Error(
      "The provider has not established whether it was sent. Keep this message on hold and check again later.",
    );
  if (sent)
    await recordSent(userId, m.id, {
      externalId,
      threadId,
      status: "confirmed",
      url,
    });
  else
    await db
      .update(outreachMessages)
      .set({
        executionStatus: "idle",
        revision: m.revision + 1,
        approvedRevision: null,
        errorMessage: null,
      })
      .where(eq(outreachMessages.id, m.id));
  await db
    .update(outreachJobs)
    .set({
      status: sent ? "completed" : "cancelled",
      error: null,
      result: { ...job.result, reconciled: true, manual: manual !== undefined },
      updatedAt: new Date(),
    })
    .where(eq(outreachJobs.id, job.id));
  return { sent };
}
