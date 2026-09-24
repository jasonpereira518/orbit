import type {
  ReminderActionRequest,
  ReminderActionResponse,
} from "@/lib/extension/contract";
import { reminderActionRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import {
  completeReminderFromExtension,
  reopenReminderFromExtension,
} from "@/lib/extension/reminders";

export const dynamic = "force-dynamic";

/**
 * Complete a reminder, or undo that. The id rides in the body rather than the
 * path so this stays one static route — dynamic `params` are a Promise in this
 * Next version, and nothing here needs a segment.
 */
export const POST = extensionRoute<ReminderActionRequest, ReminderActionResponse>({
  schema: reminderActionRequestSchema,
  handler: async ({ userId, input }) => {
    if (input.action === "complete") {
      const completion = await completeReminderFromExtension(userId, input.reminderId);
      return { reminderId: input.reminderId, completion, restored: false };
    }
    const { restored } = await reopenReminderFromExtension(userId, input.completion);
    return { reminderId: input.completion.reminderId, completion: null, restored };
  },
});

export const OPTIONS = preflight;
