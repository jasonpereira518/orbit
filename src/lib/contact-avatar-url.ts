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

/** Pick a browser-safe photo URL, or null to show the silhouette fallback. */
export function resolveContactPhotoUrl(
  profileImageUrl: string | null | undefined
): string | null {
  const stored = profileImageUrl?.trim();
  if (stored && !isUnusableAvatarUrl(stored)) {
    return stored;
  }
  // Do not hit unavatar.io from the browser — anonymous daily limits break the list.
  return null;
}
