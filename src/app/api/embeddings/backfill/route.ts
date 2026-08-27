import { NextResponse } from "next/server";
import { after } from "next/server";
import { runEmbeddingBackfill } from "@/lib/embedding-backfill";

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

  after(() => runEmbeddingBackfill(userId).catch(() => {}));

  return NextResponse.json({ ok: true });
}
