import { del, put } from "@/lib/blob-lazy";

/**
 * The only code that talks to Vercel Blob about contact photos.
 *
 * RANDOM SUFFIX. The object is public (the avatar route redirects the browser to it), so the
 * URL itself is the only secret: `avatars/<contactId>.jpg` was guessable from a contact id.
 * A random suffix makes each photo a new object, so whoever replaces or deletes a photo also
 * deletes the old object — `deleteReplacedAvatar` and `deleteAvatarBlobs` below.
 *
 * Deletes are best-effort by contract: an orphaned object is a cost problem, a delete that
 * blocks on a Blob outage is a privacy one.
 */
export type AvatarBlobClient = {
  put(
    pathname: string,
    body: Buffer,
    options: { access: "public"; contentType: string; addRandomSuffix: boolean }
  ): Promise<{ url: string }>;
  del(urls: string[]): Promise<void>;
};

const defaultClient: AvatarBlobClient = {
  put: (pathname, body, options) => put(pathname, body, options),
  del: (urls) => del(urls),
};

let testClient: AvatarBlobClient | null = null;

/** Test seam: route every avatar Blob call through `client` until called with null. */
export function setAvatarBlobClientForTests(client: AvatarBlobClient | null): void {
  testClient = client;
}

function client(): AvatarBlobClient {
  return testClient ?? defaultClient;
}

const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";
const DELETE_BATCH = 100;

export function isAvatarBlobUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith(BLOB_HOST_SUFFIX) && parsed.pathname.startsWith("/avatars/");
  } catch {
    return false;
  }
}

export async function putAvatarBlob(
  contactId: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  const blob = await client().put(`avatars/${contactId}.jpg`, body, {
    access: "public",
    contentType,
    addRandomSuffix: true,
  });
  return blob.url;
}

/** Deletes every Blob avatar among `urls`; returns how many were deleted. Never throws. */
export async function deleteAvatarBlobs(
  urls: ReadonlyArray<string | null | undefined>
): Promise<number> {
  const targets = [...new Set(urls.filter(isAvatarBlobUrl))];
  let deleted = 0;
  for (let i = 0; i < targets.length; i += DELETE_BATCH) {
    const chunk = targets.slice(i, i + DELETE_BATCH);
    try {
      await client().del(chunk);
      deleted += chunk.length;
    } catch {
      // See the header: never fail the caller over an orphaned object.
    }
  }
  return deleted;
}

/** After a contact's stored photo changed, delete the object the old URL pointed at. */
export async function deleteReplacedAvatar(
  previous: string | null | undefined,
  next: string | null | undefined
): Promise<void> {
  if (previous && previous !== next) await deleteAvatarBlobs([previous]);
}
