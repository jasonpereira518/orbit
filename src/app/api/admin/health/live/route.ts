import { NextResponse } from "next/server";
import { requireAdminUserId } from "@/lib/admin";
import { getAdminHealth } from "@/lib/admin-health";
import {
  getCronHealth,
  getErrorEventSummary,
  getOpsStatus,
  getOutreachQueueHealth,
  getWebhookHealth,
} from "@/lib/admin-system";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Everything on `/admin/health` except "Known bug signatures" — that panel changes on a
 * data-quality timescale, not a twenty-second one, and one of its three queries is an
 * unindexed scan there is no reason to pay on every poll.
 *
 * IT GATES ITSELF, like every handler under `/api/admin` — `(admin)/layout.tsx` does not
 * run for route handlers. 404, not 403, on failure — same reasoning as
 * `/api/admin/presence`.
 *
 * Each sub-fetch degrades independently, matching the page's own `.catch(() => null)` —
 * one missing instrumentation table must not take the whole poll down.
 */
export async function GET() {
  try {
    await requireAdminUserId();
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const [health, cron, webhooks, errors, outreach, ops] = await Promise.all([
    getAdminHealth(),
    getCronHealth("imports.process-stalled").catch(() => null),
    getWebhookHealth().catch(() => null),
    getErrorEventSummary().catch(() => null),
    getOutreachQueueHealth().catch(() => null),
    getOpsStatus().catch(() => null),
  ]);

  return NextResponse.json(
    { health, cron, webhooks, errors, outreach, ops },
    { headers: { "Cache-Control": "no-store" } }
  );
}
