import type {
  GateIntentRequest,
  GateIntentResponse,
} from "@/lib/extension/contract";
import { gateIntentRequestSchema } from "@/lib/extension/contract.schema";
import { extensionUpgradeUrl } from "@/lib/extension/entitlements";
import { extensionRoute, preflight } from "@/lib/extension/http";
import { getAppBaseUrl } from "@/lib/app-url";
import { recordExtensionGateHit } from "@/lib/gate-events";

export const dynamic = "force-dynamic";

/**
 * A click on a locked section of the panel.
 *
 * This, not the render, is the demand signal: a locked "Opening lines" band is
 * on screen for every profile a free user passes, but only a click means they
 * wanted it. Throttled to one row per user, per feature, per day (see
 * `recordExtensionGateHit`). Hands back where to send them.
 */
export const POST = extensionRoute<GateIntentRequest, GateIntentResponse>({
  schema: gateIntentRequestSchema,
  handler: async ({ userId, input, entitlements }) => {
    const recorded = await recordExtensionGateHit({
      userId,
      plan: entitlements.plan,
      feature: input.feature,
      context: { route: "/api/extension/gate", site: input.site },
    });
    return {
      recorded,
      upgradeUrl: extensionUpgradeUrl(getAppBaseUrl(), input.feature),
    };
  },
});

export const OPTIONS = preflight;
