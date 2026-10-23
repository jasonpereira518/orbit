import { NextResponse } from "next/server";
import { getImportJobStatus } from "@/actions/imports";
import { refuseCrossOrigin } from "@/lib/same-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * The import progress poll (every 1.5 s for the whole import), over `fetch` instead of a
 * Server Action, for the reason `/api/capture/jobs/[id]/status` gives: as an action it held
 * the tab's one-at-a-time action queue, so every click during an import waited behind it
 * (LATENCY_PLAN SRV-5). Same function and auth. Where the action threw (a missing or foreign
 * import, no session) this answers 500, and the runner retries either one the same way.
 */
export async function POST(request: Request, { params }: Params) {
  const refused = refuseCrossOrigin(request);
  if (refused) return refused;
  const { id } = await params;
  try {
    return NextResponse.json(await getImportJobStatus(id));
  } catch {
    return NextResponse.json({ error: "Couldn't read that import's progress" }, { status: 500 });
  }
}
