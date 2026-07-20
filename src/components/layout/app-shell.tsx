"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { DueNotificationsWatcher } from "@/components/notifications/due-notifications-watcher";
import { NotificationsPanelButton } from "@/components/notifications/notifications-panel";
import { ThemeSync } from "@/components/theme-sync";
import type { ThemePreference } from "@/lib/theme";

export function AppShell({
  children,
  clerkOn,
  demoMode,
  theme,
}: {
  children: React.ReactNode;
  clerkOn: boolean;
  demoMode: boolean;
  theme: ThemePreference | null;
}) {
  const pathname = usePathname();
  const isOnboarding = pathname === "/onboarding";

  if (isOnboarding) {
    return (
      <div className="min-h-screen bg-background">
        <ThemeSync theme={theme} />
        {children}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      <ThemeSync theme={theme} />
      <DueNotificationsWatcher />
      <div className="sticky top-0 hidden h-screen md:block">
        <AppSidebar pathname={pathname} clerkOn={clerkOn} demoMode={demoMode} />
      </div>
      <main className="relative flex min-h-screen flex-1 flex-col overflow-auto">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border/70 bg-background/95 px-4 py-3 backdrop-blur md:hidden">
          <Link href="/" className="flex items-center gap-2.5" title="Back to landing page">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
              O
            </div>
            <span className="font-[family-name:var(--font-display)] text-lg leading-none text-primary">
              Orbit
            </span>
          </Link>
          <NotificationsPanelButton />
        </header>

        <div className="fixed right-5 top-5 z-30 hidden md:right-8 md:top-6 md:block">
          <NotificationsPanelButton />
        </div>

        <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:px-10 md:py-8 md:pb-8">
          {children}
        </div>

        <MobileNav clerkOn={clerkOn} demoMode={demoMode} />
      </main>
    </div>
  );
}
