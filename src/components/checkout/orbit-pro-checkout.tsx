"use client";

import { PricingTable } from "@clerk/nextjs";

/**
 * Clerk's checkout, themed into the landing's dark space world.
 *
 * `@clerk/nextjs` 7.5.20 exports `PricingTable` and nothing else for billing — no
 * `CheckoutButton`, no `useCheckout`, no payment-element primitives — so a hand-built card
 * form is not possible. The work is hosting Clerk's component and making it belong here.
 *
 * Theming works by redefining the CSS custom properties Clerk's `shadcn` theme already
 * reads (`--card`, `--foreground`, `--primary`, `--muted`, `--input`, `--ring`, …) rather
 * than overriding Clerk's internal classes. The theme is wired globally in
 * `auth-provider.tsx`; here it simply resolves against a different palette.
 *
 * This is necessary because `.dark` is never applied on these pages — the space world is a
 * fixed palette, not a theme mode — so without the override the table renders its
 * light-mode surface against a near-black page.
 */

/** Space-world equivalents of the app tokens the shadcn theme resolves. */
const SPACE_TOKENS = {
  "--card": "#070b18",
  "--card-foreground": "#e8f3f1",
  "--foreground": "#e8f3f1",
  "--muted": "#0b1120",
  "--muted-foreground": "#9aada8",
  "--primary": "#f2c14e",
  "--primary-foreground": "#241a00",
  "--input": "#1b2434",
  "--ring": "#f2c14e",
  "--border": "#1b2434",
  "--background": "#05070f",
} as React.CSSProperties;

/**
 * The drawer is portalled out of this subtree, so scoped CSS variables cannot reach it.
 * Literal values are passed instead — they resolve wherever Clerk mounts the drawer.
 */
const CHECKOUT_APPEARANCE = {
  variables: {
    colorBackground: "#070b18",
    colorForeground: "#e8f3f1",
    colorMutedForeground: "#9aada8",
    colorPrimary: "#f2c14e",
    colorPrimaryForeground: "#241a00",
    colorInput: "#0b1120",
    colorInputForeground: "#e8f3f1",
    colorBorder: "#1b2434",
    colorRing: "#f2c14e",
  },
};

export function OrbitProCheckout({
  highlightedPlan,
}: {
  /** Clerk plan slug, so the tier carries its "Popular" badge. */
  highlightedPlan: string;
}) {
  return (
    <div style={SPACE_TOKENS}>
      <PricingTable
        for="user"
        highlightedPlan={highlightedPlan}
        // Features are sold on /pricing; this page is the confirm-and-pay step, so the
        // table stays lean rather than restating the list a second time.
        collapseFeatures
        ctaPosition="bottom"
        // Matches the Stripe success_url, so both purchase paths land in the same place —
        // where the plan card already states the new plan back to the buyer.
        newSubscriptionRedirectUrl="/settings#settings-plan"
        appearance={{ variables: CHECKOUT_APPEARANCE.variables }}
        checkoutProps={{ appearance: CHECKOUT_APPEARANCE }}
      />
    </div>
  );
}
