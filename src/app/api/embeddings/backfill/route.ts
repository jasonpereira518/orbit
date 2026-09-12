import { NextResponse } from "next/server";
import { after } from "next/server";
import { isInternalRequest } from "@/lib/internal-auth";
import { kickEmbeddingBackfill, runEmbeddingBackfill } from "@/lib/embedding-backfill";

export const maxDuration = 300;

export async function POST(request: Request) {
  // Internal kick target — not user-facing. Fail-closed shared secret; see internal-auth.ts.
  if (!isInternalRequest(request)) {
    return new NextResponse(null, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { userId?: string } | null;
  const userId = body?.userId;
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  after(async () => {
    // `runEmbeddingBackfill` stops at its own time budget and reports what is left; it does
    // not re-enter itself. This is where the continuation loop actually lives — the same
    // shape as the import engine's `scheduleContinuation`. Without it a backlog larger than
    // one invocation (5,000 contacts is the stated target scale) drains one invocation's
    // worth and then sits until the *daily* cron happens to notice, which is up to 24 hours
    // of a user's contacts being missing from semantic search.
    try {
      const { embedded, remaining } = await runEmbeddingBackfill(userId);
      // Gated on `embedded > 0`, not on `remaining > 0` alone. Every way this function can
      // return with work outstanding involves having done some — the provider-failure path
      // throws rather than returning, and both phases either make progress or exhaust their
      // claim. So requiring progress costs nothing in the real cases and turns any future
      // "row that is permanently pending but never claimable" bug into one wasted
      // invocation instead of an unbounded kick storm against our own function.
      if (remaining > 0 && embedded > 0) await kickEmbeddingBackfill(userId);
    } catch {
      // A provider failure leaves the work pending on purpose; the daily cron re-kicks it.
    }
  });

  return NextResponse.json({ ok: true });
}
