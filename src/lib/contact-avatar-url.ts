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
/**
 * Exported because the SQL mirrors in `contact-avatar-sql.ts` and `avatar-backfill.ts`
 * interpolate it rather than restating the literal. Those two carry a comment telling you to
 * keep them in step with these predicates, and the marker shipped without either being
 * updated — so the value is now shared rather than promised.
 */
export const NO_PHOTO_PREFIX = "orbit:no-photo:";

/** How long to trust a negative result before trying the provider again. */
export const NO_PHOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function noPhotoMarker(now: Date = new Date()) {
  return `${NO_PHOTO_PREFIX}${now.getTime()}`;
}

/** An https `media.licdn.com` URL with a `/profile-displayphoto…` or `/profile-framedphoto…` path segment: a LinkedIn profile photo. */
export function isLinkedInProfilePhoto(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "media.licdn.com" &&
      parsed.pathname.split("/").some((seg) => seg.startsWith("profile-displayphoto") || seg.startsWith("profile-framedphoto"))
    );
  } catch {
    return false;
  }
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
 * The `?v=` of a route URL that has no photo URL to hash: an inline photo, or one still to be
 * resolved on demand. The route treats it as "not versioned", so a redirect it answers under
 * this URL is never cached (the photo behind it can change without the URL changing). Its
 * 404s and inline bytes are cacheable, which is the point of sending it at all.
 */
export const AVATAR_NO_VERSION = "0";

/**
 * `/api/avatars/{id}`, versioned by the photo the caller can see. EVERY route URL carries `?v=`.
 *
 * The route answers a stored Blob or shared photo with a redirect, and a redirect the
 * browser may not cache is one authenticated function call per avatar per render — about
 * fifty on a contacts page (LATENCY_PLAN NET-1). With `?v=` the route marks the redirect
 * cacheable for a day, and the version is a hash of the photo URL the list or profile
 * already holds, so a new photo is a new URL: the browser never serves a stale one. An inline
 * photo and on-demand resolution have no photo URL to hash and get {@link AVATAR_NO_VERSION}:
 * the route still caches their 404s and inline bytes, never a redirect.
 */
export function avatarRouteUrl(contactId: string, visibleUrl: string | null | undefined): string {
  const base = `/api/avatars/${contactId}`;
  const u = visibleUrl?.trim();
  // Already a route URL: keep the version or cache-busting query the caller put on it
  // (`?v=` from the SQL/inline builders, `?t=` after a backfill).
  if (u?.startsWith(`${base}?`)) return u;
  if (!u || isUnusableAvatarUrl(u) || u.startsWith("/api/avatars/") || u.startsWith("data:")) {
    return `${base}?v=${AVATAR_NO_VERSION}`;
  }
  return `${base}?v=${avatarVersion(u)}`;
}

/** FNV-1a over the URL, base 36: short, stable, and different whenever the photo is. */
export function avatarVersion(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * True when a stored URL is already durable (a legacy inline data URL, or a
 * photo we've already uploaded to Blob storage) and needs no further work.
 */
export function isDurableAvatarUrl(url: string | null | undefined): boolean {
  const u = url?.trim();
  if (!u) return false;
  return u.startsWith("data:image/") || isBlobStoreUrl(u);
}

/**
 * The Blob store by parsed hostname, never by substring: `/api/avatars/[contactId]`
 * redirects to a durable URL, and `https://evil.tld/.public.blob.vercel-storage.com`
 * contains the suffix too.
 */
function isBlobStoreUrl(u: string): boolean {
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === "https:" && hostname.endsWith(BLOB_AVATAR_HOST_SUFFIX);
  } catch {
    return false;
  }
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
    return `/api/avatars/${contactId}?v=${AVATAR_NO_VERSION}`;
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
