import { isLinkedInProfilePhoto } from "@/lib/contact-avatar-url";

/**
 * Social crawler and browser User-Agents for fetching LinkedIn public profile metadata.
 * Social preview crawlers are prioritized because LinkedIn's servers consistently serve
 * OpenGraph preview tags (og:image) to them without an authentication wall.
 */
const CRAWLER_USER_AGENTS = [
  "Twitterbot/1.0",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.html)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

export type LinkedInScrapeFetch = (url: string, init?: RequestInit) => Promise<Response>;

let testFetch: LinkedInScrapeFetch | null = null;

/** Test seam: route LinkedIn scraping through custom fetch until cleared. */
export function setLinkedInScrapeFetchForTests(fetchFn: LinkedInScrapeFetch | null): void {
  testFetch = fetchFn;
}

export type ScrapedLinkedInPhoto = {
  imageUrl: string;
  source: "linkedin_direct";
};

export class LinkedInDirectRateLimitError extends Error {
  readonly resetAt: number;
  readonly source = "linkedin_direct";

  constructor(resetAt: number, message = "LinkedIn direct scrape rate limited") {
    super(message);
    this.name = "LinkedInDirectRateLimitError";
    this.resetAt = resetAt;
  }
}

/** In-memory cooldown timestamp (epoch ms) to protect against hammering LinkedIn if rate limited. */
let directCooldownUntil = 0;

export function getLinkedInDirectCooldownUntil(): number {
  return directCooldownUntil;
}

export function isLinkedInDirectRateLimited(now = Date.now()): boolean {
  return now < directCooldownUntil;
}

export function noteLinkedInDirectRateLimit(resetAtMs: number): void {
  directCooldownUntil = Math.max(directCooldownUntil, resetAtMs, Date.now() + 60_000);
}

/**
 * Extract image URL from raw HTML via OpenGraph, Twitter card, or JSON-LD schema.
 */
export function extractLinkedInProfilePhotoFromHtml(html: string): string | null {
  if (!html) return null;

  // 1. og:image tag (standard property="og:image" content="..." or content="..." property="og:image")
  const ogMatches = [
    /<meta\s+[^>]*property=["']og:image["']\s+content=["']([^"']+)["']/i,
    /<meta\s+[^>]*content=["']([^"']+)["']\s+property=["']og:image["']/i,
    /<meta\s+[^>]*name=["']twitter:image["']\s+content=["']([^"']+)["']/i,
    /<meta\s+[^>]*content=["']([^"']+)["']\s+name=["']twitter:image["']/i,
  ];

  for (const regex of ogMatches) {
    const match = regex.exec(html);
    if (match?.[1]) {
      const decoded = match[1].replace(/&amp;/g, "&").trim();
      if (isLinkedInProfilePhoto(decoded)) {
        return decoded;
      }
    }
  }

  // 2. JSON-LD schema parser fallback
  const ldJsonMatches = html.match(/<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (ldJsonMatches) {
    for (const tag of ldJsonMatches) {
      try {
        const jsonContent = tag.replace(/<\/?script[^>]*>/gi, "").trim();
        const parsed = JSON.parse(jsonContent);
        const img = parsed?.image?.contentUrl || parsed?.image?.url || parsed?.image;
        if (typeof img === "string") {
          const decoded = img.replace(/&amp;/g, "&").trim();
          if (isLinkedInProfilePhoto(decoded)) {
            return decoded;
          }
        }
      } catch {
        // Skip malformed JSON-LD
      }
    }
  }

  return null;
}

/**
 * Extract a person's real name from og:title, twitter:title, or <title>.
 * Handles patterns like "Satya Nadella - Microsoft | LinkedIn" or "Bill Gates - Gates Foundation | LinkedIn".
 */
export function extractLinkedInFullNameFromHtml(html: string): string | null {
  if (!html) return null;

  const titleMatches = [
    /<meta\s+[^>]*property=["']og:title["']\s+content=["']([^"']+)["']/i,
    /<meta\s+[^>]*content=["']([^"']+)["']\s+property=["']og:title["']/i,
    /<meta\s+[^>]*name=["']twitter:title["']\s+content=["']([^"']+)["']/i,
    /<meta\s+[^>]*content=["']([^"']+)["']\s+name=["']twitter:title["']/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ];

  for (const regex of titleMatches) {
    const match = regex.exec(html);
    if (match?.[1]) {
      const raw = match[1].replace(/&amp;/g, "&").trim();
      const namePart = raw.split(/\s+[-|–—]\s+/)[0]?.trim();
      if (
        namePart &&
        namePart.length > 1 &&
        namePart.length < 80 &&
        !/^(linkedin|sign in|log in|join)/i.test(namePart)
      ) {
        return namePart;
      }
    }
  }

  return null;
}

export type LinkedInPublicMetadata = {
  imageUrl: string | null;
  fullName: string | null;
};

/**
 * Fetch both profile photo and full name directly from public LinkedIn HTML metadata.
 */
export async function fetchLinkedInMetadataDirect(
  slug: string,
  fetchFn?: LinkedInScrapeFetch
): Promise<LinkedInPublicMetadata | null> {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) return null;

  if (isLinkedInDirectRateLimited()) {
    throw new LinkedInDirectRateLimitError(directCooldownUntil);
  }

  const url = `https://www.linkedin.com/in/${encodeURIComponent(normalizedSlug)}`;
  const effectiveFetch = fetchFn ?? testFetch ?? globalThis.fetch;
  const ua = CRAWLER_USER_AGENTS[Math.floor(Math.random() * CRAWLER_USER_AGENTS.length)];

  try {
    const res = await effectiveFetch(url, {
      headers: {
        "User-Agent": ua,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
      },
      signal: AbortSignal.timeout(6000),
      redirect: "follow",
    });

    if (res.status === 429 || res.status === 999) {
      const resetAt = Date.now() + 60_000;
      noteLinkedInDirectRateLimit(resetAt);
      throw new LinkedInDirectRateLimitError(resetAt);
    }

    if (!res.ok) {
      return null;
    }

    const finalUrl = res.url || "";
    if (finalUrl.includes("/authwall") || finalUrl.includes("/checkpoint/")) {
      const resetAt = Date.now() + 30_000;
      noteLinkedInDirectRateLimit(resetAt);
      throw new LinkedInDirectRateLimitError(resetAt, "LinkedIn authwall challenge");
    }

    const html = await res.text();
    const imageUrl = extractLinkedInProfilePhotoFromHtml(html);
    const fullName = extractLinkedInFullNameFromHtml(html);
    return { imageUrl, fullName };
  } catch (err) {
    if (err instanceof LinkedInDirectRateLimitError) throw err;
    return null;
  }
}

/**
 * Fetch a LinkedIn profile photo directly from public HTML metadata.
 * Free, zero API cost, zero third-party quota.
 */
export async function fetchLinkedInOgImageDirect(
  slug: string,
  fetchFn?: LinkedInScrapeFetch
): Promise<string | null> {
  const meta = await fetchLinkedInMetadataDirect(slug, fetchFn);
  return meta?.imageUrl ?? null;
}
