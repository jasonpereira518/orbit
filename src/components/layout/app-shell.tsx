"use client";

import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/layout/app-sidebar";

export function AppShell({
  children,
  clerkOn,
  demoMode,
}: {
  children: React.ReactNode;
  clerkOn: boolean;
  demoMode: boolean;
}) {
  const pathname = usePathname();
  const isOnboarding = pathname === "/onboarding";

  if (isOnboarding) {
    return <div className="min-h-screen bg-background">{children}</div>;
  }

  return (
    <div className="flex min-h-screen bg-background">
      <div className="sticky top-0 h-screen">
        <AppSidebar pathname={pathname} clerkOn={clerkOn} demoMode={demoMode} />
      </div>
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl px-6 py-8 md:px-10">{children}</div>
      </main>
    </div>
  );
}
