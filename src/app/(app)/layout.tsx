import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { isClerkConfigured } from "@/lib/auth";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const clerkOn = isClerkConfigured();

  if (clerkOn) {
    const { userId } = await auth();
    if (!userId) {
      redirect("/sign-in");
    }
  }

  await headers();

  return <AppShell clerkOn={clerkOn}>{children}</AppShell>;
}
