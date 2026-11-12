import { NextResponse } from "next/server";
import { AccountSuspendedError, requireUserId, UnauthorizedError } from "@/lib/auth";
import { isLogoDomain } from "@/lib/org-brand-learn";

/**
 * A company's logo for list rows (past meetings): Google's favicon for a domain, fetched here
 * so the browser never calls Google itself. Only the domain is ever sent (the privacy page
 * says exactly that), and it is validated first, so the fetch can only ever go to Google.
 *
 * A miss (Google's 404 globe, a timeout, not an image) is a transparent pixel, not a 404, so
 * a row rendered before hydration never shows a broken-image icon.
 */
const BLANK_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const MAX_BYTES = 100_000;
const FETCH_TIMEOUT_MS = 5_000;
const RASTER = /^image\/(?:png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon)$/;

function image(body: Uint8Array<ArrayBuffer>, contentType: string, maxAgeSec: number) {
  return new NextResponse(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": `private, max-age=${maxAgeSec}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ domain: string }> }) {
  try {
    await requireUserId();
  } catch (err) {
    // Only "no usable account" is a 401; a DB outage in the settings bootstrap is a 500.
    if (err instanceof UnauthorizedError || err instanceof AccountSuspendedError) {
      return new NextResponse(null, { status: 401 });
    }
    throw err;
  }
  const domain = (await params).domain.toLowerCase();
  if (!isLogoDomain(domain)) return new NextResponse(null, { status: 400 });

  try {
    const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    // An unknown domain comes back 404 with a generic globe, which is not its logo. Raster
    // only: an SVG served from our origin could carry script.
    if (res.ok && RASTER.test(type)) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > 0 && bytes.length <= MAX_BYTES) return image(bytes, type, 7 * 86_400);
    }
    return image(new Uint8Array(BLANK_GIF), "image/gif", 86_400);
  } catch {
    // A timeout or network error: try again soon rather than remembering a blank for a day.
    return image(new Uint8Array(BLANK_GIF), "image/gif", 600);
  }
}
