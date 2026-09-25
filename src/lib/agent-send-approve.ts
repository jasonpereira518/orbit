/**
 * Turning an approved draft into a sent message.
 *
 * Deliberately its own module rather than part of `agent-sends.ts`: that file is imported by
 * `outreach-send.ts` (for the shared daily count), so the send paths cannot be imported back
 * into it without a cycle. The split also keeps the honest shape of the thing — everything an
 * agent can reach lives in `agent-sends.ts`, and the one function that actually sends lives
 * here, called only from a Clerk-authenticated server action.
 *
 * ## Which mailbox it goes through
 *
 * The user's own Gmail first, when it is connected with the send scope. That is what a person
 * expects of "email Priya a thank-you": it arrives from their real address, lands in their
 * Sent folder, and threads with the rest of the conversation. Resend is the fallback, and on
 * the free plan only when the user brought their own key — Orbit's credits stay a paid
 * feature, so a free account gets a clear refusal rather than a silent failure.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections } from "@/db/schema";
import {
  claimAgentSendForApproval,
  finishAgentSend,
  type AgentSendSummary,
} from "@/lib/agent-sends";
import { UserFacingError } from "@/lib/errors";
import { sendGmailMessage } from "@/lib/gmail-send";
import { GOOGLE_SCOPES, hasScope } from "@/lib/google-scopes";
import { logInteractionForUser } from "@/lib/contact-writes";
import { getOutreachSendConfig, sendOutreachMessage } from "@/lib/outreach-send";

export type ApproveResult = {
  sent: boolean;
  via: "gmail" | "resend" | null;
  error?: string;
};

/** A Gmail connection that may actually send, as opposed to one that may only read. */
async function gmailCanSend(userId: string): Promise<boolean> {
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { status: true, scopes: true },
  });
  if (!conn || conn.status !== "active") return false;
  return hasScope(conn.scopes, GOOGLE_SCOPES.gmailSend);
}

/**
 * Send a pending draft, after a human approved it.
 *
 * The claim happens first and in one statement, so a double click cannot send twice. From
 * that point the row is out of `pending` whatever happens next, and its final status records
 * which it was.
 */
export async function approveAgentSend(
  userId: string,
  draftId: string,
  opts: { subject?: string; body?: string } = {}
): Promise<ApproveResult> {
  const claimed = await claimAgentSendForApproval(userId, draftId);
  if (!claimed) {
    // Already decided, already sending, or past its date. Never a reason to send.
    throw new UserFacingError("That draft is no longer waiting for approval");
  }

  // An edit made on the approval card wins over what the agent wrote. This is the user's
  // message now.
  const subject = opts.subject ?? claimed.subject ?? "";
  const body = opts.body ?? claimed.body;

  try {
    let via: "gmail" | "resend";
    let deliveryId: string | undefined;

    if (await gmailCanSend(userId)) {
      const result = await sendGmailMessage(userId, {
        to: claimed.toEmail,
        subject: subject || "(no subject)",
        body,
      });
      via = "gmail";
      deliveryId = result.gmailMessageId;
    } else {
      const config = await getOutreachSendConfig(userId);
      if (!config.resendApiKey) {
        throw new UserFacingError(
          "Connect Gmail in Settings, or add your own Resend key, to send from Orbit"
        );
      }
      const result = await sendOutreachMessage({
        userId,
        channel: "email",
        toEmail: claimed.toEmail,
        subject,
        body,
      });
      via = "resend";
      deliveryId =
        result && typeof result === "object" && "id" in result
          ? String((result as { id?: unknown }).id ?? "")
          : undefined;
    }

    await finishAgentSend(claimed.id, { ok: true, deliveryId });

    // The timeline should show what the user sent, whoever drafted it. `source: "mcp"` keeps
    // the provenance honest — an assistant wrote these words, a person sent them.
    if (claimed.contactId) {
      await logInteractionForUser(
        userId,
        {
          contactId: claimed.contactId,
          interactionType: "email",
          interactionDate: new Date(),
          rawNotes: subject ? `${subject}\n\n${body}` : body,
          source: "mcp",
          direction: "out",
          externalId: `mcp:send:${claimed.id}`,
        },
        { skipRevalidate: true }
      ).catch(() => null);
    }

    return { sent: true, via };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not send that message.";
    await finishAgentSend(claimed.id, { ok: false, error: message });
    throw err;
  }
}

export type { AgentSendSummary };
