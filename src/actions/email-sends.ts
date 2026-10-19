"use server";

import { requireUserId } from "@/lib/auth";
import { cancelEmailSend } from "@/lib/email/outbox";

/** Undo a queued email. Only works until the dispatcher claims it. */
export async function cancelEmailSendAction(
  id: string
): Promise<{ result: "canceled" | "already_sent" | "not_found" }> {
  const userId = await requireUserId();
  return { result: await cancelEmailSend(userId, id) };
}
