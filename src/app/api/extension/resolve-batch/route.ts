import type {
  ResolveBatchRequest,
  ResolveBatchResponse,
} from "@/lib/extension/contract";
import { resolveBatchRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { resolveBatch } from "@/lib/extension/people";

export const dynamic = "force-dynamic";

/**
 * Who on a list page (search results, a team page, a group thread) the user
 * already knows — up to ten people in one request. Free: it is recognition,
 * the extension's core. A name alone is never "known"; see `resolveBatch`.
 */
export const POST = extensionRoute<ResolveBatchRequest, ResolveBatchResponse>({
  schema: resolveBatchRequestSchema,
  handler: async ({ userId, input }) => ({
    items: await resolveBatch(userId, input.candidates),
  }),
});

export const OPTIONS = preflight;
