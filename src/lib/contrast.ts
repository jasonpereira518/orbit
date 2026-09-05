/**
 * WCAG contrast maths, shared.
 *
 * These formulas already existed in `scripts/check-interaction-contrast.mjs`, which gates the
 * four interaction-family tokens. The event theming ladder needs the same maths at runtime to
 * clamp a colour it did not choose, and two copies of a contrast formula is how one of them
 * quietly starts disagreeing with the other about what is legible.
 *
 * Pure and dependency-free, so both a `pure`-tier smoke test and a client component can use it.
 */

/** The four grounds an event accent is ever drawn on — `--card` and `--background`, per theme. */
export const SURFACES = {
  light: ["#ffffff", "#fbfbf9"],
  dark: ["#1a2438", "#212c42"],
} as const;

/** WCAG AA for normal text. The same floor `check-interaction-contrast.mjs` enforces. */
export const MIN_CONTRAST = 4.5;

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Perceptual lightness. Used to move a colour without disturbing its hue. */
export function lstar(hex: string): number {
  const y = relativeLuminance(hex);
  return y <= 216 / 24389 ? y * (24389 / 27) : Math.cbrt(y) * 116 - 16;
}

/** The worst ratio against every surface in a theme — the number that has to clear the floor. */
export function worstContrast(hex: string, theme: keyof typeof SURFACES): number {
  return Math.min(...SURFACES[theme].map((bg) => contrastRatio(hex, bg)));
}

// --- HSL, for moving lightness while holding hue -------------------------------------------

export type Hsl = { h: number; s: number; l: number };

export function hexToHsl(hex: string): Hsl {
  const [r255, g255, b255] = hexToRgb(hex);
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const hue = ((h % 360) + 360) % 360 / 360;
  if (s === 0) {
    const v = l * 255;
    return rgbToHex(v, v, v);
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const toChannel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return rgbToHex(
    toChannel(hue + 1 / 3) * 255,
    toChannel(hue) * 255,
    toChannel(hue - 1 / 3) * 255
  );
}

/**
 * Move a colour's lightness until it clears `MIN_CONTRAST` against every surface in `theme`,
 * holding hue and saturation so the event still reads as its own colour.
 *
 * Direction is decided by the theme rather than searched for: on a light ground the only way
 * out is darker, on a dark ground lighter. Stepping the wrong way would walk a mid-tone colour
 * all the way through the background before it ever came out the other side.
 *
 * Falls back to black/white, which trivially clear the floor — a guarantee, not a best effort,
 * because the caller renders whatever comes back without re-checking.
 */
export function clampForContrast(hex: string, theme: keyof typeof SURFACES): string {
  if (worstContrast(hex, theme) >= MIN_CONTRAST) return hex;
  const hsl = hexToHsl(hex);
  const step = theme === "light" ? -0.02 : 0.02;
  for (let i = 1; i <= 50; i++) {
    const l = hsl.l + step * i;
    if (l <= 0 || l >= 1) break;
    const candidate = hslToHex({ ...hsl, l });
    if (worstContrast(candidate, theme) >= MIN_CONTRAST) return candidate;
  }
  return theme === "light" ? "#000000" : "#ffffff";
}
