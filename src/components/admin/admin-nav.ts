import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Gauge,
  LayoutTemplate,
  ScrollText,
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
  { href: "/admin", label: "Overview", icon: Gauge },
  { href: "/admin/users", label: "Users", icon: Users },
  // "What is broken across everyone, right now" — the cross-account view of signals the
  // inspector only ever showed one account at a time.
  { href: "/admin/health", label: "Health", icon: Activity },
  // The only screen in the console that changes the product rather than reporting on it:
  // which pages, dashboard cards, and settings sections every user can see.
  { href: "/admin/product", label: "Product", icon: LayoutTemplate },
  // Trends live here rather than on the overview, which stays triage-only by design.
  { href: "/admin/growth", label: "Growth", icon: TrendingUp },
  // Route is /admin/billing, but the screen covers money in AND money out — "Billing"
  // alone reads as revenue-only.
  { href: "/admin/billing", label: "Money", icon: Wallet },
  { href: "/admin/audit", label: "Audit", icon: ScrollText },
];

export function isAdminNavActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}
