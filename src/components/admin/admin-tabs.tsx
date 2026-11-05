"use client";

import { SectionTabs, type SectionTab } from "@/components/admin/section-tabs";

/**
 * Every section's tab row, in one place, so the console's whole map reads top to bottom.
 *
 * The left rail answers "which part of the console am I in" (eight sections, `ADMIN_NAV`);
 * these answer "which view of it". Tabs are routes, not client state: only the open tab's
 * data loads, and every view can be linked to from a Slack alert or another page.
 *
 * `counts` keys are tab hrefs; a tab with no entry (or 0) shows no badge.
 */
type Counts = Partial<Record<string, number>>;

function tabsWith(tabs: SectionTab[], counts: Counts | undefined, title?: string): SectionTab[] {
  if (!counts) return tabs;
  return tabs.map((t) => ({ ...t, count: counts[t.href], countTitle: title }));
}

export const USERS_TABS: SectionTab[] = [
  { href: "/admin/users", label: "Roster" },
  { href: "/admin/users/audit", label: "Audit log" },
];

export const FEEDBACK_TABS: SectionTab[] = [
  { href: "/admin/feedback", label: "Inbox" },
  { href: "/admin/feedback/chat", label: "Chat ratings" },
];

export const GROWTH_TABS: SectionTab[] = [
  { href: "/admin/growth", label: "Acquisition" },
  { href: "/admin/growth/activation", label: "Activation" },
  { href: "/admin/growth/retention", label: "Retention" },
  { href: "/admin/growth/features", label: "Features" },
  { href: "/admin/growth/radar", label: "Radar" },
];

export const MONEY_TABS: SectionTab[] = [
  { href: "/admin/billing", label: "Overview" },
  { href: "/admin/billing/revenue", label: "Revenue" },
  { href: "/admin/billing/costs", label: "Costs" },
];

export const ACCESS_TABS: SectionTab[] = [
  { href: "/admin/access", label: "Waitlist" },
  { href: "/admin/access/invites", label: "Invites" },
  { href: "/admin/access/broadcasts", label: "Broadcasts" },
];

export const PRODUCT_TABS: SectionTab[] = [
  { href: "/admin/product", label: "Pages" },
  { href: "/admin/product/plans", label: "Plans" },
  { href: "/admin/product/dashboard", label: "Dashboard" },
  { href: "/admin/product/settings", label: "Settings" },
  { href: "/admin/product/constellation", label: "Constellation" },
  { href: "/admin/product/photos", label: "Photos" },
];

export const OPS_TABS: SectionTab[] = [
  { href: "/admin/health", label: "Accounts" },
  { href: "/admin/health/systems", label: "Systems" },
  { href: "/admin/health/ai", label: "AI & data" },
];

export function UsersTabs() {
  return <SectionTabs label="Users views" tabs={USERS_TABS} />;
}

export function FeedbackTabs() {
  return <SectionTabs label="Feedback views" tabs={FEEDBACK_TABS} />;
}

export function GrowthTabs() {
  return <SectionTabs label="Growth views" tabs={GROWTH_TABS} />;
}

export function MoneyTabs() {
  return <SectionTabs label="Money views" tabs={MONEY_TABS} />;
}

export function AccessTabs() {
  return <SectionTabs label="Access views" tabs={ACCESS_TABS} />;
}

export function ProductSectionTabs({ counts }: { counts?: Counts }) {
  return <SectionTabs label="Product views" tabs={tabsWith(PRODUCT_TABS, counts, "hidden")} />;
}

export function OpsTabs({ counts }: { counts?: Counts }) {
  return <SectionTabs label="Ops views" tabs={tabsWith(OPS_TABS, counts, "need attention")} />;
}
