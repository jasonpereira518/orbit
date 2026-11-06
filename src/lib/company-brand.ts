import type { CSSProperties } from "react";
import {
  brandLuma,
  FALLBACK_LIGHTNESS,
  FALLBACK_SATURATION,
  lookupBrand,
} from "@/lib/brand-colors";
import { normalizeCompanyName } from "@/lib/company-name";
import { clampForContrast, hslToHex } from "@/lib/contrast";
import { hashHue } from "@/lib/hash";
import { mixWithWhite } from "@/lib/school-color";

/**
 * The marker `uiFriendlyBrand` returns for a monochrome brand (Vercel, Notion, X — black or
 * white). A grey this light measured 2.5:1 as text on a white card, so `companyBrandColor`
 * does not hand it out: those names render in the surrounding (muted) text colour instead.
 */
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

/** The brand as both a CSS colour (what callers render) and a hex (what contrast maths reads). */
function resolveBrand(
  company: string | null | undefined
): { css: string; hex: string } | null {
  if (!company?.trim()) return null;

  const normalized = normalizeCompanyName(company);
  const brand = lookupBrand(normalized, "company");
  if (brand) {
    const ui = uiFriendlyBrand(brand.hex);
    return ui === MONOCHROME_BRAND ? null : { css: ui, hex: ui };
  }

  // Deterministic fallback so unknown companies still get a distinct tint
  const hue = hashHue(normalized);
  const sat = Math.round(FALLBACK_SATURATION * 100);
  const light = Math.round(FALLBACK_LIGHTNESS * 100);
  return {
    css: `hsl(${hue} ${sat}% ${light}%)`,
    hex: hslToHex({ h: hue, s: sat / 100, l: light / 100 }),
  };
}

/**
 * Resolve a brand color for a company name.
 * Known brands (companies and schools) use their brand hex; others get a stable tint from the name.
 * Null for no company, and for a monochrome brand (render it as ordinary muted text).
 *
 * This is the brand itself, NOT a text colour: as text, Figma's orange measured 3.56:1 on a
 * white card and Stripe's blurple 3.31:1 on the dark one. Text goes through
 * `companyBrandText`, which clamps it per theme.
 */
export function companyBrandColor(
  company: string | null | undefined
): string | null {
  return resolveBrand(company)?.css ?? null;
}

/**
 * The class half of `companyBrandText`. Literal here so Tailwind's scanner sees it: the light
 * theme's value, or the dark one under `.dark` (the same switch the theme tokens use).
 */
const BRAND_TEXT_CLASS = "text-(--brand-text) dark:text-(--brand-text-dark)";

const brandTextCache = new Map<string, { className: string; style: CSSProperties } | null>();

/**
 * A company name's brand tint as TEXT that clears WCAG AA (4.5:1) on every card surface of
 * both themes (`SURFACES` in `contrast.ts`).
 *
 * The brand's hex is moved along its own lightness only as far as each theme needs (darker on
 * light cards, lighter on dark ones), so it still reads as the brand. Both values ride in CSS
 * variables and the class picks one by theme, so one server render is right in either theme.
 *
 * Null when there is no company or the brand is monochrome: render the name in the
 * surrounding text colour. Spread as `className={cn(..., brand?.className)} style={brand?.style}`.
 */
export function companyBrandText(
  company: string | null | undefined
): { className: string; style: CSSProperties } | null {
  const resolved = resolveBrand(company);
  if (!resolved) return null;
  const cached = brandTextCache.get(resolved.hex);
  if (cached !== undefined) return cached;
  const value = {
    className: BRAND_TEXT_CLASS,
    style: {
      "--brand-text": clampForContrast(resolved.hex, "light"),
      "--brand-text-dark": clampForContrast(resolved.hex, "dark"),
    } as CSSProperties,
  };
  brandTextCache.set(resolved.hex, value);
  return value;
}
