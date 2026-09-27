"use client";

import { SectionTabs } from "@/components/admin/section-tabs";

/**
 * Secondary navigation inside the Traffic section, same shape as `MoneyTabs`.
 *
 * Three views of one subject: what arrived, what it turned into, and what it did next.
 * The funnel is a tab rather than a panel on the overview because it is the only screen
 * here that mixes traffic with accounts and money — three populations that need their
 * own explanation, and that would otherwise be read as one continuous chain. Engagement
 * is a fourth population again: signed-in accounts using specific features, not visitors
 * or conversions.
 */
const TABS = [
  { href: "/admin/analytics", label: "Traffic" },
  { href: "/admin/analytics/funnel", label: "Conversion" },
  { href: "/admin/analytics/engagement", label: "Engagement" },
];

export function TrafficTabs() {
  return <SectionTabs label="Traffic views" tabs={TABS} />;
}
