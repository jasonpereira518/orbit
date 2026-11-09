import type { RecentEventsResponse } from "@/lib/extension/contract";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { recentEventsForExtension } from "@/lib/extension/log-connections";

export const dynamic = "force-dynamic";

/** The events the user could have just been at, for the Connections page's event picker. */
export const GET = extensionRoute<undefined, RecentEventsResponse>({
  handler: ({ userId }) => recentEventsForExtension(userId),
});

export const OPTIONS = preflight;
