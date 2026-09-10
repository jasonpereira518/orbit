"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { ADMIN_NAV, isAdminNavActive } from "@/components/admin/admin-nav";
import { AdminUtilityBar } from "@/components/admin/admin-utility-bar";
import { cn } from "@/lib/utils";

/**
 * The operator console's frame.
 *
 * Deliberately NOT `AppShell`. That component mounts AvatarBackfill, ImportJobWatcher,
 * DueNotificationsWatcher, GlobalJobProgressBar and the ⌘K FloatingAskBar — all of which
 * read or mutate *Jason's own* data. A progress bar for his import, or an ask-bar that
 * answers questions about his network, on a page rendering someone else's account, is a
 * mis-attribution bug waiting to happen.
 *
 * Visual language: same Orbit tokens, inverted type logic. Fraunces appears on the page
 * h1 and nowhere else — every number is sans-serif `tabular-nums`, because proportional
 * serif digits do not align in a column, and because a big serif number in the product is
 * celebratory while a number here is evidence.
 */
export function AdminShell({
  children,
  adminEmail,
}: {
  children: React.ReactNode;
  adminEmail?: string | null;
}) {
  const pathname = usePathname();

  return (
    <div className="min-h-dvh bg-background text-sm lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="hidden min-h-dvh border-r border-border/70 bg-sidebar lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <div className="h-0.5 w-full bg-tier-lifetime" aria-hidden />
        <div className="flex items-center px-5 py-5">
          <Link href="/admin" className="flex items-center gap-2.5">
            <span className="font-[family-name:var(--font-display)] text-base text-primary">Orbit</span>
            <span className="rounded-md border border-tier-lifetime/40 bg-tier-lifetime/10 px-1.5 py-0.5 text-xs font-medium uppercase tracking-widest text-tier-lifetime">Admin</span>
          </Link>
        </div>

        <nav className="px-3" aria-label="Admin console">
          <ul className="space-y-1">
            {ADMIN_NAV.map((item) => {
              const active = isAdminNavActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-fast",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-[0_5px_16px_-12px_rgba(26,28,26,0.55)]"
                        : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                    )}
                  >
                    <item.icon className="size-4" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="mt-auto border-t border-border/70 p-3">
          <Link
            href="/dashboard"
            className="flex items-center justify-between rounded-lg px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
          >
            Open Orbit
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm">
          <div className="flex items-center gap-3 overflow-x-auto border-b border-border/70 px-4 py-2 lg:hidden">
            <Link href="/admin" className="mr-2 flex shrink-0 items-center gap-2">
              <span className="font-[family-name:var(--font-display)] text-base text-primary">Orbit</span>
              <span className="rounded-md border border-tier-lifetime/40 bg-tier-lifetime/10 px-1.5 py-0.5 text-xs uppercase tracking-widest text-tier-lifetime">Admin</span>
            </Link>
            {ADMIN_NAV.map((item) => {
              const active = isAdminNavActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "shrink-0 rounded-lg px-2 py-1 text-xs",
                    active ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
          <AdminUtilityBar adminEmail={adminEmail} />
        </header>

        <main className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
