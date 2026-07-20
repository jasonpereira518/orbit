import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import {
  bootstrapAuthenticatedUser,
  isClerkConfigured,
  isDemoMode,
} from "@/lib/auth";

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

  await bootstrapAuthenticatedUser(userId);

  return <AppShell clerkOn={clerkOn} demoMode={demoMode}>{children}</AppShell>;
}
