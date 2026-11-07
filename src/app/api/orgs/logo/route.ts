import { requireUserId } from "@/lib/auth";
import { isBareDomain } from "@/lib/wikidata";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 10;

/** A 64px favicon is a few KB; anything past this is not one. */
const MAX_BYTES = 100_000;
const TIMEOUT_MS = 3_000;
/** Raster only: an SVG served from Orbit's origin could carry script. */
const IMAGE_TYPES = new Set(["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/jpeg", "image/gif", "image/webp"]);
const USER_AGENT = "OrbitBot/1.0 (+https://orbit.app; organization logos)";

function notFound() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=86400" } });
}

async function readCapped(body: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * An organization's logo by domain, for suggestion rows and chips.
 *
 *   GET /api/orgs/logo?domain=google.com   → image, or 404 (the client draws a monogram)
 *
 * Fetched server-side from Google's favicon service, so the person's browser never contacts
 * Google and the page's CSP needs no new host. Only that one fixed URL is ever fetched, with
 * the domain as a query parameter — never a URL from the request — and only after the domain
 * passes a strict bare-hostname check.
 */
export async function GET(request: Request) {
  try {
    await requireUserId();
  } catch {
    return new Response(null, { status: 401 });
  }

  const domain = (new URL(request.url).searchParams.get("domain") ?? "").trim().toLowerCase();
  if (!isBareDomain(domain)) return new Response(null, { status: 400 });

  try {
    const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // An unknown domain comes back 404 with a generic globe: let the client draw its monogram.
    if (!res.ok || !res.body) return notFound();
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) return notFound();
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return notFound();
    const bytes = await readCapped(res.body);
    if (!bytes) return notFound();
    return new Response(bytes, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=604800, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  } catch {
    return notFound();
  }
}
