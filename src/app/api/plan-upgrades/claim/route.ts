import {
  AccountSuspendedError,
  UnauthorizedError,
  requireUserId,
} from "@/lib/auth";
import { claimPendingPlanUpgrade } from "@/lib/plan-upgrade-events";
import { reportError } from "@/lib/report-error";

/**
 * Claims one upgrade moment for this account. POST is intentional: claiming is the durable
 * once-only write, and Route Handlers do not cache POST responses.
 */
export async function POST() {
  try {
    const userId = await requireUserId();
    const event = await claimPendingPlanUpgrade(userId);
    return Response.json({ event });
  } catch (error) {
    if (error instanceof AccountSuspendedError) {
      return Response.json({ error: "Account suspended" }, { status: 403 });
    }
    if (error instanceof UnauthorizedError) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const ref = reportError(error, { where: "route.plan-upgrades.claim" });
    return Response.json({ error: "Couldn’t load the plan upgrade", ref }, { status: 500 });
  }
}
