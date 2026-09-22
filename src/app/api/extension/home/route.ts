import type { HomeResponse } from "@/lib/extension/contract";
import { loadHome } from "@/lib/extension/home";
import { extensionRoute, preflight } from "@/lib/extension/http";

export const dynamic = "force-dynamic";

/**
 * The panel's Home, beside a page that isn't about anyone. `?tz=` is the
 * viewer's IANA zone ("today" is theirs, not the server's); anything
 * unrecognized falls back to UTC before it can reach SQL.
 */
export const GET = extensionRoute<undefined, HomeResponse>({
  handler: ({ userId, req }) =>
    loadHome(userId, new URL(req.url).searchParams.get("tz")),
});

export const OPTIONS = preflight;
