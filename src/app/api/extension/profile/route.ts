import type { ProfileCaptureResponse } from "@/lib/extension/contract";
import {
  MAX_PROFILE_BODY_BYTES,
  profileCaptureRequestSchema,
} from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { captureContactProfile, type ProfileCaptureInput } from "@/lib/extension/profile-capture";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Store a captured LinkedIn profile against a contact.
 *
 * `cost: "ai"` even though the model is only a fallback: the tighter AI budget is what
 * stops a looping extension from burning the user's own provider quota, and this route can
 * reach the model on any request.
 */
export const POST = extensionRoute<ProfileCaptureInput, ProfileCaptureResponse>({
  schema: profileCaptureRequestSchema,
  cost: "ai",
  maxBodyBytes: MAX_PROFILE_BODY_BYTES,
  handler: ({ userId, input }) => captureContactProfile(userId, input),
});

export const OPTIONS = preflight;
