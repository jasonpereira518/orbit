import type {
  FollowUpRequest,
  FollowUpResponse,
} from "@/lib/extension/contract";
import { followUpRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { scheduleContactFollowUp } from "@/lib/extension/follow-ups";

export const dynamic = "force-dynamic";

/** Schedule, snooze, or clear a contact's follow-up. */
export const POST = extensionRoute<FollowUpRequest, FollowUpResponse>({
  schema: followUpRequestSchema,
  handler: async ({ userId, input }) => {
    const { contactId, reminderId, title, ...followUp } = input;
    const result = await scheduleContactFollowUp(userId, {
      contactId,
      reminderId,
      title,
      followUp,
    });
    return {
      contactId: result.contactId,
      nextFollowUpAt: result.nextFollowUpAt?.toISOString() ?? null,
      reminderId: result.reminderId,
    };
  },
});

export const OPTIONS = preflight;
