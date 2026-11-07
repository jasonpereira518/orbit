import type { LucideIcon } from "lucide-react";
import {
  Activity,
  DoorOpen,
  Flame,
  Gauge,
  HandCoins,
  LayoutTemplate,
  MessageSquareText,
  Scale,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";

export type AdminNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

/**
 * Deliberately separate from `src/components/layout/app-nav.ts`.
 *
 * That module is imported by client components in the product shell, so adding admin
 * entries there would compile these paths into every user's JS bundle. The server gate is
 * the real boundary, but advertising the console's existence buys nothing.
 */
export const ADMIN_NAV: AdminNavItem[] = [
  // Triage only: what needs a human today. Everything else has a home below.
  { href: "/admin", label: "Overview", icon: Gauge },
  // The roster, each account's inspector, and the audit log of what operators did to them.
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/feedback", label: "Feedback", icon: MessageSquareText },
  // Before signup (acquisition) through to staying (retention), plus what people use.
  // Traffic, Beta, Launch and Retain each answered one slice of this; they are tabs now.
  { href: "/admin/growth", label: "Growth", icon: TrendingUp },
  // Route is /admin/billing, but the screen covers money in AND money out.
  { href: "/admin/billing", label: "Money", icon: Wallet },
  // Who gets in: the waitlist, invitations past stealth, and broadcasts to the list.
  { href: "/admin/access", label: "Access", icon: DoorOpen },
  // The only section that changes the product rather than reporting on it.
  { href: "/admin/product", label: "Product", icon: LayoutTemplate },
  // Route is /admin/health (Slack alerts link to it): what is broken, across accounts and
  // in Orbit's own systems.
  { href: "/admin/health", label: "Ops", icon: Activity },
];

/**
 * The YC-mode nav — a full replacement for `ADMIN_NAV`, not an addition to it. Toggling
 * modes changes which of these two arrays `AdminShell` renders.
 */
export const ADMIN_YC_NAV: AdminNavItem[] = [
  { href: "/admin/yc/runway", label: "Runway", icon: Flame },
  { href: "/admin/yc/revenue", label: "Revenue", icon: TrendingUp },
  { href: "/admin/yc/economics", label: "Unit Economics", icon: Scale },
  { href: "/admin/yc/fundraising", label: "Funding", icon: HandCoins },
];

export function isAdminNavActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}
