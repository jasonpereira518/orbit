"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { TOUR_NAV, type TourNavKey } from "@/components/onboarding/tour-config";
import { OrbitLogo } from "@/components/orbit-logo";

export function TourSidebar({
  activeKey,
  reducedMotion,
}: {
  activeKey: TourNavKey | null;
  reducedMotion?: boolean;
}) {
  return (
    <aside className="hidden w-44 shrink-0 flex-col rounded-2xl border border-border/70 bg-sidebar p-3 sm:flex">
      <div className="mb-4 flex items-center gap-2 px-2 py-1">
        <div
          className={cn(
            "rounded-full",
            activeKey === "welcome" &&
              "ring-2 ring-primary ring-offset-2 ring-offset-sidebar"
          )}
        >
          <OrbitLogo size="sm" />
        </div>
        <div>
          <p className="font-[family-name:var(--font-display)] text-sm leading-none text-sidebar-primary">
            Orbit
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">Tour</p>
        </div>
      </div>

      <nav className="relative flex flex-1 flex-col gap-0.5">
        {TOUR_NAV.map((item) => {
          const Icon = item.icon;
          const active = activeKey === item.key;
          return (
            <div
              key={item.key}
              className={cn(
                "relative flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors",
                active
                  ? "text-sidebar-accent-foreground"
                  : "text-muted-foreground"
              )}
            >
              {active && (
                <motion.div
                  layoutId={reducedMotion ? undefined : "tour-nav-pill"}
                  className="absolute inset-0 rounded-lg bg-sidebar-accent shadow-sm"
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 380, damping: 32 }
                  }
                />
              )}
              <Icon className="relative z-10 h-3.5 w-3.5" />
              <span className="relative z-10 font-medium">{item.label}</span>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
