import { after, NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";
import { recordHeartbeat } from "@/lib/presence";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The presence heartbeat. Every visible tab POSTs here on `HEARTBEAT_INTERVAL_MS`.
 *
 * A route handler rather than a server action because a beat should be the cheapest
 * possible request: no serialisation protocol, no revalidation, no response body. It
 * returns 204 and writes one row (after the response — see below).
 *
 * It gates itself with `requireUserId()`, like every other route handler — `(app)/layout.tsx`
 * does not run for these. That also means a suspended account's beats are rejected, so a
 * suspended user cannot keep showing as live in the roster.
 *
 * Failures are swallowed into a 204. A dropped heartbeat costs one interval of resolution
 * on an admin screen; surfacing it would put an error toast in front of a user for
 * something that is not their problem and that they cannot act on. The client does not
 * retry for the same reason — the next beat is 45 seconds away.
 */
export async function POST() {
  try {
    const userId = await requireUserId();
    // The write itself runs after the 204 is sent: its outcome never changed the response
    // (always 204, failures swallowed), so there is nothing for the tab to wait on. The
    // auth gate above stays in the request, so a rejected beat still writes nothing.
    after(() => recordHeartbeat(userId).catch(() => {}));
  } catch {
    // Unauthenticated, suspended, or a transient database blip — all equally not worth
    // reporting to the person browsing their contacts.
  }
  return new NextResponse(null, { status: 204 });
}
