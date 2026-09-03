import { NextResponse } from "next/server";
import { isInternalRequest } from "@/lib/internal-auth";
import { runOpsSweep } from "@/lib/ops-sweep";

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
  } catch {
    // The database is unreachable or the sweep itself broke. Say so without notifying —
    // the uptime monitor owns "down".
    return NextResponse.json({ status: "failed" }, { status: 503 });
  }
}
