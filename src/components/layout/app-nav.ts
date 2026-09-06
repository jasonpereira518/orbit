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

/** Primary sidebar destinations (above the Extras divider) */
export const APP_NAV_CORE: AppNavItem[] = [
  DASHBOARD,
  CONTACTS,
  CAPTURE,
  EVENTS,
  IMPORTS,
  REMINDERS,
  CHAT,
  CONSTELLATION,
];

/** Items under the Extras divider (Settings is rendered separately) */
export const APP_NAV_EXTRAS: AppNavItem[] = [OUTREACH, KNOWLEDGE];

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
  EVENTS,
  IMPORTS,
  REMINDERS,
  CONSTELLATION,
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
