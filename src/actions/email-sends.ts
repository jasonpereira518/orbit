"use server";

import { cancelEmailSend } from "@/lib/email/outbox";
import { getSendCapability, type SendCapability } from "@/lib/email/sender";
import { z } from "zod";
import { defineAction } from "@/lib/input/action";

/** Undo a queued email. Only works until the dispatcher claims it. */
export const cancelEmailSendAction = defineAction(
  { schema: z.tuple([z.string()]) },
  async (userId, id: string): Promise<{ result: "canceled" | "already_sent" | "not_found" }> => {
    return { result: await cancelEmailSend(userId, id) };
  }
);

export const getSendCapabilityAction = defineAction(
  {},
  async (userId): Promise<SendCapability> => {
    return getSendCapability(userId);
  }
);
