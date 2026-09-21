import type {
  StartersRequest,
  StartersResponse,
} from "@/lib/extension/contract";
import { startersRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { extensionFeatures } from "@/lib/extension/entitlements";
import { buildStarterContext } from "@/lib/extension/resolve";
import {
  generateConversationStarters,
  heuristicStarters,
} from "@/lib/conversation-starters";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Upgrade the heuristic seed from /resolve with AI-written suggestions.
 *
 * This route never returns 5xx for an AI failure. No provider key, a rate
 * limit, a timeout, malformed output — all of it degrades to the heuristics
 * with `degraded: true` and a 200, because having no key is a normal state for
 * a fraction of users rather than an error worth showing them.
 *
 * AI opening lines are Pro. A free account gets the same heuristics, marked
 * `degradedReason: "plan"` — a 200, deliberately not a 402 via `entitlement:`.
 * A v1 panel that predates plans renders exactly what it always rendered for a
 * keyless user; a v2 panel reads the reason and draws the lock. No gate hit is
 * recorded here: the panel records one when the user actually clicks the lock
 * (`POST /gate`), and a render is not a request for the feature.
 */
export const POST = extensionRoute<StartersRequest, StartersResponse>({
  schema: startersRequestSchema,
  cost: "ai",
  handler: async ({ userId, input, entitlements }) => {
    const ctx = await buildStarterContext(userId, input.page, input.contactId);
    const limit = input.limit ?? 3;
    if (!extensionFeatures(entitlements).starters) {
      return {
        mode: ctx.mode,
        starters: heuristicStarters(ctx, limit),
        degraded: true,
        degradedReason: "plan",
      };
    }
    return generateConversationStarters(userId, ctx, limit);
  },
});

export const OPTIONS = preflight;
