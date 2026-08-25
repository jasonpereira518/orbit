import { NextResponse } from "next/server";
import { requireAdminUserId } from "@/lib/admin";
import { SCREEN_TIER, isLiveScreen } from "@/lib/admin-live-tiers";
import { liveValues } from "@/lib/admin-live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The live values for one console screen.
 *
 * IT GATES ITSELF, like every handler under `/api/admin` — `(admin)/layout.tsx` does not
 * run for route handlers. Any authorisation failure returns 404 with no body detail, for
 * the same reason the presence and export routes do: on a console with exactly one
 * legitimate user, a 403 confirms both that the endpoint exists and that the caller
 * guessed the shape of it.
 *
 * An unknown screen name gets the same 404 — it is indistinguishable from a wrong guess
 * at the path, and should stay that way.
 *
 * Returns a flat record of scalars and nothing else. The screen has already rendered every
 * label, row and table server-side; a richer payload here would amount to re-sending the
 * page on a timer in order to move a handful of integers.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ screen: string }> }
) {
  try {
    await requireAdminUserId();
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const { screen } = await params;
  if (!isLiveScreen(screen)) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const values = await liveValues(screen);
    return NextResponse.json(
      { values, tierMs: SCREEN_TIER[screen] },
      // Live by definition; a cached copy is worse than no copy.
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    // A failed poll must not blank the screen. The client keeps its last known values, so
    // an empty payload here reads as "nothing new" rather than as "everything is zero".
    return NextResponse.json({ values: {}, tierMs: SCREEN_TIER[screen] }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
