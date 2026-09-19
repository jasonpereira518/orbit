const BROKEN_AVATAR_HOSTS = [
  "unavatar.io",
  "static.licdn.com/aero",
];

/**
 * Hosts that only ever serve a generic placeholder, so fetching them server-side
 * cannot yield a real headshot.
 *
 * Deliberately NOT the same list as {@link BROKEN_AVATAR_HOSTS}, which answers a
 * different question: whether a *stored* value is safe to hand the browser.
 * `unavatar.io` is unusable to render (anonymous per-browser rate limits) but is
 * perfectly fetchable from the server — it is our free LinkedIn resolver. Adding
 * it here would silently kill that tier.
 */
const PLACEHOLDER_IMAGE_HOSTS = ["static.licdn.com/aero"];

/** Host suffix for our Vercel Blob avatar store. */
const BLOB_AVATAR_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/** True when a stored URL is known-bad in the browser (rate limits / placeholders). */
export function isUnusableAvatarUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return true;
  const u = url.trim();
  if (u.startsWith("data:image/")) return false;
  return BROKEN_AVATAR_HOSTS.some((h) => u.includes(h));
}

/**
 * True when fetching this URL server-side could not possibly yield a real headshot,
 * so the download is not worth attempting.
 *
 * This is the *fetch* guard. {@link isUnusableAvatarUrl} is the *render* guard.
 * Conflating the two is what made the Unavatar tier dead code: the resolver built a
 * `unavatar.io` URL and the download path rejected it for being unrenderable, even
 * though nothing ever stores that URL — the bytes are persisted inline or to Blob.
 */
export function isUnfetchableImageUrl(url: string | null | undefined): boolean {
  const u = url?.trim();
  if (!u) return true;
  return PLACEHOLDER_IMAGE_HOSTS.some((h) => u.includes(h));
}

/**
 * True when a stored URL is already durable (a legacy inline data URL, or a
 * photo we've already uploaded to Blob storage) and needs no further work.
 */
export function isDurableAvatarUrl(url: string | null | undefined): boolean {
  const u = url?.trim();
  if (!u) return false;
  return u.startsWith("data:image/") || u.includes(BLOB_AVATAR_HOST_SUFFIX);
}

/**
 * Browser-safe photo URL for list/graph payloads.
 * Never returns a data: URL — those stay server-side and are served via
 * `/api/avatars/[contactId]` to keep RSC payloads small.
 */
export function clientContactAvatarUrl(
  contactId: string,
  profileImageUrl: string | null | undefined
): string | null {
  const stored = profileImageUrl?.trim();
  if (!stored || isUnusableAvatarUrl(stored)) return null;
  if (stored.startsWith("data:image/")) {
    return `/api/avatars/${contactId}`;
  }
  return stored;
}

/** Pick a browser-safe photo URL, or null to show the silhouette fallback. */
export function resolveContactPhotoUrl(
  profileImageUrl: string | null | undefined
): string | null {
  const stored = profileImageUrl?.trim();
  if (stored && !isUnusableAvatarUrl(stored)) {
    // data: URLs should have been rewritten to /api/avatars before reaching the client.
    // Still allow them for single-contact detail if a caller passed one through.
    return stored;
  }
  // Do not hit unavatar.io from the browser — anonymous daily limits break the list.
  return null;
}
