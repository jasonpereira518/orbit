import type { LogConnectionsRequest, LogConnectionsResponse } from "@/lib/extension/contract";
import { logConnectionsRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { logConnectionsAtEvent } from "@/lib/extension/log-connections";

export const dynamic = "force-dynamic";

/** Put the LinkedIn connections the user ticked on one of their events — on their click. */
export const POST = extensionRoute<LogConnectionsRequest, LogConnectionsResponse>({
  schema: logConnectionsRequestSchema,
  action: "log_connections",
  siteOf: () => "linkedin",
  handler: ({ userId, input }) => logConnectionsAtEvent(userId, input),
});

export const OPTIONS = preflight;
