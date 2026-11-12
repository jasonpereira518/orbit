import { NextResponse } from "next/server";
import { requireAdminUserId } from "@/lib/admin";
import { getLinkedInPhotoQueueMetrics } from "@/lib/linkedin-photo-queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Live state of the LinkedIn photo queue for the admin panel. 404 for non-admins. */
export async function GET() {
  try {
    await requireAdminUserId();
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.json(await getLinkedInPhotoQueueMetrics(), {
    headers: { "Cache-Control": "no-store" },
  });
}
