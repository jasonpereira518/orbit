import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { capturePhotos } from "@/db/schema";
import { requireUserId } from "@/lib/auth";

type Params = { params: Promise<{ photoId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serve one capture photo to the person who took it.
 *
 * Mirrors `/api/feedback/screenshots/[shotId]`, including its two load-bearing choices:
 * the Blob object is PROXIED rather than redirected to (a redirect would hand the browser a
 * permanent public URL for a photo of someone's notes), and a photo belonging to someone
 * else 404s rather than 403s, so the response never confirms that a guessed id exists.
 *
 * OWNER-ONLY, unlike the feedback route, which also admits operators. A feedback
 * screenshot was sent to the operator on purpose; a capture photo never was.
 *
 * `?download=1` flips the disposition to an attachment under the file's original name.
 */
export async function GET(req: Request, { params }: Params) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return new NextResponse(null, { status: 401 });
  }

  const { photoId } = await params;
  // A malformed id would reach Postgres as a failed uuid cast — a 500 for what is plainly
  // "no such photo".
  if (!UUID.test(photoId)) return new NextResponse(null, { status: 404 });

  const db = await getDb();
  const photo = await db.query.capturePhotos.findFirst({
    where: eq(capturePhotos.id, photoId),
    columns: {
      userId: true,
      storage: true,
      blobUrl: true,
      inlineData: true,
      contentType: true,
      fileName: true,
    },
  });

  if (!photo || photo.userId !== userId) {
    return new NextResponse(null, { status: 404 });
  }

  const download = new URL(req.url).searchParams.get("download") === "1";
  // The stored name, reduced to something that cannot break out of the header. The bytes
  // are always a JPEG (`encodeCapturePhoto` re-encodes everything), so the extension is too.
  const baseName =
    (photo.fileName ?? "capture-photo").replace(/\.[^.]+$/, "").replace(/[^\w.\- ]+/g, "_").slice(0, 80) ||
    "capture-photo";

  // Rows are immutable once written; the only mutation is deletion, which turns this into
  // a 404 no stale cache can serve for long. `nosniff` backs up the re-encode: the browser
  // must never reinterpret these bytes as anything but the image they are.
  const headers = {
    "Content-Type": photo.contentType,
    "Cache-Control": "private, max-age=86400, immutable",
    "Content-Disposition": download ? `attachment; filename="${baseName}.jpg"` : "inline",
    "X-Content-Type-Options": "nosniff",
  };

  if (photo.storage === "blob") {
    if (!photo.blobUrl) return new NextResponse(null, { status: 404 });
    const upstream = await fetch(photo.blobUrl, { cache: "no-store" });
    if (!upstream.ok || !upstream.body) return new NextResponse(null, { status: 404 });
    return new NextResponse(upstream.body, { headers });
  }

  if (!photo.inlineData) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(Buffer.from(photo.inlineData, "base64")), { headers });
}
