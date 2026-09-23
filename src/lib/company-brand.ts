import {
  brandLuma,
  FALLBACK_LIGHTNESS,
  FALLBACK_SATURATION,
  lookupBrand,
} from "@/lib/brand-colors";
import { normalizeCompanyName } from "@/lib/company-name";
import { hashHue } from "@/lib/hash";
import { mixWithWhite } from "@/lib/school-color";

/** Mid grey that reads as text on both the light and the dark app surfaces. */
const MONOCHROME_BRAND = "#9CA3AF";

/**
 * The app-UI treatment: the brand color is drawn as *text* on light and dark cards, so a
 * monochrome brand (Vercel, Notion, X — black or white) becomes a neutral grey, and a very
 * dark one (Morgan Stanley navy, Slack aubergine) is lifted enough to stay legible on the
 * dark theme. Raw hexes come from `brand-colors.ts`; this is the cards' own adaptation.
 */
export function uiFriendlyBrand(hex: string): string {
  const luma = brandLuma(hex);
  if (luma < 0.12 || luma > 0.92) return MONOCHROME_BRAND;
  if (luma < 0.22) return mixWithWhite(hex, 0.3);
  return hex;
}

/**
 * Resolve a readable brand color for a company name.
 * Known brands (companies and schools) use their brand hex; others get a stable tint from the name.
 */
export function companyBrandColor(
  company: string | null | undefined
): string | null {
  if (!company?.trim()) return null;

  const normalized = normalizeCompanyName(company);
  const brand = lookupBrand(normalized, "company");
  if (brand) return uiFriendlyBrand(brand.hex);

  // Deterministic fallback so unknown companies still get a distinct tint
  const hue = hashHue(normalized);
  const sat = Math.round(FALLBACK_SATURATION * 100);
  const light = Math.round(FALLBACK_LIGHTNESS * 100);
  return `hsl(${hue} ${sat}% ${light}%)`;
}
