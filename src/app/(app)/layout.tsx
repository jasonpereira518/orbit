import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { PresenceHeartbeat } from "@/components/layout/presence-heartbeat";
import {
  bootstrapAuthenticatedUser,
  isClerkConfigured,
  isDemoMode,
} from "@/lib/auth";
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

  // The real gate is `requireUserId()`, which throws `AccountSuspendedError` and covers
  // Server Action POSTs that never re-run this layout. This is only the friendly surface:
  // without it a suspended user would hit an error boundary instead of an explanation.
  if (settings.suspendedAt) redirect("/suspended");

  const theme = resolveThemePreference(settings.theme);

  return (
    <AppShell clerkOn={clerkOn} demoMode={demoMode} theme={theme}>
      {/* Renders nothing; keeps `last_active_at` fresh enough for the admin roster to
          answer "active now". One per tab, not one per route. */}
      <PresenceHeartbeat />
      {children}
    </AppShell>
  );
}
