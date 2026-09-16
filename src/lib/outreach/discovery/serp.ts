import { canonicalLinkedinUrl } from "@/lib/outreach/identity";

export type SerpResult = { url: string; title: string; description: string; extraSnippets: string[] };
export type LinkedinCandidate = {
  fullName: string;
  headline: string | null;
  company: string | null;
  location: string | null;
  linkedinUrl: string;
  snippet: string;
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
      const lower = code.toLowerCase();
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
      return ENTITIES[lower] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const SEPARATOR = /\s+[-–—|·]\s+/;
const NOT_A_NAME = /^(linkedin|jobs?|people|posts?|log ?in|sign ?up|join now)$/i;
const CREDENTIALS = /,\s*(mba|phd|ph\.d\.|cpa|cfa|pmp|md|jd|msc|ms|ma)\b.*$/i;

function field(description: string, label: string): string | null {
  const match = description.match(new RegExp(`${label}:\\s*([^·|]+?)(?:\\s*[·|]|$)`, "i"));
  return match?.[1]?.trim() || null;
}

/**
 * A Brave web result → a LinkedIn profile candidate, or null when the result is not a person.
 * Everything here is untrusted page text; it only ever becomes display fields and evidence.
 */
export function parseLinkedinResult(result: SerpResult): LinkedinCandidate | null {
  const linkedinUrl = canonicalLinkedinUrl(result.url);
  if (!linkedinUrl) return null;

  const title = stripHtml(result.title).replace(/\s*[|\-–—]\s*LinkedIn\s*$/i, "").trim();
  const parts = title.split(SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const fullName = parts[0].replace(CREDENTIALS, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (fullName.length < 2 || fullName.length > 80 || NOT_A_NAME.test(fullName) || !/\p{L}/u.test(fullName)) {
    return null;
  }

  const description = stripHtml([result.description, ...result.extraSnippets].filter(Boolean).join(" · "));
  let headline: string | null = null;
  let company: string | null = null;
  if (parts.length >= 3) {
    headline = parts.slice(1, -1).join(" - ");
    company = parts[parts.length - 1];
  } else if (parts.length === 2) {
    headline = parts[1];
  }
  company ??= field(description, "Experience");
  if (!company && headline) company = headline.match(/\bat\s+(.+)$/i)?.[1]?.trim() ?? null;
  if (company && headline === company) headline = null;

  return {
    fullName,
    headline: headline ? headline.slice(0, 200) : null,
    company: company ? company.slice(0, 120) : null,
    location: field(description, "Location")?.slice(0, 120) ?? null,
    linkedinUrl,
    snippet: description.slice(0, 1000),
  };
}
