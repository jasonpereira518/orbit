"use client";

import { SectionTabs } from "@/components/admin/section-tabs";

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
  return <SectionTabs label="Money views" tabs={TABS} />;
}
