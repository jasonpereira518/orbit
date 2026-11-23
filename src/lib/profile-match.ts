/**
 * Is a profile the web search found really this contact? (contact-info accuracy plan, PR 5)
 *
 * A model saying "confident" is not enough to write a LinkedIn URL onto someone found by name:
 * namesakes are the whole risk. Two cheap checks the model cannot talk its way past:
 *
 *   citedLinkedInUrl  the URL it reports must be a profile one of the search's own sources
 *                     points at, not one it composed.
 *   corroborates      the name matches (same, or the same tokens reordered/cased), AND a
 *                     company or school in the answer matches one Orbit already knows for them
 *                     (their company, their work email's domain, their school).
 *
 * Pure. Covered by scripts/smoke-profile-match.ts.
 */
import type { WebSource } from "@/lib/ai";
import { companyFamilyRoot } from "@/lib/company-family";
import { normalizeCompanyKey } from "@/lib/company-name";
import { linkedinSlug } from "@/lib/duplicates";
import { companyFromEmail } from "@/lib/guest-profiles";
import { compareNames } from "@/lib/names/compare";

/** The reported URL, only when a cited source is that same profile. Canonical form. */
export function citedLinkedInUrl(url: unknown, sources: Pick<WebSource, "url">[]): string | null {
  const slug = typeof url === "string" ? linkedinSlug(url) : "";
  if (!slug) return null;
  return sources.some((s) => linkedinSlug(s.url) === slug) ? `https://www.linkedin.com/in/${slug}` : null;
}

const orgKey = (v: string | null | undefined) => (v?.trim() ? (companyFamilyRoot(v) ?? normalizeCompanyKey(v)) : "");

/**
 * A full name and an employer or school to search with: worth a search without a profile URL.
 * Not an email domain: the search is disclosed (/privacy) as by name, employer and profile
 * link, so the domain is only ever read here, locally, by `corroborates`.
 */
export function findableWithoutUrl(contact: { fullName: string; company: string | null; school: string | null }): boolean {
  const tokens = contact.fullName.trim().split(/\s+/).filter((t) => t.length > 1);
  return tokens.length >= 2 && Boolean(contact.company?.trim() || contact.school?.trim());
}

export function corroborates(
  contact: { fullName: string; company: string | null; email: string | null; school: string | null },
  answer: { name: string | null; experiences: Array<{ kind: string; organization: string }> }
): boolean {
  const relation = compareNames(contact.fullName, answer.name);
  if (relation !== "same" && relation !== "variant") return false;
  const known = new Set([orgKey(contact.company), orgKey(companyFromEmail(contact.email))].filter(Boolean));
  const school = orgKey(contact.school);
  return answer.experiences.some((e) => {
    const key = orgKey(e.organization);
    if (!key) return false;
    return e.kind === "education" ? key === school : known.has(key);
  });
}
