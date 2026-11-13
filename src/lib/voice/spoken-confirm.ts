import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { chatMessages } from "@/db/schema";
import { UserFacingError } from "@/lib/errors";
import { cancelEmailSend } from "@/lib/email/outbox";
import { commitProposedAction, dismissProposedAction } from "@/actions/chat-actions";
import { getChatSendContext, sendChatDraftViaGmail } from "@/actions/chat-send";
import { requireVoiceSession } from "./sessions";

/**
 * What a spoken "send it" / "yes" / "cancel" does, server side. The browser decides THAT the
 * person said the phrase (src/lib/voice/confirm-window.ts); this decides what it may touch: only
 * a card this very call proposed, still waiting, through the same commit, dismiss and send paths
 * a click uses. The model never reaches here: these are app requests, not tools.
 *
 * Only the voice API route imports this module: kept out of src/lib/voice/sessions.ts, which is
 * in every page's server-action graph (pulling the chat actions in there reloads /onboarding in
 * next dev).
 */
async function waitingCard(userId: string, sessionId: string, messageId: string, actionId: string) {
  await requireVoiceSession(userId, sessionId);
  const db = await getDb();
  const row = await db.query.chatMessages.findFirst({
    where: and(
      eq(chatMessages.id, messageId),
      eq(chatMessages.userId, userId),
      eq(chatMessages.clientTurnId, `voice-proposal:${sessionId}`),
    ),
    columns: { proposedActions: true },
  });
  const action = row?.proposedActions?.find((a) => a.id === actionId);
  if (!action || action.status !== "proposed") throw new UserFacingError("That change isn’t waiting any more");
  return action;
}

export type SpokenOutcome =
  | { outcome: "sent"; sendId: string; sendAt: string; to: string }
  | { outcome: "done" }
  | { outcome: "needs_mailbox" }
  | { outcome: "no_address" }
  | { outcome: "failed"; reason: string };

export async function confirmVoiceCard(userId: string, sessionId: string, messageId: string, actionId: string): Promise<SpokenOutcome> {
  const action = await waitingCard(userId, sessionId, messageId, actionId);
  if (action.args.tool === "draft_email") {
    const input = action.args.input as { contactId?: string; body?: string; subject?: string };
    if (!input.contactId || !input.body) return { outcome: "failed", reason: "That email is missing its text" };
    const context = await getChatSendContext(messageId, input.contactId);
    if (!context) return { outcome: "failed", reason: "That email can’t be sent any more" };
    if (!context.identity.canSend) return { outcome: "needs_mailbox" };
    if (!context.to || context.recipientProblem) return { outcome: "no_address" };
    const sent = await sendChatDraftViaGmail({
      messageId,
      contactId: input.contactId,
      subject: input.subject?.trim() || context.defaultSubject,
      body: input.body,
      shownTo: context.to,
    });
    if (!sent.ok) return { outcome: "failed", reason: sent.message };
    // draft_email's own commit only marks the card done, exactly as the dialog's Send does.
    await commitProposedAction(messageId, actionId);
    return { outcome: "sent", sendId: sent.sendId, sendAt: sent.sendAt, to: sent.to };
  }
  const done = await commitProposedAction(messageId, actionId);
  return done.ok ? { outcome: "done" } : { outcome: "failed", reason: done.reason };
}

export async function dismissVoiceCard(userId: string, sessionId: string, messageId: string, actionId: string) {
  await waitingCard(userId, sessionId, messageId, actionId);
  return dismissProposedAction(messageId, actionId);
}

/** A spoken "undo" while the email is still in its undo window. */
export async function undoVoiceSend(userId: string, sessionId: string, sendId: string) {
  await requireVoiceSession(userId, sessionId);
  return { result: await cancelEmailSend(userId, sendId) };
}
