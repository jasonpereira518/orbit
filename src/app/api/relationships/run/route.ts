import { NextResponse, after } from "next/server";
import { recordBackfillFailure } from "@/lib/backfill-failures";
import { isInternalRequest, readInternalUserId } from "@/lib/internal-auth";
import { deepReadOn } from "@/lib/deep-read";
import { runOriginPass } from "@/lib/relationship-engine/origin-pass";
import { RUNNER_BUDGET_MS, kickRelationshipRun, runRelationshipPass } from "@/lib/relationship-engine/runner";
import { reportError } from "@/lib/report-error";

export const maxDuration = 300;

export async function POST(request: Request) {
  // Internal kick target — not user-facing. Fail-closed shared secret; see internal-auth.ts.
  if (!isInternalRequest(request)) return new NextResponse(null, { status: 401 });
  const userId = await readInternalUserId(request);
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  after(async () => {
    try {
      const started = Date.now();
      const { processed, skipped, submitted, remaining, status } = await runRelationshipPass(userId);
      // LinkedIn deep read: the one-time origin pass, in the time the normal pass left.
      const left = RUNNER_BUDGET_MS - (Date.now() - started);
      const origin = left >= 30_000 && (await deepReadOn(userId)) ? await runOriginPass(userId, { budgetMs: left }) : null;
      // Gated on progress so a contact that never advances costs one invocation, not a kick storm.
      if (
        (status === "running" && remaining > 0 && processed + skipped + submitted > 0) ||
        (origin && origin.remaining > 0 && origin.submitted + origin.trivial > 0)
      ) {
        await kickRelationshipRun(userId);
      }
    } catch (err) {
      reportError(err, { where: "job.relationships", userId, level: "warning" });
      await recordBackfillFailure("relationships", userId, err);
    }
  });
  return NextResponse.json({ ok: true });
}
