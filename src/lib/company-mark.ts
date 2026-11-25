import { lookupBrand } from "@/lib/brand-colors";
import { companyBrandColor } from "@/lib/company-brand";
import { normalizeCompanyName } from "@/lib/company-name";

/**
 * What a company's mark is made of, apart from how it is drawn: the logo's domain when Orbit
 * KNOWS one, the brand color for its tile, and the letter that stands in for a logo.
 *
 * The domain comes only from the curated brand table or what Orbit learned for that exact name
 * (`lookupBrand`) — never guessed from a name, and never read off the person's email. The
 * privacy page says logo lookups send "an organization's name or website domain only", with a
 * domain from a contact's or meeting guest's address; taking one from a recruiting email's
 * sender would be a wider flow than it says. A company Orbit does not know is a tinted initial.
 *
 * Pure, so the page, the components and the smoke share it and a client bundle may import it.
 */
export type CompanyMarkSpec = {
  /** A bare host for `BrandLogo`, or null when Orbit does not know this company's website. */
  domain: string | null;
  /** The brand color as CSS, for the tile and accents. Null for a monochrome brand. */
  color: string | null;
  /** The first letter or digit of the name, uppercased: what shows when there is no logo. */
  initial: string;
};

export function companyMarkSpec(name: string | null | undefined): CompanyMarkSpec {
  const clean = (name ?? "").trim().replace(/^the\s+/i, "");
  const first = clean.match(/[\p{L}\p{N}]/u)?.[0] ?? "?";
  return {
    domain: lookupBrand(normalizeCompanyName(clean), "company")?.domain ?? null,
    color: companyBrandColor(clean),
    initial: first.toUpperCase(),
  };
}
