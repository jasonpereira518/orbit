import { NextResponse } from "next/server";
import { requireAdminUserId } from "@/lib/admin";
import { liveUserIds } from "@/lib/presence";
import { PRESENCE_WINDOW_MS } from "@/lib/presence-window";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The live set, for the roster's presence dots.
 *
 * IT GATES ITSELF, like every handler under `/api/admin` — `(admin)/layout.tsx` does not run
 * for route handlers. Any authorisation failure returns 404 with no body detail, for the
 * same reason the export route does: on a console with exactly one legitimate user, a 403
 * confirms both that the endpoint exists and that the caller guessed the shape of it.
 *
 * Returns ids and nothing else. The roster has every other column already server-rendered,
 * so a richer payload here would amount to re-sending the page on a 15-second timer in
 * order to move a dot.
 */
export async function GET() {
  try {
    await requireAdminUserId();
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const userIds = await liveUserIds();

  return NextResponse.json(
    { userIds, windowMs: PRESENCE_WINDOW_MS },
    // Presence is stale the moment it is computed; a cached copy is worse than no copy.
    { headers: { "Cache-Control": "no-store" } }
  );
}
