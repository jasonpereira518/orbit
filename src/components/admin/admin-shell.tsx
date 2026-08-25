"use client";

import Link from "next/link";
import { ADMIN_THEME_CLASS } from "@/components/admin/theme";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import { ADMIN_NAV, isAdminNavActive } from "@/components/admin/admin-nav";
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
  /** A server-rendered node, not a string — it streams in behind its own Suspense
   *  boundary so the shell never waits on Clerk to paint. See `(admin)/layout.tsx`. */
  adminEmail?: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className={cn(ADMIN_THEME_CLASS, "min-h-dvh bg-background text-sm")}>
      {/* Mode signal. A solid black hairline against a white page — peripheral vision
          catches it before a word has been read, and unlike the accent it costs nothing
          from the two-colour budget. (This was described as gold for a long time. It was
          never gold: it pointed at `--accent`, which renders teal.) */}
      <div aria-hidden className="h-0.5 w-full bg-foreground" />

      <header className="sticky top-0 z-30 border-b border-border/70 bg-card/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1400px] items-center gap-6 px-6 py-3">
          <Link href="/admin" className="flex items-center gap-2">
            <span className="text-base font-medium tracking-tight text-primary">
              Orbit
            </span>
            <span className="rounded border border-border px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-widest text-muted-foreground">
              Admin
            </span>
          </Link>

          <nav className="flex items-center gap-1">
            {ADMIN_NAV.map((item) => {
              const active = isAdminNavActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative rounded-lg px-3 py-1.5 text-sm transition-colors duration-fast",
                    active
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="admin-nav-pill"
                      className="absolute inset-0 rounded-lg bg-muted"
                      transition={{ type: "spring", stiffness: 400, damping: 34 }}
                    />
                  )}
                  <span className="relative flex items-center gap-1.5">
                    <item.icon className="size-3.5" aria-hidden />
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
            {adminEmail}
            <Link
              href="/dashboard"
              className="flex items-center gap-1 rounded-lg border border-border/70 px-2 py-1 transition-colors duration-fast hover:text-foreground"
            >
              Open app
              <ArrowUpRight className="size-3" aria-hidden />
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-6 py-6">{children}</main>
    </div>
  );
}
