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
} from "lucide-react";

export type AppNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

export const APP_NAV: AppNavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/capture", label: "Capture", icon: Sparkles },
  { href: "/imports", label: "Imports", icon: Upload },
  { href: "/outreach", label: "Outreach", icon: Send },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/graph", label: "Constellation", icon: Network },
  { href: "/settings", label: "Settings", icon: Settings },
];

export const MOBILE_BOTTOM_NAV: Array<
  AppNavItem | { id: "more"; label: string; icon: LucideIcon }
> = [
  APP_NAV[0],
  APP_NAV[1],
  APP_NAV[2],
  APP_NAV[4],
  { id: "more", label: "More", icon: MoreHorizontal },
];

export const MOBILE_MORE_NAV = [APP_NAV[3], APP_NAV[5], APP_NAV[6]];

export function isNavActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}
