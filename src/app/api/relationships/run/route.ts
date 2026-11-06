import { NextResponse, after } from "next/server";
import { recordBackfillFailure } from "@/lib/backfill-failures";
import { isInternalRequest } from "@/lib/internal-auth";
import { kickRelationshipRun, runRelationshipPass } from "@/lib/relationship-engine/runner";
import { reportError } from "@/lib/report-error";

export const maxDuration = 300;

export async function POST(request: Request) {
  // Internal kick target — not user-facing. Fail-closed shared secret; see internal-auth.ts.
  if (!isInternalRequest(request)) return new NextResponse(null, { status: 401 });
  const body = (await request.json().catch(() => null)) as { userId?: string } | null;
  const userId = body?.userId;
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  after(async () => {
    try {
      const { processed, skipped, submitted, remaining, status } = await runRelationshipPass(userId);
      // Gated on progress so a contact that never advances costs one invocation, not a kick storm.
      if (status === "running" && remaining > 0 && processed + skipped + submitted > 0) {
        await kickRelationshipRun(userId);
      }
    } catch (err) {
      reportError(err, { where: "job.relationships", userId, level: "warning" });
      await recordBackfillFailure("relationships", userId, err);
    }
  });
  return NextResponse.json({ ok: true });
}
