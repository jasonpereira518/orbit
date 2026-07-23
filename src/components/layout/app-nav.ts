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

export const APP_NAV_CORE: AppNavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/reminders", label: "Reminders", icon: Bell },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/capture", label: "Capture", icon: Sparkles },
  { href: "/imports", label: "Imports", icon: Upload },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/graph", label: "Constellation", icon: Network },
];

export const APP_NAV_EXTRAS: AppNavItem[] = [
  { href: "/outreach", label: "Outreach", icon: Send },
];

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
  APP_NAV_CORE[0], // Dashboard
  APP_NAV_CORE[2], // Contacts
  APP_NAV_CORE[3], // Capture
  APP_NAV_CORE[5], // Chat
  { id: "more", label: "More", icon: MoreHorizontal },
];

export const MOBILE_MORE_NAV = [
  APP_NAV_CORE[1], // Reminders
  APP_NAV_CORE[4], // Imports
  APP_NAV_CORE[6], // Constellation
  ...APP_NAV_EXTRAS,
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
