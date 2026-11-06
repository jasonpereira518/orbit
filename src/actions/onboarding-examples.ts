"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { removeTourExamples } from "@/lib/onboarding-examples/remove";
import { ensureUserSettings } from "@/lib/user-settings";

/**
 * Removes the tour's example people on request — the finish card's retry and the dashboard
 * card both land here. The tour's own exit and finish call the lib directly.
 */
export async function removeOnboardingExamples() {
  const userId = await requireUserId();
  const settings = await ensureUserSettings(userId);
  const { removed } = await removeTourExamples(userId, { since: settings.tourStartedAt });
  for (const path of ["/dashboard", "/contacts", "/reminders", "/graph", "/chat", "/settings"]) {
    revalidatePath(path);
  }
  return { ok: true as const, removed };
}
