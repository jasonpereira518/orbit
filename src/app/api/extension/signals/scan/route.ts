import type { ScanMatchRequest, ScanMatchResponse } from "@/lib/extension/contract";
import { scanMatchRequestSchema } from "@/lib/extension/contract.schema";
import { ExtensionRouteError, extensionRoute, preflight } from "@/lib/extension/http";
import { matchScannedAuthors } from "@/lib/radar/signals/activity";

export const dynamic = "force-dynamic";

/**
 * "Scan this page for people I know", step one (Radar PR 11): the authors' LinkedIn profile
 * links from what the person's own browser rendered, and nothing else. Answers which of them
 * are their contacts, matched by profile only; none of the links is kept. Only the matched
 * contacts' posts are then sent, to `scan/save`, so a stranger's post never leaves the browser.
 */
export const POST = extensionRoute<ScanMatchRequest, ScanMatchResponse>({
  schema: scanMatchRequestSchema,
  action: "scan_activity",
  handler: async ({ userId, settings, input }) => {
    if (settings.radarCaptureLinkedinActivity !== 1) {
      throw new ExtensionRouteError("invalid_request", "Saving LinkedIn activity is off. Turn it on in Radar’s settings first.");
    }
    return { contacts: await matchScannedAuthors(userId, input.authors) };
  },
});

export const OPTIONS = preflight;
