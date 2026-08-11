"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import {
  TOUR_NAV_CORE,
  TOUR_NAV_EXTRAS,
  type TourNavKey,
} from "@/components/onboarding/tour-config";
import { OrbitLogo } from "@/components/orbit-logo";

function NavItem({
  item,
  active,
  reducedMotion,
}: {
  item: (typeof TOUR_NAV_CORE)[number] | (typeof TOUR_NAV_EXTRAS)[number];
  active: boolean;
  reducedMotion?: boolean;
}) {
  const Icon = item.icon;
  return (
    <div
      className={cn(
        "relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-colors",
        active ? "text-sidebar-accent-foreground" : "text-muted-foreground"
      )}
    >
      {active && (
        <motion.div
          layoutId={reducedMotion ? undefined : "tour-nav-pill"}
          className="absolute inset-0 rounded-xl bg-white/70 shadow-sm ring-1 ring-black/[0.04] dark:bg-white/10 dark:ring-white/10"
          transition={
            reducedMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 380, damping: 32 }
          }
        />
      )}
      <Icon className="relative z-10 h-3.5 w-3.5 shrink-0" />
      <span className="relative z-10 font-medium">{item.label}</span>
    </div>
  );
}

export function TourSidebar({
  activeKey,
  reducedMotion,
}: {
  activeKey: TourNavKey | null;
  reducedMotion?: boolean;
}) {
  return (
    <aside className="liquid-glass hidden w-48 shrink-0 flex-col p-3 sm:flex">
      <div className="mb-4 flex items-center gap-2.5 px-2 py-1.5">
        <div
          className={cn(
            "rounded-full transition-shadow",
            activeKey === "welcome" &&
              "ring-2 ring-primary ring-offset-2 ring-offset-transparent"
          )}
        >
          <OrbitLogo size="sm" />
        </div>
        <div className="min-w-0">
          <p className="font-[family-name:var(--font-display)] text-sm leading-none tracking-tight text-sidebar-primary">
            Orbit
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Network tracker
          </p>
        </div>
      </div>

      <nav className="relative flex flex-1 flex-col gap-0.5">
        {TOUR_NAV_CORE.map((item) => (
          <NavItem
            key={item.key}
            item={item}
            active={activeKey === item.key}
            reducedMotion={reducedMotion}
          />
        ))}

        <div className="my-2 flex items-center gap-2 px-2.5">
          <div className="h-px flex-1 bg-border/60" />
          <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground/80">
            Extras
          </span>
          <div className="h-px flex-1 bg-border/60" />
        </div>

        {TOUR_NAV_EXTRAS.map((item) => (
          <NavItem
            key={item.key}
            item={item}
            active={activeKey === item.key}
            reducedMotion={reducedMotion}
          />
        ))}
      </nav>
    </aside>
  );
}
