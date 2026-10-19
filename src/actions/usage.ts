"use server";

import { loadUsageSummary } from "@/lib/usage-summary";
import type { UsageSummary } from "@/lib/usage-summary-types";
import { defineAction } from "@/lib/input/action";

/** The signed-in user's own last 30 days of AI calls. Never another account's. */
export const getMyAiUsage = defineAction(
  {},
  async (userId): Promise<UsageSummary> => {
    return loadUsageSummary(userId);
  }
);
