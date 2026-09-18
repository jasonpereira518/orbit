import { NextResponse } from "next/server";
import { isInternalRequest } from "@/lib/internal-auth";
import { runOpsSweep } from "@/lib/ops-sweep";
import { reportError } from "@/lib/report-error";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Trigger for the known-condition sweep (`src/lib/ops-sweep.ts`). Called every ten minutes
 * by the GitHub Actions scheduler, which also tells us where `main` is so the sweep can
 * notice production pinned to an old deploy. Shared-secret auth, fail-closed.
 */
export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return new NextResponse(null, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { mainSha?: string; mainCommittedAt?: string }
    | null;
  const deploy =
    body?.mainSha && body?.mainCommittedAt && !Number.isNaN(Date.parse(body.mainCommittedAt))
      ? { mainSha: body.mainSha, mainCommittedAt: new Date(body.mainCommittedAt) }
      : null;

  try {
    const result = await runOpsSweep({ trigger: "schedule", deploy });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // The database is unreachable or the sweep itself broke. The uptime monitor owns
    // "down", but a sweep that breaks while the site is up would otherwise be invisible:
    // it is the thing that sends every other alert.
    const ref = reportError(err, { where: "job.ops-sweep" });
    return NextResponse.json({ status: "failed", ref }, { status: 503 });
  }
}
