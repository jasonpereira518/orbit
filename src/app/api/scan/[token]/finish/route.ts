import { NextResponse, type NextRequest } from "next/server";
import { findScanHandoff, finishScanHandoff } from "@/lib/scan-handoff";

/**
 * The phone's "Done": consume the grant and move its capture job to `transcribed`, so the
 * desktop shows the text and offers Extract. Token-authenticated like the pages route;
 * 404 for every refusal. Idempotent — a second press finds no grant and says so.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const handoff = await findScanHandoff(token);
  if (!handoff) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const out = await finishScanHandoff(handoff.id);
  return NextResponse.json({ ok: true, captureJobId: out.captureJobId });
}
