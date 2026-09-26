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
import { requireUserId } from "@/lib/auth";
import { asActionResult, UserFacingError } from "@/lib/errors";

export async function listAgentDrafts(): Promise<AgentSendSummary[]> {
  const userId = await requireUserId();
  return listPendingAgentSends(userId);
}

export async function approveAgentDraft(
  draftId: string,
  edits?: { subject?: string; body?: string; confirmRecipient?: boolean }
) {
  return asActionResult(async () => {
    const userId = await requireUserId();
    // Only the three known keys cross from the client, typed; anything else is dropped.
    const result = await approveAgentSend(userId, draftId, {
      subject: typeof edits?.subject === "string" ? edits.subject : undefined,
      body: typeof edits?.body === "string" ? edits.body : undefined,
      confirmRecipient: edits?.confirmRecipient === true,
    });
    revalidatePath("/dashboard");
    return result;
  });
}

export async function rejectAgentDraft(draftId: string) {
  return asActionResult(async () => {
    const userId = await requireUserId();
    const done = await rejectAgentSend(userId, draftId);
    if (!done) throw new UserFacingError("That draft is no longer waiting for approval");
    revalidatePath("/dashboard");
    return { rejected: true };
  });
}
