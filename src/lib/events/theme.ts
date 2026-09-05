/**
 * Giving each event its own colour, derived from its own page.
 *
 * ## The ladder
 *
 * Best available signal wins, strongest first — the same "prefer by trust" shape the browser
 * extension's `preferField` uses for identity fields:
 *
 *   1. `meta`   — `<meta name="theme-color">` on the event page. The host literally declared
 *                 their colour; nothing we derive beats being told.
 *   2. `jsonld` — a brand/primary colour in the page's structured data.
 *   3. `image`  — the dominant colour of the cover art, sampled CLIENT-side (see
 *                 `cover-palette-probe.tsx`) and posted back. Deliberately not done on the
 *                 server: there is no image-decoding library in `dependencies` — `sharp` is
 *                 listed in `serverExternalPackages` but is NOT a dependency — and adding one
 *                 to read one average colour is not a trade worth making.
 *   4. `hash`   — a deterministic hue from the event's host and title.
 *
 * Rung 4 is why `resolveThemeColor` never returns null: an event has a stable identity from
 * the moment it is created, and rungs 1–3 only ever improve it. A grey card that turns purple
 * ten seconds later looks broken; a purple card that becomes a slightly different purple does
 * not.
 *
 * ## The contrast guarantee
 *
 * The stored colour is raw — whatever the host declared or the cover happened to be — and is
 * NEVER rendered directly. `eventThemeVars` clamps it per theme via `clampForContrast`, so
 * `--event-accent` always clears 4.5:1 against both `--card` and `--background`. That is a
 * guarantee rather than a hope: hosts pick colours for their own background, not ours, and
 * a pale-yellow brand on a white card is unreadable through no fault of theirs.
 *
 * ## Why both themes are computed here
 *
 * An inline `style` attribute cannot be theme-conditional, and the theme can change after
 * render without a round trip. So both values ship at once and CSS picks between them —
 * see the `.event-theme` blocks in `globals.css`. Pure CSS, SSR-safe, and no flash of the
 * wrong colour, the same constraint `.reveal-mount` documents for itself.
 *
 * Pure: no DOM, no DB, no `next/*`. Safe to import from a client component.
 */
import { clampForContrast, hexToHsl, hslToHex, type Hsl } from "@/lib/contrast";
import { hashHue } from "@/lib/hash";

export type EventThemeSource = "meta" | "jsonld" | "image" | "hash";

export type EventThemeInput = {
  /** `<meta name="theme-color">` from the event page. */
  metaColor?: string | null;
  /** A brand colour found in structured data. */
  jsonLdColor?: string | null;
  /** Dominant cover colour, sampled in the browser. */
  imageColor?: string | null;
  /** Seed for the deterministic rung — the event's host, else its title. */
  seed: string;
};

export type ResolvedEventTheme = { color: string; source: EventThemeSource };

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function normalizeHex(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!HEX.test(value)) return null;
  let h = value.replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  return `#${h.toLowerCase()}`;
}

/**
 * Reject a colour that carries no hue signal.
 *
 * A near-white or near-black `theme-color` is extremely common (plenty of sites declare
 * `#ffffff`) and tells us nothing about the event's identity — worse, after clamping it
 * becomes indistinguishable grey. Falling through to the hash rung produces something
 * actually characteristic, so an unusable declared colour is treated as no declared colour.
 */
function hasUsableHue(hex: string): boolean {
  const { s, l } = hexToHsl(hex);
  return s >= 0.15 && l >= 0.08 && l <= 0.92;
}

/** Walk the ladder. Never returns null — rung 4 always produces something. */
export function resolveThemeColor(input: EventThemeInput): ResolvedEventTheme {
  const rungs: Array<[EventThemeSource, string | null | undefined]> = [
    ["meta", input.metaColor],
    ["jsonld", input.jsonLdColor],
    ["image", input.imageColor],
  ];
  for (const [source, raw] of rungs) {
    const hex = normalizeHex(raw);
    if (hex && hasUsableHue(hex)) return { color: hex, source };
  }
  // Matches `companyBrandColor`'s fallback in `src/lib/company-brand.ts` — same saturation
  // and lightness, so an event and a company tinted from the same string look related.
  const hue = hashHue(input.seed || "event");
  return { color: hslToHex({ h: hue, s: 0.58, l: 0.42 }), source: "hash" };
}

export type EventThemeVars = {
  "--event-accent-light": string;
  "--event-accent-dark": string;
  "--event-tint-light": string;
  "--event-tint-dark": string;
  "--event-ring-light": string;
  "--event-ring-dark": string;
};

/**
 * Mix a hue toward its ground to make a wash.
 *
 * Deliberately a mix rather than the accent at low alpha. The `.yc-theme` block in
 * `globals.css` records why: a translucent saturated hue "reads burnt rather than light",
 * because it multiplies against whatever is behind it instead of sitting on it.
 */
function tint(hsl: Hsl, theme: "light" | "dark"): string {
  return theme === "light"
    ? hslToHex({ h: hsl.h, s: Math.min(hsl.s, 0.5), l: 0.955 })
    : hslToHex({ h: hsl.h, s: Math.min(hsl.s, 0.4), l: 0.16 });
}

/**
 * Turn a stored colour into the variables the detail page sets inline.
 *
 * Every returned value is post-clamp, so a caller cannot render an illegible accent even by
 * accident — there is no unclamped path out of this module.
 */
export function eventThemeVars(storedColor: string): EventThemeVars {
  const base = normalizeHex(storedColor) ?? "#6b7280";
  const light = clampForContrast(base, "light");
  const dark = clampForContrast(base, "dark");
  return {
    "--event-accent-light": light,
    "--event-accent-dark": dark,
    "--event-tint-light": tint(hexToHsl(base), "light"),
    "--event-tint-dark": tint(hexToHsl(base), "dark"),
    // The focus ring only has to be visible, not text-legible, so it keeps the raw hue at a
    // fixed lightness rather than being clamped to a text ratio.
    "--event-ring-light": hslToHex({ ...hexToHsl(base), l: 0.55 }),
    "--event-ring-dark": hslToHex({ ...hexToHsl(base), l: 0.62 }),
  };
}

/** A cover-less hero still needs something to look at. Built from the clamped accent. */
export function eventGradient(storedColor: string): string {
  const { h, s } = hexToHsl(normalizeHex(storedColor) ?? "#6b7280");
  const a = hslToHex({ h, s: Math.min(s, 0.62), l: 0.42 });
  const b = hslToHex({ h: h + 38, s: Math.min(s, 0.55), l: 0.28 });
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}
