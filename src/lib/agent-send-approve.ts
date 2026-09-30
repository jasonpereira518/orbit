/**
 * Turning an approved draft into a sent message.
 *
 * Deliberately its own module rather than part of `agent-sends.ts`: everything an agent can
 * reach lives there, and the one function that actually sends lives here, called only from a
 * Clerk-authenticated server action.
 *
 * ## How it sends
 *
 * Through the email outbox (`src/lib/email/outbox.ts`), from the user's own mailbox: it
 * arrives from their real address, lands in their Sent folder, and threads with the rest of
 * the conversation. Approval is the confirmation, so there is no undo window and the send is
 * dispatched inline so the card can say what happened. What the draft row records afterwards
 * is the outbox's call (`src/lib/email/origin-hooks/agent.ts`): sent, back to pending after a
 * definite failure, or `failed` when it may have gone out — never re-approvable, so a timeout
 * can't mail the same person twice. There is no Resend fallback: no mailbox, no send.
 */
import "@/lib/email/origin-registrations";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { emailSends, type EmailProviderId } from "@/db/schema";
import {
  claimAgentSendForApproval,
  finishAgentSend,
  getAgentSendRequest,
  recipientNeedsConfirmation,
  type AgentSendSummary,
} from "@/lib/agent-sends";
import { dispatchEmailSend, enqueueEmail } from "@/lib/email/outbox";
import { UserFacingError } from "@/lib/errors";

export type ApproveResult = {
  sent: boolean;
  via: EmailProviderId | null;
  /** `retrying`: the provider was slow or unsure; the outbox keeps going and reports back. */
  status: "sent" | "retrying" | "failed";
  error?: string;
};

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
  opts: { subject?: string; body?: string; confirmRecipient?: boolean; fromName?: string | null } = {}
): Promise<ApproveResult> {
  // A recipient the user's own contacts cannot vouch for — or one that differs from the
  // contact the agent attached the draft to — needs a second, explicit confirmation. Checked
  // here, from the database, so a client that skips the card's warning still cannot send.
  const current = await getAgentSendRequest(userId, draftId);
  if (current && recipientNeedsConfirmation(current.recipientTrust) && !opts.confirmRecipient) {
    throw new UserFacingError(
      current.recipientTrust === "mismatch"
        ? `This draft is attached to ${current.contactName ?? "a contact"} but addressed to ${current.toEmail}. Confirm the address to send.`
        : `${current.toEmail} isn't one of your contacts. Confirm the address to send.`
    );
  }

  const claimed = await claimAgentSendForApproval(userId, draftId);
  if (!claimed) {
    // Already decided, already sending, or past its date. Never a reason to send.
    throw new UserFacingError("That draft is no longer waiting for approval");
  }

  const queued = await enqueueEmail(userId, {
    to: [claimed.toEmail],
    subject: opts.subject ?? claimed.subject ?? "",
    bodyText: opts.body ?? claimed.body,
    fromName: opts.fromName ?? null,
    origin: "agent",
    originRef: claimed.id,
    idempotencyKey: `agent:${claimed.id}`,
    contactIds: claimed.contactId ? [claimed.contactId] : undefined,
    delayMs: 0,
  });
  if (!queued.ok) {
    await finishAgentSend(claimed.id, { ok: false, error: queued.message });
    throw new UserFacingError(queued.message);
  }

  const outcome = await dispatchEmailSend(queued.id);
  if (outcome === "sent") return { sent: true, via: queued.provider, status: "sent" };
  if (outcome === "retry") return { sent: false, via: queued.provider, status: "retrying" };
  const db = await getDb();
  const row = await db.query.emailSends.findFirst({
    where: eq(emailSends.id, queued.id),
    columns: { failureKind: true },
  });
  return {
    sent: false,
    via: queued.provider,
    status: "failed",
    error:
      row?.failureKind === "ambiguous"
        ? "That may have sent — check your Sent folder before sending it again."
        : row?.failureKind === "auth"
          ? "Gmail needs reconnecting before this can send. The draft is back in your queue."
          : "That didn’t send. The draft is back in your queue.",
  };
}

export type { AgentSendSummary };
