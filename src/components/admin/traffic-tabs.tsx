"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Secondary navigation inside the Traffic section, same shape as `MoneyTabs`.
 *
 * Two views of one subject: what arrived, and what it turned into. The funnel is a tab
 * rather than a panel on the overview because it is the only screen here that mixes
 * traffic with accounts and money — three populations that need their own explanation,
 * and that would otherwise be read as one continuous chain.
 */
const TABS = [
  { href: "/admin/analytics", label: "Traffic" },
  { href: "/admin/analytics/funnel", label: "Conversion" },
];

export function TrafficTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Traffic views"
      className="mb-6 flex flex-wrap gap-1 border-b border-border/60"
    >
      {TABS.map((tab) => {
        const active =
          tab.href === "/admin/analytics"
            ? pathname === "/admin/analytics"
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
