import type { ScanSaveRequest, ScanSaveResponse } from "@/lib/extension/contract";
import { scanSaveRequestSchema } from "@/lib/extension/contract.schema";
import { ExtensionRouteError, extensionRoute, preflight } from "@/lib/extension/http";
import { saveScannedPosts } from "@/lib/radar/signals/activity";

export const dynamic = "force-dynamic";

/**
 * "Scan this page", step two: the matched contacts' posts, kept as Radar activity. Every
 * author is matched again here, so a post by anyone who is not a contact is dropped whatever
 * the extension sent.
 */
export const POST = extensionRoute<ScanSaveRequest, ScanSaveResponse>({
  schema: scanSaveRequestSchema,
  action: "scan_activity",
  handler: async ({ userId, settings, input }) => {
    if (settings.radarCaptureLinkedinActivity !== 1) {
      throw new ExtensionRouteError("invalid_request", "Saving LinkedIn activity is off. Turn it on in Radar’s settings first.");
    }
    return saveScannedPosts(userId, input.posts);
  },
});

export const OPTIONS = preflight;
