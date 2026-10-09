"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";
import type { Plan } from "@/lib/plans/plan-config";

/**
 * The signed-in account's plan, and whether this deployment can actually run included AI
 * (it holds at least one managed key). Provided once by the (app) layout, which reads both on
 * the server, so client notices can pitch the right thing: "Pro and Max include AI" only to a
 * Free account, a pack or Max only to a Pro or Max account, and never included AI a
 * deployment would then refuse.
 *
 * It also carries the settings-level AI denial (why AI cannot run, short of credits) and when
 * this account's monthly credits refill, so a notice can say "they refill on November 1".
 */
export type ViewerPlan = {
  plan: Plan;
  includedAiAvailable: boolean;
  /** Why AI cannot run, from settings alone (no credits); null = it would run. */
  aiReason: AiAccessDenial | null;
  /** When this account's monthly credits refill (ISO), or null when the plan has none. */
  creditsResetAt: string | null;
};

const ViewerPlanContext = createContext<ViewerPlan>({ plan: "free", includedAiAvailable: false, aiReason: null, creditsResetAt: null });

export function ViewerPlanProvider({ value, children }: { value: ViewerPlan; children: ReactNode }) {
  return <ViewerPlanContext.Provider value={value}>{children}</ViewerPlanContext.Provider>;
}

export function useViewerPlan(): ViewerPlan {
  return useContext(ViewerPlanContext);
}
