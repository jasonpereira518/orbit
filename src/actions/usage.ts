"use server";

import { requireUserId } from "@/lib/auth";
import { bucketCount, RATE_LIMITS } from "@/lib/rate-limit";
import { loadUsageSummary } from "@/lib/usage-summary";
import { WEB_SEARCH_SCOPE, webSearchMonthKey } from "@/lib/web-search-budget";
import type { UsageSummary } from "@/lib/usage-summary-types";

/** The signed-in user's own last 30 days of AI calls. Never another account's. */
export async function getMyAiUsage(): Promise<UsageSummary> {
  const userId = await requireUserId();
  const policy = RATE_LIMITS.webSearchMonthly;
  const [summary, used] = await Promise.all([
    loadUsageSummary(userId),
    bucketCount(WEB_SEARCH_SCOPE, webSearchMonthKey(userId, new Date()), policy),
  ]);
  return { ...summary, webSearches: { used, limit: policy.limit } };
}
