import type { SaveActivityRequest, SaveActivityResponse } from "@/lib/extension/contract";
import { saveActivityRequestSchema } from "@/lib/extension/contract.schema";
import { ExtensionRouteError, extensionRoute, preflight } from "@/lib/extension/http";
import { saveLinkedinActivity } from "@/lib/radar/signals/activity";

export const dynamic = "force-dynamic";

/**
 * "Save as Radar activity": a post by a known contact that the person chose to keep, as a
 * Radar signal. Additive to contract v1. Refused unless the person turned activity capture
 * on in Radar's settings (`user_settings.radar_capture_linkedin_activity`).
 */
export const POST = extensionRoute<SaveActivityRequest, SaveActivityResponse>({
  schema: saveActivityRequestSchema,
  handler: async ({ userId, settings, input }) => {
    if (settings.radarCaptureLinkedinActivity !== 1) {
      throw new ExtensionRouteError(
        "invalid_request",
        "Saving LinkedIn activity is off. Turn it on in Radar’s settings first."
      );
    }
    const result = await saveLinkedinActivity(userId, input);
    if (result.reason === "not_found") throw new ExtensionRouteError("not_found", "That contact no longer exists.");
    if (result.reason === "empty") throw new ExtensionRouteError("invalid_request", "There was no text to save.");
    return { saved: result.saved, duplicate: result.duplicate };
  },
});

export const OPTIONS = preflight;
