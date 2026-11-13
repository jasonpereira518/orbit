/**
 * LinkedIn URL primitives shared by the identity helpers (plan P4.3): ONE slug extractor, ONE
 * canonical profile-URL builder, ONE "is this a LinkedIn URL" predicate.
 *
 * The exported helpers elsewhere (`linkedinSlug`, `normalizeLinkedinUrl`, `canonicalLinkedInUrl`,
 * `buildLinkedInUrl`, `linkedinUrlFrom`) keep their own output forms on purpose; they differ in
 * case, trimming and fallback and are pinned by `identity-helpers.test.ts`. They all build on
 * the pieces here.
 *
 * `linkedinSlug` must stay equal to the `linkedin_slug` generated column in `src/db/index.ts`
 * (a SQL spelling of the same rule, which is NOT edited from here).
 */

export const LINKEDIN_WWW_ORIGIN = "https://www.linkedin.com";

/** `linkedin.com/in/<slug>` anywhere in the string; the slug stops at `/`, `?` or `#`. */
const PROFILE_SLUG_RE = /linkedin\.com\/in\/([^/?#]+)/i;

/**
 * The raw (untrimmed, original-case) slug after `linkedin.com/in/`, or null when the string has
 * no such path. Callers apply their own case/trim rules.
 */
export function extractLinkedInSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(PROFILE_SLUG_RE);
  return match ? match[1] : null;
}

/** `https://www.linkedin.com/in/<slug>`; the slug is used exactly as given. */
export function canonicalLinkedInProfileUrl(slug: string): string {
  return `${LINKEDIN_WWW_ORIGIN}/in/${slug}`;
}

/**
 * Accepts any host under linkedin.com, including regional subdomains
 * (`uk.linkedin.com`) and bare hostnames without a scheme, both of which appear in
 * real Connections.csv exports. Rejects a well-formed URL on some other host, which
 * is the actual reported bug: `https://evil.example.com/not-linkedin` saved happily
 * into the LinkedIn field.
 */
export function isLinkedInProfileUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase();
    return host === "linkedin.com" || host.endsWith(".linkedin.com");
  } catch {
    return /linkedin\.com\//i.test(trimmed);
  }
}
