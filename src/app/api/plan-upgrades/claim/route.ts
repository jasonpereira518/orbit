import { requireUserId } from "@/lib/auth";
import { routeError } from "@/lib/api/route-error";
import { sameOriginGuard } from "@/lib/api/same-origin";
import { claimPendingPlanUpgrade } from "@/lib/plan-upgrade-events";

/**
 * Claims one upgrade moment for this account. POST is intentional: claiming is the durable
 * once-only write, and Route Handlers do not cache POST responses.
 */
export async function POST(request: Request) {
  const refused = sameOriginGuard(request);
  if (refused) return refused;
  try {
    const userId = await requireUserId();
    const event = await claimPendingPlanUpgrade(userId);
    return Response.json({ event });
  } catch (error) {
    // 401 signed out, 403 suspended, otherwise a reported 500 carrying only a reference.
    return routeError(error, { fallback: "Couldn’t load the plan upgrade", where: "route.plan-upgrades.claim" });
  }
}
