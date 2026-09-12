import type { ResolveRequest, ResolveResponse } from "@/lib/extension/contract";
import { resolveRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { resolveContactFromPage } from "@/lib/extension/resolve";

export const dynamic = "force-dynamic";

/**
 * The extension's first paint depends entirely on this call, so it does no AI
 * work: identity resolution is a slug lookup, and the starters it returns are
 * the deterministic heuristic seed. `POST /starters` upgrades them afterwards.
 */
export const POST = extensionRoute<ResolveRequest, ResolveResponse>({
  schema: resolveRequestSchema,
  handler: ({ userId, input }) => resolveContactFromPage(userId, input.page),
});

export const OPTIONS = preflight;
