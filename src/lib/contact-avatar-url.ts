const BROKEN_AVATAR_HOSTS = [
  "unavatar.io",
  "static.licdn.com/aero",
];

/** Host suffix for our Vercel Blob avatar store. */
const BLOB_AVATAR_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/**
 * Marker written when a LinkedIn photo lookup found nothing.
 *
 * Without it, `/api/avatars/[contactId]` re-ran the whole Microlink + Unavatar resolution
 * on EVERY page view of every photoless contact, because a failure persisted nothing.
 * Browsing ~30 profiles in a minute exhausted `RATE_LIMITS.avatarResolve` (30/min) and
 * started returning 429s — for contacts that were never going to have a photo.
 *
 * A sentinel in `profileImageUrl` rather than a new column: every reader already funnels
 * through the two predicates below, so teaching them this shape makes the marker
 * invisible everywhere else, and no migration is involved.
 */
const NO_PHOTO_PREFIX = "orbit:no-photo:";

/** How long to trust a negative result before trying the provider again. */
const NO_PHOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function noPhotoMarker(now: Date = new Date()) {
  return `${NO_PHOTO_PREFIX}${now.getTime()}`;
}

/** True while a "we looked and found nothing" marker is still fresh. */
export function hasFreshNoPhotoMarker(
  url: string | null | undefined,
  now: Date = new Date()
): boolean {
  const u = url?.trim();
  if (!u?.startsWith(NO_PHOTO_PREFIX)) return false;
  const at = Number(u.slice(NO_PHOTO_PREFIX.length));
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at < NO_PHOTO_TTL_MS;
}

/** True when a stored URL is known-bad in the browser (rate limits / placeholders). */
export function isUnusableAvatarUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return true;
  const u = url.trim();
  // The negative-cache marker is not a photo — every client must fall back to initials.
  if (u.startsWith(NO_PHOTO_PREFIX)) return true;
  if (u.startsWith("data:image/")) return false;
  return BROKEN_AVATAR_HOSTS.some((h) => u.includes(h));
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
