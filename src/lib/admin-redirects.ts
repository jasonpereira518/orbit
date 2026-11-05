import type { ConfigRedirect } from "./waitlist-host";

/**
 * Admin URLs from before the console was folded into eight sections (Nov 2026).
 *
 * Ops Slack alerts, Stripe webhook copy, weekly digests and bookmarks still carry these, so
 * each one lands on the view that now holds its content. Next passes the query string
 * through (`/admin/audit?target=…` keeps its filter). Temporary, not permanent: a browser
 * caches a 308 forever, and these paths are free to be reused.
 *
 * `scripts/smoke-admin-redirects.ts` asserts every destination is a real, gated page.
 */
export const ADMIN_REDIRECTS: { source: string; destination: string }[] = [
  { source: "/admin/analytics", destination: "/admin/growth" },
  { source: "/admin/analytics/funnel", destination: "/admin/growth" },
  { source: "/admin/analytics/engagement", destination: "/admin/growth/features" },
  { source: "/admin/analytics/radar", destination: "/admin/growth/radar" },
  { source: "/admin/beta", destination: "/admin/growth/activation" },
  { source: "/admin/launch", destination: "/admin/growth" },
  { source: "/admin/retain", destination: "/admin/growth/retention" },
  { source: "/admin/growth/interest-list", destination: "/admin/access" },
  { source: "/admin/growth/broadcasts", destination: "/admin/access/broadcasts" },
  { source: "/admin/billing/movement", destination: "/admin/billing/revenue" },
  { source: "/admin/billing/demand", destination: "/admin/billing/revenue" },
  { source: "/admin/billing/run-cost", destination: "/admin/billing/costs" },
  { source: "/admin/avatars", destination: "/admin/product/photos" },
  { source: "/admin/audit", destination: "/admin/users/audit" },
];

export function adminRedirects(): ConfigRedirect[] {
  return ADMIN_REDIRECTS.map((r) => ({ ...r, permanent: false }));
}
