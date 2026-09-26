"use client";

import { registerLearnedBrands, type LearnedBrand } from "@/lib/brand-colors";

/**
 * Hands the viewer's learned organization colors (`src/lib/org-brand-learn.ts`) to
 * `lookupBrand`, so every surface that colors a company or school — cards, search, the
 * constellation — picks them up with no plumbing of its own.
 *
 * Registers during render, not in an effect, and renders nothing. That is deliberate: it is
 * mounted above the app's content, so it renders before anything that asks for a color, on
 * the server's SSR pass and on the client alike. An effect would run after the children had
 * already painted the hashed tint — and on the client, after hydration had compared markup
 * rendered with the learned color on the server. Registering is idempotent and touches only
 * public, non-viewer data (see `registerLearnedBrands`), so repeating it is harmless.
 */
export function LearnedBrandColors({ brands }: { brands: LearnedBrand[] }) {
  registerLearnedBrands(brands);
  return null;
}
