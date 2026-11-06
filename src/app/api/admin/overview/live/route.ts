import { NextResponse } from "next/server";
import { requireAdminUserId } from "@/lib/admin";
import { getOverviewLive } from "@/lib/admin-metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The parts of `/admin` that can change from outside the operator's own actions — alerts,
 * the recent-signups list, the two activity KPIs and the open ops-alert count.
 *
 * IT GATES ITSELF, like every handler under `/api/admin` — `(admin)/layout.tsx` does not
 * run for route handlers. 404, not 403, on failure — same reasoning as
 * `/api/admin/presence`: a 403 would confirm the endpoint's existence to a console with
 * exactly one legitimate caller.
 *
 * Narrow on purpose: `getOverviewTriage` selects only the columns the alerts need and reuses
 * the memoized aggregates, so a tick is one `user_settings` read plus one indexed count. MRR
 * and the waitlist count are first-paint only — they change on a webhook, not a minute.
 */
export async function GET() {
  try {
    await requireAdminUserId();
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  // `triage` holds every account's row; only the derived, page-sized fields go out.
  const { triage: _triage, ...live } = await getOverviewLive();
  return NextResponse.json(live, {
    headers: { "Cache-Control": "no-store" },
  });
}
