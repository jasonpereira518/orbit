import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";
import { userExportStream } from "@/lib/data-export";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";

/** A large network pages through every table; the stream keeps memory flat, not time short. */
export const maxDuration = 300;

/**
 * The signed-in user's own data, as one JSON file, streamed. Owner-only by construction:
 * the only input is the session. No secrets, tokens or photo bytes; see `data-export.ts`.
 */
export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return new Response(null, { status: 401 });
  }
  try {
    await consumeBucket("export", userId, RATE_LIMITS.export);
  } catch (err) {
    if (isRateLimitedError(err)) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } }
      );
    }
    throw err;
  }
  const date = new Date().toISOString().slice(0, 10);
  return new Response(userExportStream(userId), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="orbit-export-${date}.json"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
