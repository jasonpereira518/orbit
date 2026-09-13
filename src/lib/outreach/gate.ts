import { isAdminUser } from "@/lib/admin";
import { UserFacingError } from "@/lib/errors";
import { requireOutreachUser } from "@/lib/plan-guards";
import { isViewingAsUser } from "@/lib/surface-visibility";

/**
 * The generation-2 Outreach release gate (spec §4.1). FAILS CLOSED: unlike `app_surface_flags`,
 * which shows everything when the database hiccups, a missing env var or a lookup error here
 * leaves the new flow dark. It sends real email from real mailboxes, so dark is the safe side.
 */
export function outreachNextFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OUTREACH_NEXT === "on";
}

export async function isOutreachNextEnabled(userId: string): Promise<boolean> {
  if (outreachNextFlagOn()) return true;
  if (!isAdminUser(userId)) return false;
  try {
    return !(await isViewingAsUser(userId));
  } catch {
    return false;
  }
}

/** For server actions: plan + page surface (`requireOutreachUser`) + this gate. */
export async function requireOutreachNextUser(): Promise<string> {
  const userId = await requireOutreachUser();
  if (!(await isOutreachNextEnabled(userId))) {
    throw new UserFacingError("This part of Outreach isn’t available yet");
  }
  return userId;
}
