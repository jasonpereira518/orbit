"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { UserButton } from "@clerk/nextjs";
import {
  APP_NAV,
  MOBILE_BOTTOM_NAV,
  MOBILE_MORE_NAV,
  isNavActive,
} from "@/components/layout/app-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { clerkAppearance } from "@/lib/clerk-appearance";

export function MobileNav({
  clerkOn,
  demoMode,
}: {
  clerkOn: boolean;
  demoMode: boolean;
}) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  const moreActive = MOBILE_MORE_NAV.some((item) =>
    isNavActive(pathname, item.href)
  );

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border/80 bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        aria-label="Main navigation"
      >
        <ul className="mx-auto flex max-w-lg items-stretch justify-around px-1 pt-1">
          {MOBILE_BOTTOM_NAV.map((item) => {
            if ("id" in item && item.id === "more") {
              const Icon = item.icon;
              return (
                <li key="more" className="flex-1">
                  <button
                    type="button"
                    onClick={() => setMoreOpen(true)}
                    className={cn(
                      "flex w-full flex-col items-center gap-0.5 rounded-xl px-1 py-2 text-[10px] font-medium transition-colors",
                      moreActive
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="h-5 w-5" aria-hidden />
                    <span>{item.label}</span>
                  </button>
                </li>
              );
            }

            const navItem = item as (typeof APP_NAV)[number];
            const active = isNavActive(pathname, navItem.href);
            const Icon = navItem.icon;
            const isCapture = navItem.href === "/capture";

            return (
              <li key={navItem.href} className="flex-1">
                <Link
                  href={navItem.href}
                  className={cn(
                    "flex w-full flex-col items-center gap-0.5 rounded-xl px-1 py-2 text-[10px] font-medium transition-colors",
                    active
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground",
                    isCapture && "-mt-3"
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center justify-center",
                      isCapture &&
                        "h-11 w-11 rounded-full bg-primary text-primary-foreground shadow-md"
                    )}
                  >
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span>{navItem.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
          </SheetHeader>

          <nav className="flex flex-col gap-1 px-1 py-2">
            {MOBILE_MORE_NAV.map((item) => {
              const active = isNavActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors",
                    active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                  )}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="mt-4 flex items-center justify-between border-t border-border/70 px-3 py-4">
            <div className="flex items-center gap-3">
              {clerkOn ? (
                <>
                  <UserButton appearance={clerkAppearance} />
                  <span className="text-sm text-muted-foreground">Account</span>
                </>
              ) : demoMode ? (
                <p className="text-xs text-muted-foreground">
                  Demo mode — add Clerk keys to enable auth
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Sign in required</p>
              )}
            </div>
            <ThemeToggle className="h-9 w-9 text-muted-foreground hover:text-foreground" />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
