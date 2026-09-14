import { isAdminUser } from "@/lib/admin";
import { getEntitlements } from "@/lib/entitlements";
import { UserFacingError } from "@/lib/errors";
import { requireOutreachUser } from "@/lib/plan-guards";
import { isSurfaceVisible, isViewingAsUser } from "@/lib/surface-visibility";

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

/**
 * `requireOutreachNextUser`'s three checks — plan, the Outreach page surface, this gate — as
 * a boolean, for read paths that should show nothing rather than throw (Settings' research
 * section). Keep the two in step: a read that checks less than the mutations behind it shows
 * people controls they can't use, and can create state (a credit account) just by rendering.
 */
export async function canUseOutreachNext(userId: string): Promise<boolean> {
  const [entitlements, surfaceVisible, gateOpen] = await Promise.all([
    getEntitlements(userId),
    isSurfaceVisible(userId, "page.outreach"),
    isOutreachNextEnabled(userId),
  ]);
  return entitlements.canUseOutreach && surfaceVisible && gateOpen;
}
