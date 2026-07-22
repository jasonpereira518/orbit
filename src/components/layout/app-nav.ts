import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Users,
  Sparkles,
  Upload,
  Send,
  MessageSquare,
  Network,
  BookOpen,
  Settings,
  MoreHorizontal,
  Bell,
} from "lucide-react";

export type AppNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

export const APP_NAV: AppNavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/reminders", label: "Reminders", icon: Bell },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/capture", label: "Capture", icon: Sparkles },
  { href: "/imports", label: "Imports", icon: Upload },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/outreach", label: "Outreach", icon: Send },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/graph", label: "Constellation", icon: Network },
  { href: "/settings", label: "Settings", icon: Settings },
];

export const MOBILE_BOTTOM_NAV: Array<
  AppNavItem | { id: "more"; label: string; icon: LucideIcon }
> = [
  APP_NAV[0], // Dashboard
  APP_NAV[2], // Contacts
  APP_NAV[3], // Capture
  APP_NAV[5], // Knowledge
  { id: "more", label: "More", icon: MoreHorizontal },
];

export const MOBILE_MORE_NAV = [
  APP_NAV[1], // Reminders
  APP_NAV[4], // Imports
  APP_NAV[6], // Outreach
  APP_NAV[7], // Chat
  APP_NAV[8], // Constellation
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
