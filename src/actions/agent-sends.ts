"use server";

/**
 * The approval half of assistant-drafted messages.
 *
 * Every export must be an async function: one non-async export in a `"use server"` module
 * breaks every export in it, and `tsc` will not tell you.
 *
 * `approveAgentDraft` is the ONLY path in the codebase that sends a message an agent wrote,
 * and it starts with `requireUserId()` — a Clerk session, from a browser, belonging to the
 * person the draft is for. No API key, OAuth token or MCP tool reaches it. That is the
 * control the whole MCP send design rests on; see `src/lib/agent-sends.ts`.
 */
import { revalidatePath } from "next/cache";
import { approveAgentSend } from "@/lib/agent-send-approve";
import {
  listPendingAgentSends,
  rejectAgentSend,
  type AgentSendSummary,
} from "@/lib/agent-sends";
import { getCurrentUserProfile } from "@/lib/auth";
import { asActionResult, UserFacingError } from "@/lib/errors";
import { z } from "zod";
import { defineAction, failResult } from "@/lib/input/action";

export const listAgentDrafts = defineAction(
  {},
  async (userId): Promise<AgentSendSummary[]> => {
    return listPendingAgentSends(userId);
  }
);

export const approveAgentDraft = defineAction(
  { schema: z.tuple([z.string(), z.looseObject({ subject: z.string().optional(), body: z.string().optional(), confirmRecipient: z.boolean().optional() }).optional()]), invalid: failResult },
  async (userId, draftId: string, edits?: { subject?: string; body?: string; confirmRecipient?: boolean }) => {
    return asActionResult(async () => {
      const profile = await getCurrentUserProfile().catch(() => null);
      // Only the three known keys cross from the client, typed; anything else is dropped.
      const result = await approveAgentSend(userId, draftId, {
        subject: typeof edits?.subject === "string" ? edits.subject : undefined,
        body: typeof edits?.body === "string" ? edits.body : undefined,
        confirmRecipient: edits?.confirmRecipient === true,
        fromName: profile?.name?.trim() || null,
      });
      revalidatePath("/dashboard");
      return result;
    });
  }
);

export const rejectAgentDraft = defineAction(
  { schema: z.tuple([z.string()]), invalid: failResult },
  async (userId, draftId: string) => {
    return asActionResult(async () => {
      const done = await rejectAgentSend(userId, draftId);
      if (!done) throw new UserFacingError("That draft is no longer waiting for approval");
      revalidatePath("/dashboard");
      return { rejected: true };
    });
  }
);
