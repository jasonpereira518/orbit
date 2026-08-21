import { requireUserId } from "@/lib/auth";
import { requireEntitlement } from "@/lib/entitlements";

/**
 * Auth + plan in one call, so gated server actions keep the same one-line preamble the
 * ungated ones have (`const userId = await requireUserId()`).
 *
 * Server Functions are reachable by direct POST, not only through Orbit's own UI, so these
 * — not the hidden nav items — are the real paywall boundary.
 */
export async function requireOutreachUser() {
  const userId = await requireUserId();
  await requireEntitlement(userId, "outreach");
  return userId;
}

export async function requireRecruitersUser() {
  const userId = await requireUserId();
  await requireEntitlement(userId, "recruiters");
  return userId;
}

export async function requireSyncUser() {
  const userId = await requireUserId();
  await requireEntitlement(userId, "sync");
  return userId;
}
