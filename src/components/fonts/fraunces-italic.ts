import { Fraunces } from "next/font/google";

/**
 * Fraunces' true italic cut, on its own so only the pages that set it preload it.
 *
 * The root layout's Fraunces instance is upright-only. Declaring italic there too made every
 * route preload the italic file, though only three places use it: the landing tagline, the
 * /interest hero and the /pricing headline. Import this only there and put `className` on
 * the italic element — it sets this instance's family (same Google file, same variable `wght`
 * range, same Times New Roman fallback metrics) with `font-style: italic`, so the glyphs are
 * the ones the shared instance drew. Without a real italic the browser would slant the
 * upright, which on a display serif at 56px reads as a mistake.
 */
export const frauncesItalic = Fraunces({
  subsets: ["latin"],
  style: "italic",
});
