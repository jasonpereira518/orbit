/**
 * Persisting an event's cover image.
 *
 * ## Why this does not reuse `downloadImageBytes`
 *
 * `src/lib/contact-avatar.ts` has a perfectly good image downloader, but it sets
 * `redirect: "follow"` and applies no address guard — which is correct for its own inputs
 * (LinkedIn CDN URLs Orbit constructed) and wrong for ours. An event cover URL is whatever
 * `og:image` said on a page a user pasted, so it is attacker-influenced and gets the same
 * `assertDeliverable` treatment as the page itself, on every hop.
 *
 * Everything else — the Blob store, the graceful degradation when it is unconfigured — is
 * borrowed from that module rather than reinvented.
 *
 * ## Degrading, not failing
 *
 * Without `BLOB_READ_WRITE_TOKEN` (`hasBlobStorage()` false — local dev, most previews) the
 * remote URL is kept as-is. A missing Blob token must never fail an enrichment: the cover is
 * a nicety, and the alternative is a local checkout where pasting an event link always errors.
 */
import { put } from "@vercel/blob";
import { hasBlobStorage } from "@/lib/contact-avatar";
import { assertDeliverable } from "@/lib/net-guard";

/** Covers are hero images, so a larger cap than an avatar's — but still a cap. */
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_HOPS = 2;
const TIMEOUT_MS = 8_000;

export type CoverResult = {
  /** What to render: a Blob URL when we could store it, else the remote URL. */
  url: string;
  /** Where it came from, kept so a re-enrichment can tell "already stored" from "changed". */
  sourceUrl: string;
  stored: boolean;
};

async function guardedImageFetch(startUrl: string): Promise<Response | null> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    // Re-checked per hop, exactly as in fetch-page.ts: clearance for one address is not
    // clearance for wherever it points next.
    await assertDeliverable(url);
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      await res.body?.cancel().catch(() => {});
      url = new URL(location, url).href;
      continue;
    }
    return res.ok ? res : null;
  }
  return null;
}

/**
 * Fetch a cover and store it, returning what the page should render.
 *
 * Returns null rather than throwing: a cover that cannot be fetched is a missing graphic,
 * not a failed import, and the hero falls back to a generated gradient (`eventGradient`).
 */
export async function persistEventCover(
  eventId: string,
  imageUrl: string
): Promise<CoverResult | null> {
  let res: Response | null;
  try {
    res = await guardedImageFetch(imageUrl);
  } catch {
    // A refused address or a dead host. Neither is worth an error row — the guard working
    // as designed looks identical here to a host being down.
    return null;
  }
  if (!res) return null;

  const contentType = (res.headers.get("content-type") || "").split(";")[0]!.trim();
  if (!contentType.startsWith("image/")) {
    await res.body?.cancel().catch(() => {});
    return null;
  }

  if (!hasBlobStorage()) {
    await res.body?.cancel().catch(() => {});
    return { url: imageUrl, sourceUrl: imageUrl, stored: false };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > MAX_COVER_BYTES) {
    return { url: imageUrl, sourceUrl: imageUrl, stored: false };
  }

  try {
    const extension = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
    const blob = await put(`event-covers/${eventId}.${extension}`, buf, {
      access: "public",
      contentType,
      // Same id every time, so re-enriching an event replaces its cover rather than
      // accumulating orphans in the store.
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return { url: blob.url, sourceUrl: imageUrl, stored: true };
  } catch {
    // Storage refused it; the remote URL still renders.
    return { url: imageUrl, sourceUrl: imageUrl, stored: false };
  }
}
