"use client";

import { usePathname } from "next/navigation";

function isPeopleListPath(pathname: string) {
  return pathname === "/contacts" || pathname === "/recruiters";
}

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Contacts ↔ recruiters owns its own slide in PeopleListShell.
  if (isPeopleListPath(pathname)) {
    return <div key={pathname}>{children}</div>;
  }

  return (
    <div key={pathname} className="page-transition">
      {children}
    </div>
  );
}
