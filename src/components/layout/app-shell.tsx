"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MotionConfig } from "motion/react";
import { AppSidebar } from "@/components/layout/app-sidebar";
// Canvas-only decoration: no reason for its code to be in the shell's first load, and it
// renders nothing on the server anyway.
const AppStarfield = dynamic(
  () => import("@/components/layout/app-starfield").then((m) => m.AppStarfield),
  { ssr: false }
);
import { MobileNav } from "@/components/layout/mobile-nav";
import { ViewAsUserBanner } from "@/components/layout/view-as-user-banner";
import { OrbitLogo } from "@/components/orbit-logo";
import { AvatarBackfill } from "@/components/contacts/avatar-backfill";
import { DueNotificationsWatcher } from "@/components/notifications/due-notifications-watcher";
import { PlanCelebrationWatcher } from "@/components/celebration/plan-celebration-watcher";
import { ImportJobWatcher } from "@/components/imports/import-job-watcher";
import { GlobalJobProgressBar } from "@/components/jobs/global-job-progress-bar";
import { NotificationsPanelButton } from "@/components/notifications/notifications-panel";
import { FeedbackTrigger } from "@/components/feedback/feedback-trigger";
import { ThemeSync } from "@/components/theme-sync";
import { FEEDBACK_SURFACE_KEY } from "@/lib/surfaces";
import { cn } from "@/lib/utils";
import { useMemo } from "react";
import type { Plan } from "@/lib/plan-limits";
import type { ThemePreference } from "@/lib/theme";

const FloatingAskBar = dynamic(
  () =>
    import("@/components/layout/floating-ask-bar").then((m) => ({
      default: m.FloatingAskBar,
    })),
  { ssr: false },
);

export function AppShell({
  children,
  clerkOn,
  demoMode,
  theme,
  plan,
  hidden,
  hiddenForUsers,
  viewingAsUser,
}: {
  children: React.ReactNode;
  clerkOn: boolean;
  demoMode: boolean;
  theme: ThemePreference | null;
  plan: Plan;
  /** Surface keys hidden from THIS viewer. Empty for an exempt operator. */
  hidden: string[];
  /** Surface keys hidden from ordinary users, for the operator's "Hidden" tags. */
  hiddenForUsers: string[];
  viewingAsUser: boolean;
}) {
  const pathname = usePathname();
  // Arrays cross the server boundary; the nav does membership tests, so build the sets
  // once here rather than in each consumer on every render.
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const hiddenForUsersSet = useMemo(
    () => new Set(hiddenForUsers),
    [hiddenForUsers]
  );
  const isOnboarding = pathname === "/onboarding";
  const isChat = pathname === "/chat";
  const isSettings =
    pathname === "/settings" || pathname.startsWith("/settings/");
  const isConstellation =
    pathname === "/graph" || pathname.startsWith("/graph/");
  const isViewportLocked = isChat || isConstellation;
  // The ask bar is not a link to /chat — it calls `askNetwork` inline, so it IS chat.
  // Hiding the Chat page while leaving the bar up would leave the feature fully reachable
  // from every screen, which is the whole thing hiding is supposed to prevent.
  const showAskBar =
    !isOnboarding &&
    !isChat &&
    !isSettings &&
    !isConstellation &&
    !hiddenSet.has("page.chat");

  if (isOnboarding) {
    return (
      <MotionConfig reducedMotion="user">
        <div className="min-h-screen bg-background">
          <ThemeSync theme={theme} />
          {children}
        </div>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      {/* data-warp-craft: the thing that drops away on lift-off and takes
          the touchdown judder on re-entry. Driven by `html[data-warp]` in
          globals.css so the server layout needs no knowledge of the journey. */}
      {/* Transparent in dark so the portalled starfield behind this tree
          shows through; the body still paints `--background` either way. */}
      <div className="flex h-dvh flex-col">
        {viewingAsUser && (
          <ViewAsUserBanner hiddenCount={hiddenForUsersSet.size} />
        )}
        <div
          data-warp-craft
          className="flex min-h-0 flex-1 overflow-hidden bg-background dark:bg-transparent"
        >
          <ThemeSync theme={theme} />
          <AppStarfield />
          <AvatarBackfill />
          <DueNotificationsWatcher />
          <PlanCelebrationWatcher plan={plan} />
          <ImportJobWatcher />
          <GlobalJobProgressBar />
          <div
            className="hidden h-full shrink-0 p-3 md:block lg:p-4"
            style={{ viewTransitionName: "app-sidebar" }}
          >
            <AppSidebar
              pathname={pathname}
              clerkOn={clerkOn}
              demoMode={demoMode}
              plan={plan}
              hidden={hiddenSet}
              hiddenForUsers={hiddenForUsersSet}
            />
          </div>
          <main
            className={cn(
              "relative flex h-full min-h-0 flex-1 flex-col",
              isViewportLocked
                ? "overflow-hidden"
                : "overflow-y-auto overscroll-contain",
            )}
          >
            <header
              className="z-30 flex shrink-0 items-center justify-between border-b border-border/70 bg-background/95 px-4 py-3 backdrop-blur md:hidden"
              style={{ viewTransitionName: "app-mobile-header" }}
            >
              <Link
                href="/"
                className="flex items-center gap-2.5"
                title="Back to landing page"
              >
                <span data-app-logo className="inline-flex shrink-0">
                  <OrbitLogo size="md" plan={plan} />
                </span>
                <span className="font-[family-name:var(--font-display)] text-lg leading-none text-ink">
                  Orbit
                </span>
              </Link>
              {/* The feedback widget is a sibling of this shell and cannot render into
                  this header, so its mobile copy is mounted here and talks to the widget
                  through `src/lib/feedback-events.ts`. Gated on the same surface key the
                  widget itself is, or it asks a component that is not mounted to open.

                  Left of the bell: the bell is the more-used control and keeps the outer
                  corner, matching the desktop rail where feedback sits below it. */}
              <div className="flex items-center gap-2">
                {!hiddenSet.has(FEEDBACK_SURFACE_KEY) && <FeedbackTrigger />}
                <NotificationsPanelButton />
              </div>
            </header>

            <div
              className={cn(
                "fixed right-5 z-30 hidden md:right-8 md:block",
                // The preview banner is in the layout flow but this button is fixed to the
                // viewport, so it has to step down out from under it by hand.
                viewingAsUser ? "top-12" : "top-5 md:top-6"
              )}
            >
              <NotificationsPanelButton />
            </div>

            <div
              className={cn(
                "mx-auto flex w-full max-w-6xl flex-col px-4 py-6 md:px-10 md:py-8",
                isViewportLocked
                  ? "min-h-0 flex-1 overflow-hidden pb-[calc(5.25rem+env(safe-area-inset-bottom))] md:pb-8"
                  : isSettings
                    ? "flex-1 pb-[calc(5.25rem+env(safe-area-inset-bottom))] md:pb-8"
                    : "flex-1 pb-[calc(10.25rem+env(safe-area-inset-bottom))] md:pb-24",
                isConstellation && "py-4 md:py-5",
              )}
            >
              {children}
            </div>

            {showAskBar && <FloatingAskBar />}
            <MobileNav
              clerkOn={clerkOn}
              demoMode={demoMode}
              hidden={hiddenSet}
            />
          </main>
        </div>
      </div>
    </MotionConfig>
  );
}
