"use client";

import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/layout/app-sidebar";

export function AppShell({
  children,
  clerkOn,
}: {
  children: React.ReactNode;
  clerkOn: boolean;
}) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen bg-[#fbfbf9]">
      <div className="sticky top-0 h-screen">
        <AppSidebar pathname={pathname} clerkOn={clerkOn} />
      </div>
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl px-6 py-8 md:px-10">{children}</div>
      </main>
    </div>
  );
}
