import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  buildRemindersFeed,
  findUserByFeedToken,
  touchFeedFetchedAt,
} from "@/lib/calendar-feed";

// Calendar clients send no cookies, so this route is exempted from Clerk in proxy.ts and
// authenticated solely by the opaque token in the path.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const owner = await findUserByFeedToken(token);
  // 404 rather than 401: a 401 confirms the endpoint gates by token, and some clients
  // respond to it by prompting the user for credentials they don't have.
  if (!owner) {
    return new NextResponse("Not found", { status: 404 });
  }

  const body = await buildRemindersFeed(owner.userId);
  const etag = `W/"${createHash("sha1").update(body).digest("hex")}"`;

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  await touchFeedFetchedAt(owner.userId, owner.calendarFeedLastFetchedAt);

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="orbit-reminders.ics"',
      // no-store so a completed reminder can't linger in an edge cache.
      "Cache-Control": "private, no-store, max-age=0, must-revalidate",
      ETag: etag,
    },
  });
}
