import { NextResponse } from "next/server";
import { requireAdminUserId } from "@/lib/admin";
import { getGlobalUpkeepMetrics } from "@/lib/admin-contact-upkeep";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Returns real-time metrics for the admin contact upkeep queue.
 * Protected by admin auth; returns 404 on failure to avoid probing.
 */
export async function GET() {
  try {
    await requireAdminUserId();
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const metrics = await getGlobalUpkeepMetrics();
  return NextResponse.json(metrics, {
    headers: { "Cache-Control": "no-store" },
  });
}
