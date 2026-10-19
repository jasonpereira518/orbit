import { NextResponse } from "next/server";
import { getCaptureJob } from "@/actions/capture-jobs";
import { sameOriginGuard } from "@/lib/api/same-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * The capture job poll (every 1.5 s while an extraction runs), over `fetch` instead of a
 * Server Action.
 *
 * Next runs a tab's Server Actions one at a time, so as an action this poll sat in the same
 * queue as every click on the page: a save or a draft made during an extraction waited for
 * the poll in front of it (LATENCY_PLAN SRV-5). A route handler runs beside them. Same
 * function, same auth (`requireUserId()` inside it), same result shape, `{ ok: false }`
 * failures included.
 */
export async function POST(request: Request, { params }: Params) {
  const refused = sameOriginGuard(request, { message: "Cross-origin request refused", json: true });
  if (refused) return refused;
  const { id } = await params;
  let since: string | null = null;
  try {
    const body = (await request.json()) as { since?: unknown };
    if (typeof body.since === "string") since = body.since;
  } catch {
    // No body: poll without the unchanged shortcut.
  }
  return NextResponse.json(await getCaptureJob(id, since));
}
