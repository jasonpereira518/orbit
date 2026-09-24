import { brandLuma, lookupBrand, type Brand, type BrandKind } from "@/lib/brand-colors";
import { hashHue } from "@/lib/hash";

const NEUTRAL_STAR = "#c8d0dc";
const NEUTRAL_ORG = "#8a9bb0";

export function normalizeOrgKey(name: string | null | undefined): string {
  return (name || "")
    .trim()
    .toLowerCase()
    .replace(/[.,']/g, "")
    // "UNC-Chapel Hill" and "UNC Chapel Hill" are one school.
    .replace(/\s*[-–—]\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = light - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hashToBrandHex(input: string): string {
  const hue = hashHue(input);
  const sat = 48 + (hashHue(input + "s") % 30);
  const light = 42 + (hashHue(input + "l") % 16);
  return hslToHex(hue, sat, light);
}

/** The dimmest a brand may be drawn on the night sky. */
const MIN_SKY_LUMA = 0.4;

/**
 * The dark-sky treatment: make a brand visible on the dark map without changing what colour
 * it is. Raw hexes come from `brand-colors.ts`; this is the constellation's own adaptation.
 *
 * A dark brand is lifted toward white until it clears `MIN_SKY_LUMA`, so Duke stays Duke blue and
 * Stanford stays cardinal — they used to either stay navy (invisible on black) or, past a cutoff,
 * all become the same slate grey. Only a brand with no hue at all (a black logo) ends up grey,
 * which is what it is. Near-white is softened a touch so it does not glare.
 */
export function mapFriendlyBrand(hex: string): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return hex;
  const l = brandLuma(hex);
  if (l > 0.92) return "#E8EEF7";
  if (l >= MIN_SKY_LUMA) return hex;
  for (let t = 0.05; t < 1; t += 0.05) {
    const lifted = mixWithWhite(hex, t);
    if (brandLuma(lifted) >= MIN_SKY_LUMA) return lifted;
  }
  return mixWithWhite(hex, 0.5);
}

/**
 * Brands whose true hex reads as a different colour on the night sky. Stripe's "blurple"
 * (#635BFF, hue ~243°) sits on the blue/violet line; on black, and mixed toward white for the
 * stars, it read plainly blue. Nudged to the violet people see. Sky-only: cards keep the raw hex.
 */
const SKY_HUE_OVERRIDES: Record<string, string> = {
  Stripe: "#9061F9",
};

/** A known brand as the constellation draws it. */
export function skyBrandColor(brand: Brand): string {
  return mapFriendlyBrand(SKY_HUE_OVERRIDES[brand.name] ?? brand.hex);
}

/**
 * Resolved colours by kind and name. The constellation asks once per star, so a 10,000-person
 * sky asked ten thousand times about a few hundred organisations, each a normalise, a brand
 * lookup and a colour mix. The answer is a pure function of the two, and the set of names is
 * bounded by the network; the cap only guards a long session that sees many networks.
 */
const brandCache = new Map<string, string>();
const BRAND_CACHE_MAX = 20_000;

function resolveBrand(
  name: string | null | undefined,
  kind: BrandKind | undefined,
  fallbackNeutral: string
): string {
  const cacheKey = `${kind ?? ""}\u0000${fallbackNeutral}\u0000${name ?? ""}`;
  const cached = brandCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const key = normalizeOrgKey(name);
  let color: string;
  if (!key) color = fallbackNeutral;
  else {
    const hit = lookupBrand(name, kind);
    color = hit ? skyBrandColor(hit) : hashToBrandHex(key);
  }
  if (brandCache.size >= BRAND_CACHE_MAX) brandCache.clear();
  brandCache.set(cacheKey, color);
  return color;
}

/** Primary color for a contact's school star tint. */
export function schoolStarColor(school: string | null | undefined): string {
  return resolveBrand(school, "school", NEUTRAL_STAR);
}

/** Primary brand color for a company. */
export function companyBrandColor(company: string | null | undefined): string {
  return resolveBrand(company, "company", NEUTRAL_ORG);
}

export function clusterBrandColor(
  name: string,
  kind?: "company" | "school" | "other" | string
): string {
  if (kind === "school") return schoolStarColor(name);
  if (kind === "company") return companyBrandColor(name);
  // Infer from the name: a known school tints as a school, anything else as a company.
  return lookupBrand(name)?.kind === "school"
    ? schoolStarColor(name)
    : companyBrandColor(name);
}

/** Lerp a hex color toward white (0 = unchanged, 1 = pure white). */
export function mixWithWhite(hex: string, whiteRatio: number): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return hex;
  const t = Math.min(1, Math.max(0, whiteRatio));
  const channel = (i: number) => {
    const v = parseInt(raw.slice(i, i + 2), 16);
    return Math.round(v + (255 - v) * t)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return hex;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
