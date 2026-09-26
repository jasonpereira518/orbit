"use server";

import { requireUserId } from "@/lib/auth";
import { loadUsageSummary } from "@/lib/usage-summary";
import type { UsageSummary } from "@/lib/usage-summary-types";

/** The signed-in user's own last 30 days of AI calls. Never another account's. */
export async function getMyAiUsage(): Promise<UsageSummary> {
  const userId = await requireUserId();
  return loadUsageSummary(userId);
}
