import type { EventRosterRequest, EventRosterResponse } from "@/lib/extension/contract";
import { eventRosterRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { saveEventRoster } from "@/lib/extension/event-roster";

export const dynamic = "force-dynamic";

/** Save the Luma/Partiful guest list the user has open — on their Save, never on read. */
export const POST = extensionRoute<EventRosterRequest, EventRosterResponse>({
  schema: eventRosterRequestSchema,
  handler: ({ userId, input }) => saveEventRoster(userId, input.page),
});

export const OPTIONS = preflight;
