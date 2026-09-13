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
import { useSmallSky } from "@/components/graph/use-small-sky";
import { ViewAsUserBanner } from "@/components/layout/view-as-user-banner";
import { OrbitLogo } from "@/components/orbit-logo";
import { AvatarBackfill } from "@/components/contacts/avatar-backfill";
import { DueNotificationsWatcher } from "@/components/notifications/due-notifications-watcher";
import { PlanCelebrationWatcher } from "@/components/celebration/plan-celebration-watcher";
import { ImportJobWatcher } from "@/components/imports/import-job-watcher";
import { CaptureJobWatcher } from "@/components/capture/capture-job-watcher";
import { GlobalJobProgressBar } from "@/components/jobs/global-job-progress-bar";
import { CommandPalette } from "@/components/layout/command-palette";
import { Button } from "@/components/ui/button";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/lib/ask-bar-events";
import { Search } from "lucide-react";
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
  const smallSky = useSmallSky();
  // The ask bar is not a link to /chat — it calls `askNetwork` inline, so it IS chat.
  // Hiding the Chat page while leaving the bar up would leave the feature fully reachable
  // from every screen, which is the whole thing hiding is supposed to prevent.
  const showAskBar =
    !isOnboarding &&
    !isChat &&
    !isSettings &&
    !isConstellation &&
    !hiddenSet.has("page.chat");
  // Where the palette sends a typed question: the ask bar when it is on screen, /chat when
  // the page has no bar, and nowhere on /chat itself (its composer is already right there)
  // or when chat is hidden outright.
  const paletteAskMode = showAskBar
    ? "bar"
    : !isChat && !hiddenSet.has("page.chat")
      ? "chat"
      : null;

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
          {/*
            Not on the phone-sized constellation. That route already paints a full sky
            into its own canvas, and a second full-viewport canvas running its own rAF
            loop — 700 arcs a frame, some with `shadowBlur`, one of the most expensive
            Canvas2D operations on iOS — is exactly the pressure that was taking the tab
            down. It costs a flatter background around the stage card on those devices.
          */}
          {!(isConstellation && smallSky) && <AppStarfield />}
          <AvatarBackfill />
          <DueNotificationsWatcher />
          <PlanCelebrationWatcher plan={plan} />
          <ImportJobWatcher />
          <CaptureJobWatcher />
          <GlobalJobProgressBar />
          <CommandPalette hidden={hiddenSet} askMode={paletteAskMode} />
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
                {/* Phones have no ⌘K, so this is the palette's only door on one — and
                    jumping straight to a person is most of what it is for. */}
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Search"
                  // The same round glass as the feedback and bell buttons beside it.
                  className="size-10 rounded-full border-border/70 bg-background/90 shadow-md backdrop-blur-md hover:bg-background"
                  onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
                >
                  <Search className="h-4 w-4" />
                </Button>
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
              <NotificationsPanelButton tooltip />
            </div>

            <div
              className={cn(
                "mx-auto flex w-full max-w-6xl flex-col px-4 py-6 md:px-10 md:py-8",
                // Gutter for a page that floats a fixed rail over the right edge — the
                // contacts A-Z scrubber is the one that does. It is an opaque card, so
                // whatever it covers is gone, not dimmed. It publishes the variable only
                // while mounted, so every other route pays nothing. On the content column
                // rather than <main>, which also wraps the app header: insetting the logo
                // and bell on one route would make the header jump between pages.
                // The base padding is carried inside the calc rather than left to the
                // horizontal padding above: a right-padding utility set straight from the
                // variable OVERRIDES that padding, so every route without a rail lost its
                // right padding entirely and ran flush to the screen edge.
                //
                // Note the wording — no utility class is spelled out literally here. The
                // Tailwind scanner regex-matches candidates across the raw file, comments
                // included, so an example class written in prose is compiled for real. An
                // illustrative arbitrary value in this very comment generated an invalid
                // rule and took the entire stylesheet down with it.
                "pr-[calc(1rem+var(--content-rail-gutter,0px))]",
                "md:pr-[calc(2.5rem+var(--content-rail-gutter,0px))]",
                isViewportLocked
                  ? "min-h-0 flex-1 overflow-hidden pb-[calc(4.25rem+env(safe-area-inset-bottom))] md:pb-8"
                  : isSettings
                    ? "flex-1 pb-[calc(4.25rem+env(safe-area-inset-bottom))] md:pb-8"
                    : "flex-1 pb-[calc(9.25rem+env(safe-area-inset-bottom))] md:pb-24",
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
