"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { APP_NAV, isNavActive } from "@/components/layout/app-nav";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { clerkAppearance } from "@/lib/clerk-appearance";

export function AppSidebar({
  pathname,
  clerkOn,
  demoMode,
}: {
  pathname: string;
  clerkOn: boolean;
  demoMode: boolean;
}) {
  return (
    <aside className="flex h-full w-[4.5rem] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:w-60">
      <div className="flex items-center justify-between gap-2 px-3 py-5 lg:px-5 lg:py-6">
        <Link
          href="/"
          className="flex min-w-0 flex-1 items-center justify-center gap-2.5 lg:justify-start"
          title="Back to landing page"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
            O
          </div>
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
            "bg-primary text-primary-foreground hover:bg-primary/90"
          )}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden lg:inline">Log interaction</span>
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-1.5 lg:px-2">
        {APP_NAV.map((item) => {
          const active = isNavActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={cn(
                "flex items-center justify-center gap-2.5 rounded-lg px-2 py-2.5 text-sm transition-colors lg:justify-start lg:px-3 lg:py-2",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="hidden lg:inline">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-2 lg:p-4">
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
