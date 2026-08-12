const BROKEN_AVATAR_HOSTS = [
  "unavatar.io",
  "static.licdn.com/aero",
];

/** True when a stored URL is known-bad in the browser (rate limits / placeholders). */
export function isUnusableAvatarUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return true;
  const u = url.trim();
  if (u.startsWith("data:image/")) return false;
  return BROKEN_AVATAR_HOSTS.some((h) => u.includes(h));
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
