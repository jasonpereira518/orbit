"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Plan } from "@/lib/plans/plan-config";

/**
 * The signed-in account's plan, and whether this deployment can actually run included AI
 * (it holds at least one managed key). Provided once by the (app) layout, which reads both on
 * the server, so client notices can pitch the right thing: "Pro and Max include AI" only to a
 * Free account, a pack or Max only to a Pro or Max account, and never included AI a
 * deployment would then refuse.
 */
export type ViewerPlan = { plan: Plan; includedAiAvailable: boolean };

const ViewerPlanContext = createContext<ViewerPlan>({ plan: "free", includedAiAvailable: false });

export function ViewerPlanProvider({ value, children }: { value: ViewerPlan; children: ReactNode }) {
  return <ViewerPlanContext.Provider value={value}>{children}</ViewerPlanContext.Provider>;
}

export function useViewerPlan(): ViewerPlan {
  return useContext(ViewerPlanContext);
}
