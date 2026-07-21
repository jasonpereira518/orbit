/**
 * Orbit branding layered on Clerk's `shadcn` theme.
 *
 * Do not hardcode light-mode colors here — the shadcn theme maps Clerk
 * variables to Orbit CSS tokens (`--card`, `--primary`, etc.) which already
 * flip with the `.dark` class from next-themes.
 */
export const clerkAppearance = {
  variables: {
    borderRadius: "0.625rem",
    fontFamily:
      'var(--font-sans), "Outfit", ui-sans-serif, system-ui, sans-serif',
    fontFamilyButtons:
      'var(--font-sans), "Outfit", ui-sans-serif, system-ui, sans-serif',
  },
  elements: {
    card: "shadow-none border border-border",
    headerTitle: "font-[family-name:var(--font-display)] text-primary",
    headerSubtitle: "text-muted-foreground",
    formButtonPrimary:
      "bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium",
    footerActionLink: "text-primary hover:text-primary/80",
  },
};
