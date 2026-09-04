import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { FeedbackWidgetLazy } from "@/components/feedback/feedback-widget-lazy";
import { AppShell } from "@/components/layout/app-shell";
import { SectionFlash } from "@/components/layout/section-flash";
import { PresenceHeartbeat } from "@/components/layout/presence-heartbeat";
import { captureAttribution } from "@/lib/attribution-capture";
import {
  bootstrapAuthenticatedUser,
  isClerkConfigured,
  isDemoMode,
} from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { isOnboardingGatedPath, needsOnboarding } from "@/lib/onboarding";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { resolveThemePreference } from "@/lib/theme";

/**
 * No route in this group can be statically prerendered: every one of them resolves a
 * session, and the layout below redirects anyone without one. Without this, Next treats
 * pages that take no params as static candidates and prerenders them at build time, where
 * `requireUserId()` throws `UnauthorizedError` and fails the whole build rather than the
 * request — which is exactly what /contacts/new started doing once it began reading the
 * plan. Same reason `(admin)` and `(checkout)` set it.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const clerkOn = isClerkConfigured();
  const demoMode = isDemoMode();
  const userId = clerkOn
    ? (await auth()).userId
    : isDemoMode()
      ? "demo-user"
      : null;

  if (clerkOn && !userId) {
    redirect("/sign-in");
  }

  if (!userId) {
    redirect("/");
  }

  const settings = await bootstrapAuthenticatedUser(userId);

  // Moves the first-touch cookie onto the account, once. A no-op UPDATE after the first
  // time — the write filters on `signup_attributed_at IS NULL` in SQL.
  //
  // Deferred rather than awaited: this is the layout that wraps the entire product, so
  // anything on its critical path is added to the TTFB of every authenticated navigation
  // — and nothing rendered below reads the result. It only ever reads `cookies()` (never
  // sets one) and swallows its own failures, which is what makes it safe to run after the
  // response is flushed.
  after(() => captureAttribution(userId));

  // The real gate is `requireUserId()`, which throws `AccountSuspendedError` and covers
  // Server Action POSTs that never re-run this layout. This is only the friendly surface:
  // without it a suspended user would hit an error boundary instead of an explanation.
  if (settings.suspendedAt) redirect("/suspended");

  // First-run gate. This HAS to happen here, above <AppShell>, not in the (main) layout
  // below it: by the time a nested layout redirects, this layout has already rendered and
  // Next has flushed the shell, so the redirect degrades from a 307 into a client-side one
  // that re-renders the router mid-hydration — which throws "Rendered more hooks than
  // during the previous render" inside Next's own Router and blanks the page. Redirecting
  // before anything renders keeps it a clean server redirect.
  //
  // `x-pathname` is set by `src/proxy.ts`; `needsOnboarding` is request-cached, so the
  // (main) layout's own read of it costs nothing.
  const pathname = (await headers()).get("x-pathname") ?? "";
  if (isOnboardingGatedPath(pathname) && (await needsOnboarding(userId))) {
    redirect("/onboarding");
  }

  const theme = resolveThemePreference(settings.theme);

  // Both feed the same render and neither reads the other, so they go together rather than
  // back to back — one round trip on the critical path instead of two.
  //
  // `plan` is only for the tier ring on the mark; `getEntitlements` is request-cached and
  // reads the same `user_settings` row bootstrapped above, so it costs nothing extra.
  //
  // `visibility` is which surfaces this viewer may see. Resolved here, in the one server
  // layout that wraps the whole product, because the nav lives in client components that
  // cannot read the database themselves. `hiddenForUsers` rides along so an exempt operator
  // can be shown a "Hidden" tag on items their users are not getting — see `AppSidebar`.
  const [{ plan }, visibility] = await Promise.all([
    getEntitlements(userId),
    resolveSurfaceVisibility(userId),
  ]);

  return (
    <>
      <AppShell
      clerkOn={clerkOn}
      demoMode={demoMode}
      theme={theme}
      plan={plan}
      hidden={[...visibility.hidden]}
      hiddenForUsers={[...visibility.hiddenForUsers]}
      viewingAsUser={visibility.viewingAsUser}
    >
      {/* Renders nothing; keeps `last_active_at` fresh enough for the admin roster to
          answer "active now". One per tab, not one per route. */}
      <PresenceHeartbeat />

      {/* Also renders nothing. Glows whatever `#id` the URL names, so any link that points
          at a card — every account alert does — lands with that card called out. Mounted
          here so it works on every route rather than being wired up page by page. */}
      <SectionFlash />
      {children}
      </AppShell>

      {/* Deliberately a SIBLING of AppShell, not a child. AppShell early-returns a bare
          shell for `/onboarding`, so mounting inside it would need the widget in two
          branches that must never drift — and first-run friction is the feedback most
          worth having. Being outside `data-warp-craft` also keeps the button from flying
          away during the upgrade warp. */}
      <FeedbackWidgetLazy viewingAsUser={visibility.viewingAsUser} />
    </>
  );
}
