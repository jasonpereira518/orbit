"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { ArrowUpRight, Menu } from "lucide-react";
import { ADMIN_NAV, ADMIN_YC_NAV, isAdminNavActive } from "@/components/admin/admin-nav";
import { YCModeToggle } from "@/components/admin/yc-mode-toggle";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * The operator console's frame.
 *
 * Deliberately NOT `AppShell`. That component mounts AvatarBackfill, ImportJobWatcher,
 * DueNotificationsWatcher, GlobalJobProgressBar, the ⌘J FloatingAskBar and the ⌘K command
 * palette — all of which read or mutate *Jason's own* data. A progress bar for his import,
 * or an ask-bar that answers questions about his network, on a page rendering someone
 * else's account, is a mis-attribution bug waiting to happen.
 *
 * Visual language: same Orbit tokens, inverted type logic. Fraunces appears on the page
 * h1 and nowhere else — every number is sans-serif `tabular-nums`, because proportional
 * serif digits do not align in a column, and because a big serif number in the product is
 * celebratory while a number here is evidence.
 */
export function AdminShell({
  children,
  adminEmail,
  hiddenSurfaceCount = 0,
  unresolvedFeedbackCount = 0,
  ycMode = false,
}: {
  children: React.ReactNode;
  adminEmail?: string | null;
  /**
   * How many surfaces are currently hidden from users. Rides in the nav on EVERY admin
   * screen, not just /admin/product, because operators are exempt from their own toggles —
   * so without this the only visible trace of a forgotten one is on the page you would
   * already have to be looking at.
   */
  hiddenSurfaceCount?: number;
  unresolvedFeedbackCount?: number;
  ycMode?: boolean;
}) {
  const pathname = usePathname();
  const navItems = ycMode ? ADMIN_YC_NAV : ADMIN_NAV;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const badgeCount = hiddenSurfaceCount + unresolvedFeedbackCount;

  // Client-side navigation from a `Link` inside the sheet does not unmount it, so every row
  // closes the drawer itself on click; this is the fallback for back/forward navigation,
  // which doesn't go through one of those `onClick` handlers.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <div className={cn("min-h-dvh bg-background text-sm", ycMode && "yc-theme")}>
      {/* Mode signal. Gold is an existing Orbit token that is essentially unused in app
          chrome, so peripheral vision catches it before a word has been read. */}
      <div aria-hidden className="h-0.5 w-full bg-accent" />

      <header className="sticky top-0 z-30 border-b border-border/70 bg-card/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1400px] items-center gap-3 px-4 py-3 md:gap-6 md:px-6">
          <Link href="/admin" className="flex items-center gap-2">
            <span className="font-[family-name:var(--font-display)] text-base text-ink">
              Orbit
            </span>
            <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-widest text-accent-foreground">
              Admin
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => {
              const active = isAdminNavActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative rounded-lg px-3 py-1.5 text-sm transition-colors duration-fast",
                    active
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {active ? (
                    <motion.span
                      layoutId="admin-nav-pill"
                      className="absolute inset-0 rounded-lg bg-accent/12"
                      transition={{ type: "spring", stiffness: 400, damping: 34 }}
                    />
                  ) : (
                    <span
                      aria-hidden
                      className="absolute inset-0 rounded-lg bg-admin-nav-hover opacity-0 transition-opacity duration-fast group-hover:opacity-100"
                    />
                  )}
                  <span className="relative flex items-center gap-1.5">
                    <item.icon className="size-3.5" aria-hidden />
                    {item.label}
                    {item.href === "/admin/product" && hiddenSurfaceCount > 0 && (
                      <span
                        title={`${hiddenSurfaceCount} surface${hiddenSurfaceCount === 1 ? "" : "s"} hidden from users`}
                        className="rounded-full bg-accent/25 px-1.5 text-[0.625rem] font-medium tabular-nums text-accent-foreground"
                      >
                        {hiddenSurfaceCount}
                      </span>
                    )}
                    {/* Same reasoning as the hidden-surface badge: it rides on every screen
                        because otherwise the only trace of a backlog is on the page you
                        would already have to be looking at. */}
                    {item.href === "/admin/feedback" && unresolvedFeedbackCount > 0 && (
                      <span
                        title={`${unresolvedFeedbackCount} unresolved`}
                        className="rounded-full bg-accent/25 px-1.5 text-[0.625rem] font-medium tabular-nums text-accent-foreground"
                      >
                        {unresolvedFeedbackCount}
                      </span>
                    )}
                  </span>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto hidden items-center gap-4 text-xs text-muted-foreground md:flex">
            <YCModeToggle active={ycMode} />
            {adminEmail && (
              <span className="hidden sm:inline truncate max-w-[16rem]">
                {adminEmail}
              </span>
            )}
            <Link
              href="/dashboard"
              className="flex items-center gap-1 rounded-lg border border-border/70 px-2 py-1 transition-colors duration-fast hover:text-foreground"
            >
              Open app
              <ArrowUpRight className="size-3" aria-hidden />
            </Link>
          </div>

          <div className="ml-auto md:hidden">
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
              <SheetTrigger
                render={
                  <Button variant="ghost" size="icon" className="relative">
                    <Menu className="size-4" aria-hidden />
                    <span className="sr-only">Open admin navigation</span>
                    {badgeCount > 0 && (
                      <span
                        aria-hidden
                        className="absolute top-1 right-1 size-2 rounded-full bg-accent"
                      />
                    )}
                  </Button>
                }
              />
              <SheetContent side="right">
                <SheetHeader className="sr-only">
                  <SheetTitle>Admin navigation</SheetTitle>
                </SheetHeader>
                <nav className="flex flex-col gap-1 overflow-y-auto p-4 pt-10">
                  {navItems.map((item) => {
                    const active = isAdminNavActive(pathname, item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        onClick={() => setDrawerOpen(false)}
                        className={cn(
                          "flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors",
                          active
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                        )}
                      >
                        <item.icon className="size-4 shrink-0" aria-hidden />
                        {item.label}
                        {item.href === "/admin/product" && hiddenSurfaceCount > 0 && (
                          <span
                            title={`${hiddenSurfaceCount} surface${hiddenSurfaceCount === 1 ? "" : "s"} hidden from users`}
                            className="ml-auto rounded-full bg-accent/25 px-1.5 text-[0.625rem] font-medium tabular-nums text-accent-foreground"
                          >
                            {hiddenSurfaceCount}
                          </span>
                        )}
                        {item.href === "/admin/feedback" && unresolvedFeedbackCount > 0 && (
                          <span
                            title={`${unresolvedFeedbackCount} unresolved`}
                            className="ml-auto rounded-full bg-accent/25 px-1.5 text-[0.625rem] font-medium tabular-nums text-accent-foreground"
                          >
                            {unresolvedFeedbackCount}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </nav>
                <div className="mt-auto flex flex-col gap-3 border-t border-border/70 p-4">
                  <YCModeToggle active={ycMode} />
                  {adminEmail && (
                    <span className="truncate text-xs text-muted-foreground">
                      {adminEmail}
                    </span>
                  )}
                  <Link
                    href="/dashboard"
                    onClick={() => setDrawerOpen(false)}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors duration-fast hover:text-foreground"
                  >
                    Open app
                    <ArrowUpRight className="size-3.5" aria-hidden />
                  </Link>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-6">{children}</main>
    </div>
  );
}
