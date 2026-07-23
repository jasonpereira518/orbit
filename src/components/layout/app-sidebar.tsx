"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { motion, useReducedMotion } from "motion/react";
import {
  APP_NAV_CORE,
  APP_NAV_EXTRAS,
  APP_NAV_SETTINGS,
  isNavActive,
  type AppNavItem,
} from "@/components/layout/app-nav";
import { OrbitLogo } from "@/components/orbit-logo";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { clerkAppearance } from "@/lib/clerk-appearance";

function SidebarNavLink({
  item,
  pathname,
  reducedMotion,
}: {
  item: AppNavItem;
  pathname: string;
  reducedMotion: boolean | null;
}) {
  const active = isNavActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={item.label}
      className={cn(
        "relative flex items-center justify-center gap-2.5 rounded-xl px-2 py-2.5 text-sm transition-colors lg:justify-start lg:px-3 lg:py-2",
        active
          ? "text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-white/45 hover:text-foreground dark:hover:bg-white/8"
      )}
    >
      {active && (
        <motion.span
          layoutId={reducedMotion ? undefined : "app-nav-pill"}
          className="absolute inset-0 rounded-xl bg-white/70 shadow-sm ring-1 ring-black/[0.04] dark:bg-white/10 dark:ring-white/10"
          transition={
            reducedMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 380, damping: 32 }
          }
        />
      )}
      <Icon className="relative z-10 h-4 w-4 shrink-0" />
      <span className="relative z-10 hidden lg:inline">{item.label}</span>
    </Link>
  );
}

export function AppSidebar({
  pathname,
  clerkOn,
  demoMode,
}: {
  pathname: string;
  clerkOn: boolean;
  demoMode: boolean;
}) {
  const reducedMotion = useReducedMotion();

  return (
    <aside className="liquid-glass flex h-full w-[4.5rem] flex-col text-sidebar-foreground lg:w-60">
      <div className="flex items-center justify-between gap-2 px-3 py-5 lg:px-5 lg:py-6">
        <Link
          href="/"
          className="flex min-w-0 flex-1 items-center justify-center gap-2.5 lg:justify-start"
          title="Back to landing page"
        >
          <OrbitLogo size="md" />
          <div className="hidden min-w-0 lg:block">
            <p className="font-[family-name:var(--font-display)] text-lg leading-none tracking-tight text-sidebar-primary">
              Orbit
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Network tracker
            </p>
          </div>
        </Link>
        <ThemeToggle className="hidden h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground lg:inline-flex" />
      </div>

      <div className="px-2 pb-3 lg:px-3">
        <Link
          href="/capture"
          title="Log interaction"
          className={cn(
            buttonVariants({ size: "icon" }),
            "mx-auto flex h-10 w-10 lg:h-auto lg:w-full lg:justify-start lg:gap-2 lg:px-3 lg:py-2",
            "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
          )}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden lg:inline">Log interaction</span>
        </Link>
      </div>

      <nav className="relative flex flex-1 flex-col gap-0.5 px-1.5 lg:px-2">
        {APP_NAV_CORE.map((item) => (
          <SidebarNavLink
            key={item.href}
            item={item}
            pathname={pathname}
            reducedMotion={reducedMotion}
          />
        ))}

        <div className="my-2 flex items-center gap-2 px-2 lg:px-3">
          <div className="h-px flex-1 bg-border/60" />
          <span className="hidden text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80 lg:inline">
            Extras
          </span>
          <div className="hidden h-px flex-1 bg-border/60 lg:block" />
        </div>

        {APP_NAV_EXTRAS.map((item) => (
          <SidebarNavLink
            key={item.href}
            item={item}
            pathname={pathname}
            reducedMotion={reducedMotion}
          />
        ))}

        <div className="mt-2">
          <SidebarNavLink
            item={APP_NAV_SETTINGS}
            pathname={pathname}
            reducedMotion={reducedMotion}
          />
        </div>
      </nav>

      <div className="mx-2 mb-2 mt-auto border-t border-black/[0.06] p-2 dark:border-white/10 lg:mx-3 lg:mb-3 lg:p-3">
        {clerkOn ? (
          <div className="flex items-center justify-center gap-3 lg:justify-start">
            <UserButton appearance={clerkAppearance} />
            <span className="hidden text-xs text-muted-foreground lg:inline">
              Account
            </span>
          </div>
        ) : demoMode ? (
          <p className="hidden text-xs text-muted-foreground lg:block">
            Demo mode — add Clerk keys to enable auth
          </p>
        ) : (
          <p className="hidden text-xs text-muted-foreground lg:block">
            Sign in required
          </p>
        )}
      </div>
    </aside>
  );
}
