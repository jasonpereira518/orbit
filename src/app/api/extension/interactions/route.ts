import { after } from "next/server";
import type {
  LogInteractionRequest,
  LogInteractionResponse,
} from "@/lib/extension/contract";
import { logInteractionRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { logExtensionInteraction } from "@/lib/extension/writes";
import { requirePlanForSurface } from "@/lib/surface-visibility";

export const dynamic = "force-dynamic";

/**
 * Log a note against a contact, optionally scheduling a follow-up in the same
 * call — "log this and remind me in two weeks" is one user gesture and should
 * not cost two round trips.
 */
export const POST = extensionRoute<LogInteractionRequest, LogInteractionResponse>({
  schema: logInteractionRequestSchema,
  action: "log_interaction",
  // The Contacts page's tier lock, as its own log-interaction action applies it.
  handler: async ({ userId, input }) => {
    await requirePlanForSurface(userId, "page.contacts");
    return logExtensionInteraction(userId, input, after);
  },
});

export const OPTIONS = preflight;
