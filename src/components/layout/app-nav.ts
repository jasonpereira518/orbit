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

/** Primary sidebar destinations (above the Extras divider) */
export const APP_NAV_CORE: AppNavItem[] = [
  DASHBOARD,
  CONTACTS,
  CAPTURE,
  IMPORTS,
  REMINDERS,
  CHAT,
  CONSTELLATION,
];

/** Items under the Extras divider (Settings is rendered separately) */
export const APP_NAV_EXTRAS: AppNavItem[] = [OUTREACH];

export const APP_NAV_SETTINGS: AppNavItem = {
  href: "/settings",
  label: "Settings",
  icon: Settings,
};

/** @deprecated Prefer APP_NAV_CORE */
export const APP_NAV_NETWORK: AppNavItem[] = [
  DASHBOARD,
  CONTACTS,
  REMINDERS,
  CONSTELLATION,
];

/** @deprecated Prefer APP_NAV_CORE / APP_NAV_EXTRAS */
export const APP_NAV_WORKSPACE: AppNavItem[] = [
  CAPTURE,
  CHAT,
  IMPORTS,
  OUTREACH,
];

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
  IMPORTS,
  REMINDERS,
  CONSTELLATION,
  OUTREACH,
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
