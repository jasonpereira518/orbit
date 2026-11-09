/**
 * Each account page's brand theme, in one place — plus Claude's and ChatGPT's, which the
 * Assistants page swaps between as the person picks one. `className` re-points `--primary` (buttons,
 * switches, checkboxes) and `--ring` at the provider's own UI colour, so a page recolours its
 * controls without any control knowing; logos keep their exact published colours separately.
 *
 * Light values carry white text at ≥4.5:1, dark values dark text (`smoke-provider-themes`
 * checks both). Tailwind only compiles class names it can see whole, so each stays a literal.
 */

export type ProviderThemeId = "google" | "microsoft" | "linkedin" | "granola" | "notion" | "claude" | "chatgpt";

export type ProviderTheme = {
  className: string;
  /** The controls' colour, light and dark — what the contrast check reads. */
  primary: { light: string; dark: string; lightText: string; darkText: string };
  /** The strip under the header. */
  stripe: readonly string[];
  stripeVariant: "bar" | "tiles" | "solid";
  /** Row icon tiles where a page has no per-feature colour. */
  tone: string;
};

export const PROVIDER_THEMES: Record<ProviderThemeId, ProviderTheme> = {
  // Google's own UI blues; the G keeps the four logo colours (`provider-marks.tsx`).
  google: {
    className:
      "[--primary:#1A73E8] [--primary-foreground:#ffffff] [--ring:#1A73E8] dark:[--primary:#8AB4F8] dark:[--primary-foreground:#04121b] dark:[--ring:#8AB4F8]",
    primary: { light: "#1A73E8", dark: "#8AB4F8", lightText: "#ffffff", darkText: "#04121b" },
    stripe: ["#4285F4", "#EA4335", "#FBBC05", "#34A853"],
    stripeVariant: "bar",
    tone: "#4285F4",
  },
  microsoft: {
    className:
      "[--primary:#0078D4] [--primary-foreground:#ffffff] [--ring:#0078D4] dark:[--primary:#479EF5] dark:[--primary-foreground:#04121b] dark:[--ring:#479EF5]",
    primary: { light: "#0078D4", dark: "#479EF5", lightText: "#ffffff", darkText: "#04121b" },
    stripe: ["#F25022", "#7FBA00", "#00A4EF", "#FFB900"],
    stripeVariant: "tiles",
    tone: "#00A4EF",
  },
  linkedin: {
    className:
      "[--primary:#0A66C2] [--primary-foreground:#ffffff] [--ring:#0A66C2] dark:[--primary:#70B5F9] dark:[--primary-foreground:#04121b] dark:[--ring:#70B5F9]",
    primary: { light: "#0A66C2", dark: "#70B5F9", lightText: "#ffffff", darkText: "#04121b" },
    stripe: ["#0A66C2"],
    stripeVariant: "solid",
    tone: "#0A66C2",
  },
  // Granola is lime on near-black. Lime under white text fails contrast, so light mode uses a
  // deep olive of the same hue and dark mode the real lime with dark text.
  granola: {
    className:
      "[--primary:#6B7A1A] [--primary-foreground:#ffffff] [--ring:#6B7A1A] dark:[--primary:#B4C44A] dark:[--primary-foreground:#181818] dark:[--ring:#B4C44A]",
    primary: { light: "#6B7A1A", dark: "#B4C44A", lightText: "#ffffff", darkText: "#181818" },
    stripe: ["#B4C44A"],
    stripeVariant: "solid",
    tone: "#6B7A1A",
  },
  // Notion's own ink: near-black controls, the page's warm off-black for icon tiles.
  notion: {
    className:
      "[--primary:#191919] [--primary-foreground:#ffffff] [--ring:#191919] dark:[--primary:#E6E6E5] dark:[--primary-foreground:#191919] dark:[--ring:#E6E6E5]",
    primary: { light: "#191919", dark: "#E6E6E5", lightText: "#ffffff", darkText: "#191919" },
    stripe: ["#37352F"],
    stripeVariant: "solid",
    tone: "#37352F",
  },
  // Claude's terracotta. The published #D97757 under white text is 3.1:1, so light mode
  // deepens it; dark mode keeps the real colour with dark text.
  claude: {
    className:
      "[--primary:#B85A38] [--primary-foreground:#ffffff] [--ring:#B85A38] dark:[--primary:#D97757] dark:[--primary-foreground:#1a0f0a] dark:[--ring:#D97757]",
    primary: { light: "#B85A38", dark: "#D97757", lightText: "#ffffff", darkText: "#1a0f0a" },
    stripe: ["#D97757"],
    stripeVariant: "solid",
    tone: "#B85A38",
  },
  // ChatGPT is black on white, white on black. The strip is `currentColor` so it follows the
  // text colour across themes rather than vanishing into the dark background.
  chatgpt: {
    className:
      "[--primary:#0D0D0D] [--primary-foreground:#ffffff] [--ring:#0D0D0D] dark:[--primary:#ECECEC] dark:[--primary-foreground:#0D0D0D] dark:[--ring:#ECECEC]",
    primary: { light: "#0D0D0D", dark: "#ECECEC", lightText: "#ffffff", darkText: "#0D0D0D" },
    stripe: ["currentColor"],
    stripeVariant: "solid",
    tone: "currentColor",
  },
};

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
