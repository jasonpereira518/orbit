import type { LucideIcon } from "lucide-react";
import {
  ChartNoAxesCombined,
  FileClock,
  LayoutDashboard,
  ServerCog,
  ShieldCheck,
  Users,
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
  { href: "/admin", label: "Command Center", icon: LayoutDashboard },
  { href: "/admin/metrics", label: "Metrics", icon: ChartNoAxesCombined },
  { href: "/admin/logs", label: "Logs", icon: FileClock },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/systems", label: "Systems", icon: ServerCog },
  { href: "/admin/audit", label: "Audit", icon: ShieldCheck },
];

export function isAdminNavActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}
