import type {
  StartersRequest,
  StartersResponse,
} from "@/lib/extension/contract";
import { startersRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { buildStarterContext } from "@/lib/extension/resolve";
import { generateConversationStarters } from "@/lib/conversation-starters";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Upgrade the heuristic seed from /resolve with AI-written suggestions.
 *
 * This route never returns 5xx for an AI failure. No provider key, a rate
 * limit, a timeout, malformed output — all of it degrades to the heuristics
 * with `degraded: true` and a 200, because having no key is a normal state for
 * a fraction of users rather than an error worth showing them.
 */
export const POST = extensionRoute<StartersRequest, StartersResponse>({
  schema: startersRequestSchema,
  cost: "ai",
  handler: async ({ userId, input }) => {
    const ctx = await buildStarterContext(userId, input.page, input.contactId);
    return generateConversationStarters(userId, ctx, input.limit ?? 3);
  },
});

export const OPTIONS = preflight;
