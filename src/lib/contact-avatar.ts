import { linkedinSlug } from "@/lib/duplicates";

/** Max bytes we'll persist as a data-URL thumbnail. */
const MAX_IMAGE_BYTES = 180_000;

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

/**
 * @deprecated Prefer fetchLinkedInPhotoDataUrl / resolveContactPhotoUrl.
 * Kept for any lingering call sites; returns null so callers fall back safely.
 */
export function linkedinAvatarUrl(
  _linkedinUrl: string | null | undefined
): string | null {
  return null;
}

/**
 * Resolve a LinkedIn profile photo and return a durable data URL.
 * Uses Microlink meta (LinkedIn OG image), then downloads the bytes.
 */
export async function fetchLinkedInPhotoDataUrl(
  linkedinUrl: string
): Promise<string | null> {
  const slug = linkedinSlug(linkedinUrl);
  if (!slug) return null;

  const normalized = linkedinUrl.includes("linkedin.com/in/")
    ? linkedinUrl.trim()
    : `https://www.linkedin.com/in/${slug}`;

  const imageUrl = await resolveLinkedInOgImage(normalized);
  if (!imageUrl) return null;
  return downloadImageAsDataUrl(imageUrl);
}

/** Download an external image and return a data URL, or null on failure. */
export async function downloadImageAsDataUrl(
  imageUrl: string
): Promise<string | null> {
  if (imageUrl.startsWith("data:image/")) return imageUrl;
  if (isUnusableAvatarUrl(imageUrl)) return null;

  try {
    const res = await fetch(imageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: "https://www.linkedin.com/",
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!res.ok) return null;

    const contentType = (res.headers.get("content-type") || "image/jpeg")
      .split(";")[0]
      .trim();
    if (!contentType.startsWith("image/")) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;

    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function resolveLinkedInOgImage(
  linkedinUrl: string
): Promise<string | null> {
  try {
    const endpoint = new URL("https://api.microlink.io/");
    endpoint.searchParams.set("url", linkedinUrl);
    endpoint.searchParams.set("palette", "false");

    const res = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      status?: string;
      data?: { image?: { url?: string } | string | null };
    };
    if (json.status !== "success") return null;

    const image = json.data?.image;
    const url = typeof image === "string" ? image : image?.url;
    if (!url?.startsWith("http")) return null;
    if (url.includes("static.licdn.com/aero")) return null;
    return url;
  } catch {
    return null;
  }
}
