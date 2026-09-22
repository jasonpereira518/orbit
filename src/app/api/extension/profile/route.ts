import type { ProfileCaptureRequest, ProfileCaptureResponse } from "@/lib/extension/contract";
import { MAX_PROFILE_BODY_BYTES, profileCaptureRequestSchema } from "@/lib/extension/contract.schema";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { captureContactProfile } from "@/lib/extension/profile-capture";

export const dynamic = "force-dynamic";
// One model call over up to 40k characters of page: longer than /parse's.
export const maxDuration = 60;

/**
 * Read a contact's work history off the LinkedIn page the user is on. Pro.
 *
 * The only route that takes a whole profile's text, and only on a click. A
 * page that is someone else's comes back `conflict` with no model call; a page
 * that shows less than Orbit holds comes back `partial` with nothing written.
 * Never 5xx for an AI reason — those are `degraded`.
 */
export const POST = extensionRoute<ProfileCaptureRequest, ProfileCaptureResponse>({
  schema: profileCaptureRequestSchema,
  cost: "ai",
  entitlement: "workHistory",
  maxBodyBytes: MAX_PROFILE_BODY_BYTES,
  handler: ({ userId, input }) => captureContactProfile(userId, input),
});

export const OPTIONS = preflight;
