import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import {
  bootstrapAuthenticatedUser,
  isClerkConfigured,
  isDemoMode,
} from "@/lib/auth";
import { resolveThemePreference } from "@/lib/theme";
import { getEntitlements } from "@/lib/entitlements";

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
  const entitlements = await getEntitlements(userId);

  return (
    <AppShell
      clerkOn={clerkOn}
      demoMode={demoMode}
      theme={theme}
      entitlements={entitlements}
    >
      {children}
    </AppShell>
  );
}
