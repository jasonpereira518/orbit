import { NextResponse } from "next/server";
import { sameOriginGuard } from "@/lib/api/same-origin";
import { requireUserForReleasedSurface } from "@/lib/plan-guards";
import { loadRunProgress } from "@/lib/radar/page-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Where the account's newest Radar run is, polled while "Refresh now" works (and once when the
 * page opens, to pick up a run something else started).
 *
 * Over `fetch`, not a Server Action: Next runs a tab's Server Actions one at a time, so an
 * action-based poll would queue behind the very refresh it is watching.
 */
export async function GET(request: Request) {
  const refused = sameOriginGuard(request, { message: "Cross-origin request refused" });
  if (refused) return refused;
  const userId = await requireUserForReleasedSurface("page.radar");
  return NextResponse.json(await loadRunProgress(userId), { headers: { "Cache-Control": "no-store" } });
}
