import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
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
  const theme = resolveThemePreference(settings.theme);

  return (
    <AppShell clerkOn={clerkOn} demoMode={demoMode} theme={theme}>
      {children}
    </AppShell>
  );
}
