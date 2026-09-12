import type { ParseRequest, ParseResponse } from "@/lib/extension/contract";
import { parseRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { parseProfileFields } from "@/lib/extension/parse-profile";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Read the page's text into contact fields.
 *
 * Split from /resolve deliberately: resolution is a slug lookup that has to
 * stay fast because the whole first paint waits on it, while this costs a model
 * call. The panel fires both at once and fills the record as each lands.
 *
 * Never 5xx for an AI reason — no key, timeout, or malformed output all return
 * `degraded: true` with nothing filled, and the record keeps whatever the
 * adapter read.
 */
export const POST = extensionRoute<ParseRequest, ParseResponse>({
  schema: parseRequestSchema,
  cost: "ai",
  handler: ({ userId, input }) => parseProfileFields(userId, input.page),
});

export const OPTIONS = preflight;
