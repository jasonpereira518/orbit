import { get } from "@/lib/blob-lazy";

/**
 * Photos of a person's notes and screenshots of their CRM are stored PRIVATE.
 *
 * They used to be public Blob objects protected only by an unguessable URL — a leaked URL
 * (a log line, a copied link, a browser history) was a permanent, unauthenticated link to a
 * picture of someone's business card or notebook. Private objects need the store's token to
 * read, so only the owner-checked proxy routes (`/api/capture/photos/[id]`,
 * `/api/feedback/screenshots/[id]`) can serve them. Email attachments were already private.
 *
 * Rows written before the switch still hold public URLs until
 * `scripts/migrate-private-blobs.ts` moves them, so reads handle both.
 */
export const PRIVATE_BLOB_ACCESS = "private" as const;

export function isPublicBlobUrl(url: string): boolean {
  return url.includes(".public.blob.vercel-storage.com/");
}

/** The object's bytes as a stream, or null when it is gone. */
export async function readStoredBlob(url: string): Promise<ReadableStream<Uint8Array> | null> {
  if (isPublicBlobUrl(url)) {
    const upstream = await fetch(url, { cache: "no-store" });
    return upstream.ok && upstream.body ? upstream.body : null;
  }
  const res = await get(url, { access: PRIVATE_BLOB_ACCESS });
  return res && res.statusCode === 200 && res.stream ? res.stream : null;
}
