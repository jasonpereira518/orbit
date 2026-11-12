import { isLinkedInProfilePhoto } from "@/lib/contact-avatar-url";
import { isPersonName } from "@/lib/names/classify";
import { splitName } from "@/lib/names/parse";

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
  /** Why LinkedIn said no: its HTTP status (429, 999), 1 for an authwall redirect, 0 for our own cooldown. */
  readonly status: number;

  constructor(resetAt: number, message = "LinkedIn direct scrape rate limited", status = 0) {
    super(message);
    this.name = "LinkedInDirectRateLimitError";
    this.resetAt = resetAt;
    this.status = status;
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

export function resetLinkedInDirectCooldownForTesting(): void {
  directCooldownUntil = 0;
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

export type LinkedInFullProfile = {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  school: string | null;
  imageUrl: string | null;
};

function cleanText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function isLikelyPersonName(name: string | null): boolean {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length > 80) return false;
  if (/^(linkedin|sign in|log in|join|profile|welcome)/i.test(trimmed)) return false;
  return isPersonName(trimmed);
}

export function splitFullName(fullName: string | null): { first: string | null; last: string | null } {
  const { firstName, lastName } = splitName(fullName);
  return { first: firstName, last: lastName };
}

export function splitHeadline(headline: string | null): { title: string | null; company: string | null } {
  if (!headline) return { title: null, company: null };
  const trimmed = headline.trim();
  // Pattern 1: "Role at Company" or "Role @ Company"
  const atMatch = trimmed.match(/^(.{2,80}?)\s+(?:at|@)\s+(.{2,80}?)$/i);
  if (atMatch) {
    return { title: atMatch[1].trim(), company: atMatch[2].trim() };
  }
  // Pattern 2: "Role - Company"
  const dashMatch = trimmed.match(/^(.{2,80}?)\s+[-–—]\s+(.{2,80}?)$/);
  if (dashMatch) {
    return { title: dashMatch[1].trim(), company: dashMatch[2].trim() };
  }
  return { title: trimmed, company: null };
}

type JsonLdPersonData = {
  name?: string | null;
  jobTitle?: string | null;
  worksFor?: string | null;
  alumniOf?: string | null;
  address?: string | null;
  image?: string | null;
};

function extractJsonLdPerson(html: string): JsonLdPersonData | null {
  const ldJsonMatches = html.match(/<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (!ldJsonMatches) return null;

  for (const tag of ldJsonMatches) {
    try {
      const jsonContent = tag.replace(/<\/?script[^>]*>/gi, "").trim();
      const parsed = JSON.parse(jsonContent);

      const findPerson = (obj: unknown): Record<string, unknown> | null => {
        if (!obj || typeof obj !== "object") return null;
        if (Array.isArray(obj)) {
          for (const item of obj) {
            const found = findPerson(item);
            if (found) return found;
          }
          return null;
        }
        const record = obj as Record<string, unknown>;
        const type = record["@type"];
        const types = Array.isArray(type) ? type : [type];
        if (types.includes("Person")) return record;
        for (const val of Object.values(record)) {
          const found = findPerson(val);
          if (found) return found;
        }
        return null;
      };

      const person = findPerson(parsed);
      if (person) {
        let worksForName: string | null = null;
        if (typeof person.worksFor === "string") worksForName = person.worksFor;
        else if (Array.isArray(person.worksFor) && person.worksFor[0]) {
          const first = person.worksFor[0];
          worksForName = typeof first === "string" ? first : (first as { name?: string }).name ?? null;
        } else if (person.worksFor && typeof person.worksFor === "object") {
          worksForName = (person.worksFor as { name?: string }).name ?? null;
        }

        let alumniOfName: string | null = null;
        if (typeof person.alumniOf === "string") alumniOfName = person.alumniOf;
        else if (Array.isArray(person.alumniOf) && person.alumniOf[0]) {
          const first = person.alumniOf[0];
          alumniOfName = typeof first === "string" ? first : (first as { name?: string }).name ?? null;
        } else if (person.alumniOf && typeof person.alumniOf === "object") {
          alumniOfName = (person.alumniOf as { name?: string }).name ?? null;
        }

        let addressText: string | null = null;
        if (typeof person.address === "string") addressText = person.address;
        else if (person.address && typeof person.address === "object") {
          const addr = person.address as { addressLocality?: string; addressRegion?: string; addressCountry?: string };
          const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
          if (parts.length > 0) addressText = parts.join(", ");
        }

        let jobTitle: string | null = null;
        if (typeof person.jobTitle === "string") jobTitle = person.jobTitle;
        else if (Array.isArray(person.jobTitle) && person.jobTitle[0]) {
          jobTitle = String(person.jobTitle[0]);
        }

        let image: string | null = null;
        const rawImg = (person.image as { contentUrl?: string; url?: string } | undefined)?.contentUrl ||
          (person.image as { contentUrl?: string; url?: string } | undefined)?.url ||
          person.image;
        if (typeof rawImg === "string" && isLinkedInProfilePhoto(rawImg)) {
          image = rawImg;
        }

        return {
          name: cleanText(person.name),
          jobTitle: cleanText(jobTitle),
          worksFor: cleanText(worksForName),
          alumniOf: cleanText(alumniOfName),
          address: cleanText(addressText),
          image: cleanText(image),
        };
      }
    } catch {
      // Continue searching other blocks
    }
  }
  return null;
}

/**
 * Extract full profile fields (name, title, company, location, school, avatar) from raw LinkedIn HTML.
 */
export function extractLinkedInFullProfileFromHtml(html: string): LinkedInFullProfile {
  if (!html) {
    return {
      fullName: null,
      firstName: null,
      lastName: null,
      title: null,
      company: null,
      location: null,
      school: null,
      imageUrl: null,
    };
  }

  const jsonLd = extractJsonLdPerson(html);
  const imageUrl = jsonLd?.image || extractLinkedInProfilePhotoFromHtml(html);

  // Parse Title / OG Title
  let ogName: string | null = null;
  let ogTitle: string | null = null;
  let ogCompany: string | null = null;

  const titlePatterns = [
    /<meta\s+[^>]*property=["']og:title["']\s+content=["']([^"']+)["']/i,
    /<meta\s+[^>]*content=["']([^"']+)["']\s+property=["']og:title["']/i,
    /<meta\s+[^>]*name=["']twitter:title["']\s+content=["']([^"']+)["']/i,
    /<meta\s+[^>]*content=["']([^"']+)["']\s+name=["']twitter:title["']/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ];

  for (const regex of titlePatterns) {
    const match = regex.exec(html);
    if (match?.[1]) {
      let raw = cleanText(match[1]);
      if (raw) {
        // Strip "| LinkedIn" or "- LinkedIn"
        raw = raw.replace(/\s*[|·–—-]\s*LinkedIn.*$/i, "").trim();
        const parts = raw.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 3) {
          if (isLikelyPersonName(parts[0])) {
            ogName = parts[0]!;
            ogTitle = parts[1]!;
            ogCompany = parts.slice(2).join(" - ");
            break;
          }
        } else if (parts.length === 2) {
          if (isLikelyPersonName(parts[0])) {
            ogName = parts[0]!;
            const headlineParsed = splitHeadline(parts[1]!);
            ogTitle = headlineParsed.title;
            ogCompany = headlineParsed.company;
            break;
          }
        } else if (parts.length === 1 && isLikelyPersonName(parts[0])) {
          ogName = parts[0]!;
          break;
        }
      }
    }
  }

  // Parse OG Description for Experience, Education, Location
  let descTitle: string | null = null;
  let descCompany: string | null = null;
  let descSchool: string | null = null;
  let descLocation: string | null = null;

  const descPatterns = [
    /<meta\s+[^>]*property=["']og:description["']\s+content=["']([^"']+)["']/i,
    /<meta\s+[^>]*content=["']([^"']+)["']\s+property=["']og:description["']/i,
    /<meta\s+[^>]*name=["']description["']\s+content=["']([^"']+)["']/i,
    /<meta\s+[^>]*content=["']([^"']+)["']\s+name=["']description["']/i,
    /<meta\s+[^>]*name=["']twitter:description["']\s+content=["']([^"']+)["']/i,
    /<meta\s+[^>]*content=["']([^"']+)["']\s+name=["']twitter:description["']/i,
  ];

  for (const regex of descPatterns) {
    const match = regex.exec(html);
    if (match?.[1]) {
      const desc = cleanText(match[1]);
      if (desc) {
        const expMatch = desc.match(/(?:Experience|Current):\s*([^·\n]+)/i);
        if (expMatch?.[1]) {
          const expParsed = splitHeadline(expMatch[1]);
          descTitle = expParsed.title;
          descCompany = expParsed.company;
        }

        const eduMatch = desc.match(/Education:\s*([^·\n]+)/i);
        if (eduMatch?.[1]) {
          descSchool = cleanText(eduMatch[1]);
        }

        const locMatch = desc.match(/Location:\s*([^·\n]+)/i);
        if (locMatch?.[1]) {
          descLocation = cleanText(locMatch[1]);
        }

        if (descTitle || descSchool || descLocation) break;
      }
    }
  }

  const rawFullName = jsonLd?.name || ogName || extractLinkedInFullNameFromHtml(html);
  const fullName = isLikelyPersonName(rawFullName) ? rawFullName : null;
  const { first: firstName, last: lastName } = splitFullName(fullName);

  const title = jsonLd?.jobTitle || ogTitle || descTitle || null;
  const company = jsonLd?.worksFor || ogCompany || descCompany || null;
  const location = jsonLd?.address || descLocation || null;
  const school = jsonLd?.alumniOf || descSchool || null;

  return {
    fullName,
    firstName,
    lastName,
    title,
    company,
    location,
    school,
    imageUrl,
  };
}

/**
 * Fetch full profile directly from public LinkedIn HTML metadata.
 */
export async function fetchLinkedInFullProfileDirect(
  slug: string,
  fetchFn?: LinkedInScrapeFetch
): Promise<LinkedInFullProfile | null> {
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
      throw new LinkedInDirectRateLimitError(resetAt, undefined, res.status);
    }

    if (!res.ok) {
      return null;
    }

    const finalUrl = res.url || "";
    if (finalUrl.includes("/authwall") || finalUrl.includes("/checkpoint/")) {
      const resetAt = Date.now() + 30_000;
      noteLinkedInDirectRateLimit(resetAt);
      throw new LinkedInDirectRateLimitError(resetAt, "LinkedIn authwall challenge", 1);
    }

    const html = await res.text();
    return extractLinkedInFullProfileFromHtml(html);
  } catch (err) {
    if (err instanceof LinkedInDirectRateLimitError) throw err;
    return null;
  }
}

/**
 * Fetch both profile photo and full name directly from public LinkedIn HTML metadata.
 */
export async function fetchLinkedInMetadataDirect(
  slug: string,
  fetchFn?: LinkedInScrapeFetch
): Promise<LinkedInPublicMetadata | null> {
  const profile = await fetchLinkedInFullProfileDirect(slug, fetchFn);
  if (!profile) return null;
  return { imageUrl: profile.imageUrl, fullName: profile.fullName };
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
