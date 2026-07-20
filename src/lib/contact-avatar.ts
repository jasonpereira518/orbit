import { linkedinSlug } from "@/lib/duplicates";

/** Build an unavatar URL for a LinkedIn profile, or null if no usable slug. */
export function linkedinAvatarUrl(
  linkedinUrl: string | null | undefined
): string | null {
  const slug = linkedinSlug(linkedinUrl);
  if (!slug) return null;
  // Prefer explicit user type so company URLs don't get mis-resolved.
  // fallback=false → 404 when unresolved, so AvatarFallback silhouettes show.
  return `https://unavatar.io/linkedin/user:${encodeURIComponent(slug)}?fallback=false`;
}
