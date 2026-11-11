# Orbit Card design — a card people want to show off

## Context

Orbit Card PR 1 (#627) works but looks plain: the public `/c/<slug>` page is a dark page with a
name, an email pill and a yellow button; show mode is a QR on white. Jason wants the card to feel
special — something you're proud to hand over. He chose (Nov 11, from interactive mockups):

- **The look:** the *star chart* front — deep navy, a constellation generated from your seed, the
  name in gold foil (Fraunces) — under a **single silver holographic glass** layer: a frosted pane
  with ONE cool silver sheen (no rainbow) that slides across as the card tilts. **Top-right: a
  planet generated just for you** (colour, bands, ring, moon). The back is your QR inside a gold
  orbit ring.
- **Unique per person**, with **"Shuffle my stars"** (new constellation + planet) and a choice of
  **5 accent colours** in /card.
- **Moments first:** the scan page, show mode, and the link preview (iMessage/LinkedIn/Slack).
  Printed/NFC artwork comes later.
- **Scan page:** card is the hero with a short entrance (stars draw in), tilts with the phone,
  then Save contact / Share back below it.

Builds on Card PR 1 (#627): a new branch off `claude/orbit-contact-sharing-qr-nfc-5c5133`.
(Also here PR 1 + its review fixes live on separate branches; only `card-store.ts` overlaps.)

## Design (what gets built)

**One art generator, everywhere.** `src/lib/cards/card-art.ts` — pure, no DOM, no user text:
- `cardArt(seed: string, accent: AccentKey | null): CardArt` → seeded PRNG (the FNV + xorshift
  from the mockup) gives 6–9 constellation stars (nearest-neighbour path), dust stars, and planet
  params (base = accent, 2–4 bands, ring ~55% / moon ~45%, tilt, terminator shadow).
- `cardArtSvg(art, { width, height, part: "front" | "back" }): string` — the whole background as
  an SVG string (stars, lines, planet, glass pane, gold ring on the back). **Contains no user
  text** — name/role render as real text on top — so it's safe to inline and to embed in the OG
  image as a data URI.
- Seed = `share_cards.id + ":" + art_salt` (stable across name edits; Shuffle bumps the salt).
- `ACCENTS`: teal `#5ec8c0`, gold `#d4b469`, sky `#7cc3e2`, rose `#e59ab0`, violet `#b7a6f2`
  (each with a dark ink for the QR); default picked from the seed. The accent tints the planet and
  constellation lines only — the glass sheen is always silver.

**One card component.** `src/components/card/orbit-card.tsx` (client):
- Credit-card ratio (1.586:1). Front: inlined art SVG + name (Fraunces, gold-foil gradient text),
  role @ company (Outfit), small "ORBIT" wordmark. Back: art back + the existing server-made QR SVG
  in the ring + "Scan to save {first}'s contact".
- **Silver glass:** a frosted pane (white 5–7% + hairline white border) plus one overlay band —
  `linear-gradient(<angle>, transparent, rgba(232,238,245,.0) → rgba(232,238,245,.38) → transparent)`
  with `mix-blend-mode: screen` — whose angle/position follow the tilt. One colour, no rainbow.
- Tilt: pointer on desktop; on phones `DeviceOrientationEvent` (iOS asks permission on first tap;
  fall back to drag-to-tilt if denied). Flip on tap where offered.
- Entrance: constellation lines draw in, stars pop (≈1.2 s, `--ease-house`). All motion goes
  through the repo's single reduced-motion mechanism (static card, no tilt, no draw-in).
- No new dependencies (CSS 3D transforms + SVG).

**Where it appears:**
1. **Scan page** `src/app/(site)/c/[slug]/page.tsx` + `src/components/card/public-card.tsx`: the
   card as full-width hero (front only), entrance + tilt, then gold **Save contact**, **Share your
   details with {first}**, the existing form. Page background becomes the same deep navy with faint
   dust. Clerk-free; regenerate `site-sources.css`.
2. **Show mode** `src/app/(clerk)/(app)/(main)/card/show/page.tsx`: the card at full width,
   **back facing up** (QR as large as today's), tap to flip to the front; wake lock and arrivals
   ticker stay.
3. **Link preview**: `/c/[slug]` `generateMetadata` adds `openGraph.images` → a 1200×630 image of
   the front rendered with `next/og` (copy `src/app/api/interest-list/ticket-image/route.tsx`:
   vendored fonts, CDN cache, generic Orbit image on unknown/paused), art embedded as an SVG data
   URI, hidden fields respected. No `maxDuration` export.
4. **/card editor**: the live preview becomes the real `OrbitCard`, plus **Shuffle my stars**
   (bumps `art_salt`) and 5 accent swatches with "Auto".

**Data:** `share_cards.art_salt integer not null default 0`, `share_cards.accent text` (null = from
seed). `CardDraft`/`PublicCard` gain `artSalt`, `accent` (validated against `ACCENTS`). Schema bump
above every branch at commit time (main 222; claimed through 227 → **228**).

## Files

- New: `src/lib/cards/card-art.ts`, `src/components/card/orbit-card.tsx`, the OG image route,
  `scripts/smoke-card-art.ts`.
- Modify: `src/db/schema.ts`, `src/db/index.ts` (alters + `ensureColumn` + version),
  `src/lib/cards/card-store.ts`, `src/actions/cards.ts` (shuffle/accent),
  `src/components/card/public-card.tsx`, `card-editor.tsx`, `card-share-panel.tsx`,
  `card/show/page.tsx`, `c/[slug]/page.tsx`, `src/app/site-sources.css`.

## Verification

- `scripts/smoke-card-art.ts` (pure, registered in `run-smoke.ts`): same seed → identical SVG;
  different salt → different stars and planet; 50 random seeds → stars inside the safe area, no
  NaN, 6–9 stars; the SVG contains no `<text>` and none of the owner's name; an accent outside
  `ACCENTS` is rejected by `saveCard`.
- Existing: `smoke-share-card`, `smoke-schema-ddl`, `smoke-public-routes`, `smoke-clerk-free-site`,
  `smoke-site-css-sources`, `smoke-a11y-patterns`; `tsc`, `npm run lint`.
- Browser (demo mode, Playwright + system Chrome): scan page at 375 px and desktop (entrance plays,
  silver sheen follows the pointer, reduced motion = static); show-mode QR still decodes from a
  screenshot; the OG route returns a 1200×630 PNG and `og:image` points at it; Shuffle and accent
  persist on reload. Screenshots of all three moments.
- Owed to Jason: iPhone tilt + permission prompt, and a pasted link in iMessage/LinkedIn.
