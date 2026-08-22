import type { LucideIcon } from "lucide-react";
import { Gauge, Users, Wallet } from "lucide-react";

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
  // Route is /admin/billing, but the screen covers money in AND money out — "Billing"
  // alone reads as revenue-only.
  { href: "/admin/billing", label: "Money", icon: Wallet },
];

export function isAdminNavActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}
