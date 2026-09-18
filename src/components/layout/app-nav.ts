import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Users,
  Sparkles,
  Upload,
  Send,
  MessageSquare,
  Network,
  Settings,
  MoreHorizontal,
  Bell,
  BookOpen,
  PartyPopper,
} from "lucide-react";

export type AppNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const DASHBOARD: AppNavItem = {
  href: "/dashboard",
  label: "Dashboard",
  icon: LayoutDashboard,
};
const CONTACTS: AppNavItem = {
  href: "/contacts",
  label: "Contacts",
  icon: Users,
};
const CAPTURE: AppNavItem = {
  href: "/capture",
  label: "Capture",
  icon: Sparkles,
};
const IMPORTS: AppNavItem = {
  href: "/imports",
  label: "Imports",
  icon: Upload,
};
const EVENTS: AppNavItem = {
  href: "/events",
  label: "Events",
  // The same icon INTERACTION_TYPES gives the "event" interaction type, so the sidebar and
  // the timeline entries these events create read as the same thing.
  icon: PartyPopper,
};
const REMINDERS: AppNavItem = {
  href: "/reminders",
  label: "Reminders",
  icon: Bell,
};
const CHAT: AppNavItem = {
  href: "/chat",
  label: "Chat",
  icon: MessageSquare,
};
const CONSTELLATION: AppNavItem = {
  href: "/graph",
  label: "Constellation",
  icon: Network,
};
const OUTREACH: AppNavItem = {
  href: "/outreach",
  label: "Outreach",
  icon: Send,
};
const KNOWLEDGE: AppNavItem = {
  href: "/knowledge",
  label: "Knowledge",
  icon: BookOpen,
};

/** Primary sidebar destinations (above the "Coming soon" divider) */
export const APP_NAV_CORE: AppNavItem[] = [
  DASHBOARD,
  CONTACTS,
  CAPTURE,
  REMINDERS,
  CHAT,
  IMPORTS,
  CONSTELLATION,
];

/**
 * Items under the "Coming soon" divider (Settings is rendered separately).
 *
 * The name is stale for Knowledge, which has shipped — it stays in this group rather than
 * moving up to `APP_NAV_CORE` because the divider's label describes Events and Outreach,
 * the two items that actually are coming soon (`comingSoon` in `src/lib/surfaces.ts`), and
 * splitting the group over one released item was a deliberate no per product decision.
 */
export const APP_NAV_EXTRAS: AppNavItem[] = [EVENTS, OUTREACH, KNOWLEDGE];

export const APP_NAV_SETTINGS: AppNavItem = {
  href: "/settings",
  label: "Settings",
  icon: Settings,
};

export const APP_NAV: AppNavItem[] = [
  ...APP_NAV_CORE,
  ...APP_NAV_EXTRAS,
  APP_NAV_SETTINGS,
];

export const MOBILE_BOTTOM_NAV: Array<
  AppNavItem | { id: "more"; label: string; icon: LucideIcon }
> = [
  DASHBOARD,
  CONTACTS,
  CAPTURE,
  CHAT,
  { id: "more", label: "More", icon: MoreHorizontal },
];

export const MOBILE_MORE_NAV = [
  REMINDERS,
  IMPORTS,
  CONSTELLATION,
  EVENTS,
  OUTREACH,
  KNOWLEDGE,
];

export function isNavActive(pathname: string, href: string) {
  if (href === "/contacts") {
    return (
      pathname === "/contacts" ||
      pathname.startsWith("/contacts/") ||
      pathname === "/recruiters" ||
      pathname.startsWith("/recruiters/")
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
