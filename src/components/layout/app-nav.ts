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
  /**
   * Prefetch the WHOLE route — its data, not just its loading skeleton — while the link is
   * on screen. A click then renders from the client cache with no skeleton, which is the
   * only way past React's 300ms Suspense reveal hold on a first visit.
   *
   * It costs a full server render of the destination on every page that shows the link, so
   * it is reserved for pages that are both visited daily and bounded in cost — Dashboard,
   * Contacts (paginated) and Reminders — and never for a heavy one (Constellation returns
   * every engaged contact). See `fullPrefetch` below for how it is applied.
   */
  prefetchFull?: boolean;
};

const DASHBOARD: AppNavItem = {
  href: "/dashboard",
  label: "Dashboard",
  icon: LayoutDashboard,
  // Excluded at first: heavy accounts' dashboards had hit the function time limit, and a
  // full prefetch starts that render from every page. Measured since, with
  // `scripts/dev/dashboard-scale.ts`: bounded rows (Phase B) and the slim closeness read
  // put a 10,000-contact dashboard at ~0.5 s with 50 ms per statement, 15 statements flat
  // at every size — the same order as Contacts. So it is prefetched like the other two.
  prefetchFull: true,
};
const CONTACTS: AppNavItem = {
  href: "/contacts",
  label: "Contacts",
  icon: Users,
  prefetchFull: true,
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
  prefetchFull: true,
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

/**
 * The `prefetch` prop for a nav link: `true` (whole route) for `prefetchFull` items that are
 * not the page already on screen, otherwise the default (the route down to its
 * `loading.tsx`). Prefetching the current page would pay for a render nobody can click to.
 */
export function fullPrefetch(item: AppNavItem, active: boolean): true | undefined {
  return item.prefetchFull && !active ? true : undefined;
}

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
