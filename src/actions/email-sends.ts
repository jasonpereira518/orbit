"use server";

import { requireUserId } from "@/lib/auth";
import { cancelEmailSend } from "@/lib/email/outbox";
import { getSendCapability, type SendCapability } from "@/lib/email/sender";

/** Undo a queued email. Only works until the dispatcher claims it. */
export async function cancelEmailSendAction(
  id: string
): Promise<{ result: "canceled" | "already_sent" | "not_found" }> {
  const userId = await requireUserId();
  return { result: await cancelEmailSend(userId, id) };
}

export async function getSendCapabilityAction(): Promise<SendCapability> {
  const userId = await requireUserId();
  return getSendCapability(userId);
}
