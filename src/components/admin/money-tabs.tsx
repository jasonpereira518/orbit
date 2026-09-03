"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Secondary navigation inside the Money section.
 *
 * Deliberately NOT extra `ADMIN_NAV` entries. The left rail answers "which part of the
 * console am I in"; five money routes in it would bury Health and Audit under a single
 * topic. These are one subject read five ways, which is what a tab row is for.
 *
 * The section still opens on a page that answers the whole question in ten seconds — the
 * tabs are for going deeper, never a prerequisite for the headline.
 */
const TABS = [
  { href: "/admin/billing", label: "Overview" },
  { href: "/admin/billing/movement", label: "Movement" },
  { href: "/admin/billing/costs", label: "Costs" },
  { href: "/admin/billing/run-cost", label: "Cost to run" },
  { href: "/admin/billing/demand", label: "Demand" },
];

export function MoneyTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Money views"
      className="mb-6 flex flex-wrap gap-1 border-b border-border/60"
    >
      {TABS.map((tab) => {
        // Exact match for the section root, or every deeper tab would light it too.
        const active =
          tab.href === "/admin/billing"
            ? pathname === "/admin/billing"
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
