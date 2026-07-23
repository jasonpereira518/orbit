"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { OrbitLogo } from "@/components/orbit-logo";
import { DueNotificationsWatcher } from "@/components/notifications/due-notifications-watcher";
import { ImportJobWatcher } from "@/components/imports/import-job-watcher";
import { NotificationsPanelButton } from "@/components/notifications/notifications-panel";
import { ThemeSync } from "@/components/theme-sync";
import { cn } from "@/lib/utils";
import type { ThemePreference } from "@/lib/theme";

const FloatingAskBar = dynamic(
  () =>
    import("@/components/layout/floating-ask-bar").then((m) => ({
      default: m.FloatingAskBar,
    })),
  { ssr: false }
);

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
  const isChat = pathname === "/chat";
  const isSettings =
    pathname === "/settings" || pathname.startsWith("/settings/");
  const isConstellation =
    pathname === "/graph" || pathname.startsWith("/graph/");
  const showAskBar =
    !isOnboarding && !isChat && !isSettings && !isConstellation;

  if (isOnboarding) {
    return (
      <div className="min-h-screen bg-background">
        <ThemeSync theme={theme} />
        {children}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex bg-background",
        isChat ? "h-dvh overflow-hidden" : "min-h-screen"
      )}
    >
      <ThemeSync theme={theme} />
      <DueNotificationsWatcher />
      <ImportJobWatcher />
      <div className="sticky top-0 z-40 hidden h-dvh shrink-0 p-3 md:block lg:p-4">
        <AppSidebar pathname={pathname} clerkOn={clerkOn} demoMode={demoMode} />
      </div>
      <main
        className={cn(
          "relative flex min-h-0 flex-1 flex-col",
          isChat ? "h-dvh overflow-hidden" : "min-h-screen overflow-auto"
        )}
      >
        <header className="z-30 flex shrink-0 items-center justify-between border-b border-border/70 bg-background/95 px-4 py-3 backdrop-blur md:hidden">
          <Link href="/" className="flex items-center gap-2.5" title="Back to landing page">
            <OrbitLogo size="md" />
            <span className="font-[family-name:var(--font-display)] text-lg leading-none text-primary">
              Orbit
            </span>
          </Link>
          <NotificationsPanelButton />
        </header>

        <div className="fixed right-5 top-5 z-30 hidden md:right-8 md:top-6 md:block">
          <NotificationsPanelButton />
        </div>

        <div
          className={cn(
            "mx-auto w-full max-w-6xl px-4 py-6 md:px-10 md:py-8",
            isChat
              ? "min-h-0 flex-1 overflow-hidden pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-8"
              : isSettings || isConstellation
                ? "flex-1 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-8"
                : "flex-1 pb-[calc(9.5rem+env(safe-area-inset-bottom))] md:pb-24"
          )}
        >
          {children}
        </div>

        {showAskBar && <FloatingAskBar />}
        <MobileNav clerkOn={clerkOn} demoMode={demoMode} />
      </main>
    </div>
  );
}
