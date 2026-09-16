import { NextResponse } from "next/server";
import { requireAdminUserId } from "@/lib/admin";
import { getAdminOverview } from "@/lib/admin-metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The parts of `/admin` that can change from outside the operator's own actions —
 * alerts, the activation funnel, and the recent-signups list.
 *
 * IT GATES ITSELF, like every handler under `/api/admin` — `(admin)/layout.tsx` does not
 * run for route handlers. 404, not 403, on failure — same reasoning as
 * `/api/admin/presence`: a 403 would confirm the endpoint's existence to a console with
 * exactly one legitimate caller.
 *
 * Re-runs the same query `getAdminOverview()` does on page load rather than a cheaper
 * subset — the alerts and funnel are pure-JS reductions over one shared row set, so
 * there is no narrower query to run for "just the live part".
 */
export async function GET() {
  try {
    await requireAdminUserId();
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const overview = await getAdminOverview();
  const recent = overview.rows.slice(0, 6).map((r) => ({
    userId: r.userId,
    email: r.email,
    signupAt: r.signupAt.toISOString(),
    plan: r.plan,
    planSource: r.planSource,
    counts: { contacts: r.counts.contacts, interactions: r.counts.interactions },
    hasProviderKey: r.hasProviderKey,
  }));

  return NextResponse.json(
    {
      alerts: overview.alerts,
      funnel: overview.funnel,
      recent,
      signups: overview.signups,
      activeLast7d: overview.activeLast7d,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
