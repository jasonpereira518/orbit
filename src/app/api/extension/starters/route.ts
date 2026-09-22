import type {
  StartersRequest,
  StartersResponse,
} from "@/lib/extension/contract";
import { startersRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { buildStarterContext } from "@/lib/extension/resolve";
import { generateConversationStarters } from "@/lib/conversation-starters";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";

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
    // From the signed-in user's own row, never from the request: the extension client has no
    // field for it, so a page cannot supply one. The starters cache keys on the whole prompt,
    // so a change to the notes refreshes the starters on its own.
    const writingInstructions = await loadWritingInstructions(userId).catch(() => null);
    return generateConversationStarters(userId, { ...ctx, writingInstructions }, input.limit ?? 3);
  },
});

export const OPTIONS = preflight;
