"use client";

import { usePathname } from "next/navigation";

function isPeopleListPath(pathname: string) {
  return pathname === "/contacts" || pathname === "/recruiters";
}

/**
 * CSS enter animation for app pages.
 * Remounting is owned by `(app)/template.tsx` (Next templates remount on nav).
 * Shared client work (AvatarBackfill, etc.) must live in `(app)/layout` / AppShell
 * above this template — not under it.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Contacts ↔ recruiters owns its own slide in PeopleListShell.
  if (isPeopleListPath(pathname)) {
    return <>{children}</>;
  }

  return <div className="page-transition">{children}</div>;
}
