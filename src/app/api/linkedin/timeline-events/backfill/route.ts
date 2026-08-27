import { NextResponse } from "next/server";
import { after } from "next/server";
import {
  kickLinkedInTimelineBackfill,
  runLinkedInTimelineBackfill,
} from "@/lib/linkedin-timeline-backfill";

export const maxDuration = 300;

/** Internal kick target — not user-facing. Authorized via the shared cron secret. */
function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return new NextResponse(null, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { userId?: string } | null;
  const userId = body?.userId;
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  after(async () => {
    // `runLinkedInTimelineBackfill` stops at its own time budget and reports what is left;
    // it does not re-enter itself. The continuation loop lives here, exactly as it does for
    // `/api/embeddings/backfill` — and it matters more here than there, because this pass
    // costs one AI completion per contact and drains far fewer contacts per invocation than
    // the batched embedding path does.
    try {
      const { contactsProcessed, remaining } = await runLinkedInTimelineBackfill(userId);
      // Gated on progress, not on `remaining > 0` alone: any future "contact that is
      // permanently pending but never yields an event" bug then costs one wasted
      // invocation instead of an unbounded kick storm against our own function.
      if (remaining > 0 && contactsProcessed > 0) {
        await kickLinkedInTimelineBackfill(userId);
      }
    } catch {
      // A failure leaves the work pending on purpose; the daily cron re-kicks it.
    }
  });

  return NextResponse.json({ ok: true });
}
