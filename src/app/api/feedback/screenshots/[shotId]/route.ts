import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { feedbackScreenshots } from "@/db/schema";
import { isAdminUser } from "@/lib/admin";
import { requireUserId } from "@/lib/auth";

type Params = { params: Promise<{ shotId: string }> };

/**
 * Serve one feedback screenshot.
 *
 * Two deliberate divergences from `/api/avatars/[contactId]`, which this otherwise mirrors:
 *
 * OWNER-OR-ADMIN, not admin-only. The submitter's own client renders thumbnails of what it
 * just attached, and denying an author their own screenshot is a bug that gets worked
 * around by putting the bytes in the RSC payload instead — which is the thing this route
 * exists to avoid.
 *
 * PROXY THE BLOB, never redirect to it. Vercel Blob has no private access mode, so a
 * redirect hands the browser a permanently public URL that then lives in history and in the
 * `Referer` of whatever the page loads next. That is a fine trade for a third-party profile
 * photo and a bad one for a picture of somebody's actual CRM.
 *
 * A shot belonging to someone else 404s rather than 403s: a 403 confirms both that the row
 * exists and that you guessed its id. Same reasoning as `AdminForbiddenError`'s "Not found".
 */
export async function GET(_req: Request, { params }: Params) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return new NextResponse(null, { status: 401 });
  }

  const { shotId } = await params;
  const db = await getDb();

  const shot = await db.query.feedbackScreenshots.findFirst({
    where: eq(feedbackScreenshots.id, shotId),
    columns: {
      userId: true,
      storage: true,
      blobUrl: true,
      inlineData: true,
      contentType: true,
    },
  });

  if (!shot) return new NextResponse(null, { status: 404 });
  if (shot.userId !== userId && !isAdminUser(userId)) {
    return new NextResponse(null, { status: 404 });
  }

  // Rows are immutable once written — the only mutation is deletion, which turns this into
  // a 404 that no stale cache can serve wrongly for long. `nosniff` is the belt to
  // `decodeScreenshot`'s magic-byte braces: even if a payload somehow got past validation,
  // the browser must not reinterpret it as something executable.
  const headers = {
    "Content-Type": shot.contentType,
    "Cache-Control": "private, max-age=86400, immutable",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
  };

  if (shot.storage === "blob") {
    if (!shot.blobUrl) return new NextResponse(null, { status: 404 });
    const upstream = await fetch(shot.blobUrl, { cache: "no-store" });
    if (!upstream.ok || !upstream.body) return new NextResponse(null, { status: 404 });
    return new NextResponse(upstream.body, { headers });
  }

  if (!shot.inlineData) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(Buffer.from(shot.inlineData, "base64")), { headers });
}
