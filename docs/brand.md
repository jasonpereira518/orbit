# Orbit brand

Decisions settled on 2026-11-09. Change this page in the same PR that changes a decision.

## What stays

- **Palette:** teal and gold on warm off-white. Dark mode is blue graphite.
- **Type:** Fraunces for display (`font-heading`), Outfit for everything else.
- **Motif:** space.
- **Always-dark navy:** landing, waitlist, pricing and the constellation. They do not follow the theme toggle.

## Marks

- **Logo:** the current logo (`public/orbit-logo.png`, drawn by `src/components/orbit-logo.tsx`) stays exactly as it is. It is the only logo, used everywhere a logo sits, including onboarding and sign-in.
- **Loading:** the planet with its moon is Orbit's one loading animation.
- **Descriptor:** "Personal Networking Intelligence", everywhere.

## First impressions

Sign-in and sign-up join the night sky. The switch to the light app happens once, as onboarding begins.

## Rules for signed-in pages

- Gold is ambient only (glows, icons, dots). It is never a control.
- No per-page accent hues. Colour comes from tokens (`primary`, `success`, `warning`, `destructive`, `tier-*`, `muted-foreground`), not from stock Tailwind hues or hex values.
- Two page widths: full, or `mx-auto max-w-3xl space-y-6`.
- The dashboard alone gets the large title.

## The drift guard

`scripts/smoke-page-shell.ts` counts three things per file under `src/app/(clerk)/(app)` and `src/components`: stock Tailwind palette classes, hex colour classes, and the long arbitrary-value spelling of the display font. The counts on record are in `scripts/smoke-page-shell.baseline.json`. The guard fails when a file's count goes above its baseline, or when a file with no baseline has any. It runs as part of `npm test`.

The marketing folders (`landing`, `interest`, `marketing`, `pricing`) and `*brand-colors.ts` files are not counted.

Run it alone:

```bash
npx tsx scripts/smoke-page-shell.ts
```

After removing classes, or when a new one is deliberate, rewrite the baseline and commit it:

```bash
npx tsx scripts/smoke-page-shell.ts --update
```

If two branches both change the baseline and it conflicts, take either side and run `--update` again.
