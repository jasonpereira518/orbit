"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AiAccessDenial, ManagedOutage } from "@/lib/managed-ai-policy";
import { PLAN_CONFIG, type Plan, type PlanConfig } from "@/lib/plans/plan-config";

/**
 * The signed-in account's plan, and whether this deployment can actually run included AI
 * (it holds at least one managed key). Provided once by the (app) layout, which reads both on
 * the server, so client notices can pitch the right thing: "Pro and Max include AI" only to a
 * Free account, Max only to a Pro account, and never included AI a deployment would
 * then refuse.
 *
 * It also carries the settings-level AI denial (why AI cannot run, short of credits), why
 * Orbit's own AI is off when it is (paused, or out of budget until a date), and when this
 * account's monthly credits refill, so a notice can say which, and when.
 */
export type ViewerPlan = {
  plan: Plan;
  includedAiAvailable: boolean;
  /** Why AI cannot run, short of credits (key presence plus Orbit's AI being off); null = it would run. */
  aiReason: AiAccessDenial | null;
  /** Why Orbit's own AI is off for everyone right now, or null while it runs. */
  aiOutage: ManagedOutage | null;
  /** When this account's monthly credits refill (ISO), or null when the plan has none. */
  creditsResetAt: string | null;
  /**
   * The EFFECTIVE plan table (`getEffectivePlanConfig()`: code defaults plus the operator's
   * plan rules), so client copy — "available on …", plan cards, upgrade pitches — says what
   * the gates actually enforce. Not secret: it is what /pricing publishes.
   */
  planConfig: Record<Plan, PlanConfig>;
};

const ViewerPlanContext = createContext<ViewerPlan>({
  plan: "free",
  includedAiAvailable: false,
  aiReason: null,
  aiOutage: null,
  creditsResetAt: null,
  planConfig: PLAN_CONFIG,
});

export function ViewerPlanProvider({ value, children }: { value: ViewerPlan; children: ReactNode }) {
  return <ViewerPlanContext.Provider value={value}>{children}</ViewerPlanContext.Provider>;
}

export function useViewerPlan(): ViewerPlan {
  return useContext(ViewerPlanContext);
}
