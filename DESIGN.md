---
name: Orbit (marketing landing)
description: Photoreal deep space in near-black navy and gold; Fraunces set directly on real imagery.
colors:
  space-ground: "#03050c"
  space-void: "#00010a"
  scene-navy: "#0b1128"
  star-gold: "#f2c14e"
  starlight: "#e8f3f1"
  pure-white: "#ffffff"
  deep-teal: "#0f3d3e"
  deep-teal-pressed: "#0b2e2f"
  dust-grey: "#9aada8"
  field-teal-1: "#06131a"
  field-teal-2: "#091c21"
  field-teal-3: "#0d2728"
typography:
  display:
    fontFamily: "Fraunces, ui-serif, Georgia, serif"
    fontSize: "clamp(2.25rem, 6vw, 5rem)"
    fontWeight: 300
    lineHeight: 1.03
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Fraunces, ui-serif, Georgia, serif"
    fontSize: "clamp(30px, 4.4vw, 52px)"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Fraunces, ui-serif, Georgia, serif"
    fontSize: "clamp(1.5rem, 2.4vw, 2rem)"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Outfit, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Outfit, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.43
rounded:
  xl: "0.875rem"
  2xl: "1rem"
  header: "22px"
  3xl: "1.5rem"
  full: "9999px"
spacing:
  gutter: "2rem"
  gutter-md: "2.5rem"
  measure: "28rem"
  column: "72rem"
  section: "6rem"
  section-md: "8rem"
components:
  button-primary:
    backgroundColor: "{colors.starlight}"
    textColor: "{colors.deep-teal}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "1rem 2rem"
  button-primary-hover:
    backgroundColor: "{colors.pure-white}"
    textColor: "{colors.deep-teal}"
  button-ghost:
    backgroundColor: "rgba(255, 255, 255, 0.05)"
    textColor: "{colors.starlight}"
    rounded: "{rounded.full}"
    padding: "1rem 2rem"
  button-ghost-hover:
    backgroundColor: "rgba(255, 255, 255, 0.1)"
    textColor: "{colors.starlight}"
  button-on-light:
    backgroundColor: "{colors.deep-teal}"
    textColor: "{colors.starlight}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0.75rem 1.5rem"
  button-on-light-hover:
    backgroundColor: "{colors.deep-teal-pressed}"
    textColor: "{colors.starlight}"
  glass-card:
    backgroundColor: "rgba(232, 243, 241, 0.045)"
    textColor: "{colors.starlight}"
    rounded: "{rounded.2xl}"
    padding: "1.25rem"
  chip-gold:
    backgroundColor: "rgba(242, 193, 78, 0.15)"
    textColor: "{colors.star-gold}"
    rounded: "{rounded.full}"
    padding: "0.25rem 0.75rem"
  ring-label:
    backgroundColor: "rgba(3, 5, 12, 0.75)"
    textColor: "{colors.star-gold}"
    rounded: "{rounded.full}"
    padding: "0.25rem 0.75rem"
  price-ticket:
    backgroundColor: "{colors.starlight}"
    textColor: "{colors.deep-teal}"
    rounded: "{rounded.3xl}"
    padding: "3rem"
  input-email:
    backgroundColor: "rgba(5, 7, 15, 0.5)"
    textColor: "{colors.starlight}"
    rounded: "{rounded.xl}"
    padding: "0.875rem 1.125rem"
  product-crop:
    rounded: "{rounded.xl}"
---

# Design System: Orbit (marketing landing)

This file records the visual system of Orbit's public marketing landing page (`/`), as built in `src/components/landing/`. It was written from the shipped code after the build. The signed-in app has its own light and dark themes, tokens and components; none of that is described or governed here, and a separate effort owns the app's brand and token refinement. Brand-wide facts below (typefaces, gold) are the ones the code's own tokens state.

## Overview

**Creative North Star: "A Real Planetary System"**

The visitor's network is shown as a real planetary system: they are the star, each person is a world, and distance from the star is time since they last talked. Everything on the page is the real thing or a measurement of it. The hero is one real-time 3D system with textured planets, a real star map and a real small-body model; below it are full-bleed photographs (Orion, the Carina Nebula) and footage of Earth at night. Headlines sit directly on that imagery, left-aligned, with nothing between the type and the sky but a scrim where legibility needs one.

The page is always dark. Its ground is not a flat colour but a fixed starfield on near-black navy, and every picture dissolves into it instead of ending at an edge. Colour is committed and narrow: near-black navy, one gold, one pale ink. "How it works" is the single deliberate change of ground, three flat teal fields butted together, each holding a real crop of the product.

Motion has one grammar per place. The hero is scrubbed by native scroll through three beats; each section below gets one quiet rise as it enters; the constellation lines draw with scroll. All copy ships in the document and reads with motion off, without WebGL, and without script.

**Key Characteristics:**
- Always dark, on a starfield ground of near-black navy
- Real imagery only: textured worlds, star map, JWST and Hubble photography, ISS footage, real product crops; every outside asset credited
- Fraunces headlines set directly on the image, left-aligned to one page-wide left edge
- Gold is a signal, not a fill
- Pictures dissolve into the ground; nothing photographic has a hard edge
- A card appears only where a card is the content
- Three delivery paths for the hero: live scene, poster, static stills

## Colors

A near-black navy night with a single gold and a single pale ink; teal appears only as deep ink and as the "How it works" fields.

### Primary
- **Star Gold** (`star-gold`): the star, the orbit lines, constellation lines (at 85% alpha), step numerals, ring names, the slider fill and its result label, the "Follow up today" chip (15% alpha fill), the focus outline, and the border of the fixed early-access pill. It is never a button fill at rest and never a large surface.

### Secondary
- **Deep Teal** (`deep-teal`): ink on light surfaces (primary button label, price ticket text), the on-light button fill, and the sample avatar disc. `deep-teal-pressed` is its hover on the ticket button.
- **Field Teal 1 to 3** (`field-teal-1`, `-2`, `-3`): the three "How it works" bands, each a shade further from navy toward teal, in order.

### Neutral
- **Space Ground** (`space-ground`): the page root, scrims (60 to 90% alpha), the ring-label chip (75% alpha), the pause-button fill (70% alpha), the dark edge under constellation labels.
- **Space Void** (`space-void`): the `body` colour behind the page, visible only on overscroll.
- **Scene Navy** (`scene-navy`): the WebGL scene's own sky colour inside the hero.
- **Starlight** (`starlight`): all text on dark, at full strength for headings and at 85 to 90% alpha for body; the primary button fill; the price ticket's paper.
- **Pure White** (`pure-white`): the hero and finale headlines only, and the primary button's hover.
- **Dust Grey** (`dust-grey`): tertiary text (ring notes, slider verdict, credits line, fine print, resting nav links and social icons).

### Named Rules
**The Gold Is A Signal Rule.** Gold marks the star, a line, a numeral, a label or a state. It is never a filled button at rest, never a background, never body text.

**The Light Action Rule.** The primary action is the one Starlight pill on a dark page. Gold does not compete with it. (The direction contract planned gold for the primary action; the build shipped it light, and the build is the record.)

**The Alpha Ink Rule.** Secondary text is Starlight at 85 to 90% alpha, not a separate grey. Dust Grey is reserved for the third tier.

## Typography

**Display Font:** Fraunces (with ui-serif, Georgia, serif), variable, loaded with `next/font` as `--font-display`
**Body Font:** Outfit (with ui-sans-serif, system-ui, sans-serif), variable, loaded with `next/font` as `--font-sans`

**Character:** A soft, high-contrast serif at light weight for everything that is a statement, over a plain geometric sans for everything that explains it. Only two faces and no uppercase, no tracking-out, no mono.

### Hierarchy
- **Display** (300, `clamp(2.25rem, 6vw, 5rem)`, 1.03, -0.03em): the hero headline. Two sibling uses at the same weight and tracking: the finale headline (`clamp(2.75rem, 8vw, 6rem)`, line-height 1) and the "Also in Orbit" poster lines (`clamp(2.5rem, 7vw, 5.25rem)`, 0.98).
- **Headline** (400, `clamp(30px, 4.4vw, 52px)`, 1.1, -0.025em, balanced wrap): every section heading. The price ticket's heading is the one larger variant (`clamp(2.25rem, 5vw, 3.75rem)`, 1.03, -0.03em).
- **Title** (400, `clamp(1.5rem, 2.4vw, 2rem)`, 1.25, -0.02em): step titles. Smaller Fraunces titles sit at 1.5rem and 1.125rem (the questions list) and 0.875rem (ring names).
- **Body** (400, 1rem rising to 1.125rem from 640px, 1.625): paragraphs, capped at 28rem (about 50 to 60 characters).
- **Label** (500 on buttons, 400 elsewhere, 0.875rem): buttons, chips, the slider's label and result, credits, fine print. 0.75rem is used only for the ring-label note.
- **Numeral** (Fraunces 400, 3rem to 3.75rem, line-height 1): step numbers in gold and the ticket's "$0".

### Named Rules
**The Two Voices Rule.** Fraunces states, Outfit explains. A Fraunces line is a headline, a name or a number; never a paragraph.

**The No Eyebrow Rule.** No small label sits above a headline. Where a section's list is its own headline, the heading is kept for the outline only (visually hidden).

## Layout

One column, one left edge. Every section puts its gutter on the outer box (2rem, 2.5rem from 768px) and a centred 72rem column inside it, so all type starts on the same line down the whole page. Copy blocks are left-aligned and capped at 28rem. Vertical rhythm between sections is 6rem, 8rem from 768px.

Sections are full-bleed plates, not boxed regions: the picture fills the width and the type sits on its quietest area (the constellation section takes its photograph's own 4039:3177 shape from 768px, with the copy on the left where there is no bright star). On phones the picture moves under the copy, cropped to its subject, and the product crops switch to captures of the app's phone layout so product text is never shrunk.

The hero is a sticky frame one viewport tall inside a 400svh pin. Its second beat has two arrangements, chosen by the `split` test (at least 1024px wide and at least 6:5): claim and slider on the left with the system on the right, or stacked with the claim above and the slider below. The scene makes the same test in script; the two must agree.

"How it works" bands use a 2fr/3fr grid from 1024px (text, then crop), stacked below it. A crop is never shown wider than its own pixel width.

Fixed furniture: a header that is flush and transparent over the hero and becomes a floating pill (inset 12px, max 72rem) after it; an early-access pill bottom-left; two social icons bottom-right. On phones a ground-colour fade sits behind the bottom corners so text never runs into them.

## Elevation & Depth

Depth comes from the imagery and from dissolving edges, not from shadows. Content sits on the starfield with no shadow at all. Photographs and video are masked to transparent at their edges so the starfield shows through; scrims are gradients of Space Ground placed only where type needs them and are masked together with the picture they cover.

### Shadow Vocabulary
- **Header pill** (`0 0 0 1px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0 rgba(0,0,0,0.4), 0 16px 48px -12px rgba(0,0,0,0.65), 0 4px 14px -4px rgba(0,0,0,0.45)`): the one lifted surface, because it floats over moving content.

### Named Rules
**The Dissolve Rule.** A photograph never ends at a hard edge or a rounded corner. It is masked to transparent (top and bottom 16%, or radially for a square still) so the ground shows through. Fade with a mask, never with a gradient to a fixed colour: the ground is a starfield, and a fade to one colour leaves a line.

**The Scrim Is Not Decoration Rule.** A dark gradient exists only under type that would otherwise sit on bright imagery, on the side the type is on.

## Shapes

Two shapes do nearly all the work: the full pill for anything pressable or label-like (buttons, chips, ring labels, the slider, the fixed pills) and the circle (orbits, the live-world marker, the avatar, the ticket's notches). Surfaces that are objects take generous corners: glass cards 1rem or 1.5rem, the ticket 1.5rem, product crops and form fields 0.875rem, the header pill 22px.

Borders are hairlines of Starlight or white at low alpha (8 to 20%) on dark, and a dashed Deep Teal line (35% alpha) for the ticket's tear. The ticket's notches are cut out with a mask so the starfield shows through them. Orbit and constellation lines are 1 to 1.4px gold strokes that do not scale with the picture.

## Components

### Buttons
Calm, round and few. One light pill per view carries the action.
- **Shape:** full pill (9999px).
- **Primary:** Starlight fill, Deep Teal label, Outfit 500. Large form 1rem 2rem at 1rem text (hero, finale); standard form 0.75rem 1.5rem at 0.875rem; header form 0.5rem 1rem with an invisible 4px extension above and below for a 44px touch target.
- **Hover / Focus:** fill goes to Pure White; colour-only transition at the interaction tier (120ms). No movement.
- **Ghost:** white 5% fill, white 20% hairline, Starlight label; hover 10% fill and 35% hairline. Always beside a primary, never alone.
- **On light:** Deep Teal fill with Starlight label, used on the price ticket; hover darkens.
- **Utility pill:** Space Ground at 70% with Starlight label, 44px tall (the video pause control).

### Chips
- **Status chip:** gold at 15% fill, gold text, 0.875rem, full pill. One use: the follow-up state in the sample card.
- **Ring label:** Space Ground at 75%, full pill; ring name in Fraunces gold, threshold note in Dust Grey 0.75rem (the note is dropped on narrow frames, where the sentence and the slider result already say it).

### Cards / Containers
- **Glass card:** Starlight at 4.5% to 1.5% vertical gradient, 8% Starlight hairline, 12px backdrop blur, 1rem or 1.5rem corners, 1.25rem to 2rem padding, no shadow. It gives 1% under a press on a spring (stiffness 600, damping 30) and does nothing else: no pointer cursor, no role, and presses that start on a control inside it are ignored. Used twice, where the card is the content: the sample contact and the mailing-list form.
- **Price ticket:** Starlight paper with Deep Teal ink, 1.5rem corners, a 7fr/3fr split with a dashed tear line and two 14px notches masked out at the seam (from 768px; below it the stub sits underneath).
- **Field band:** a full-width flat Field Teal band, no card, 3.5rem to 5rem vertical padding, holding a gold numeral, a title, one sentence and a product crop with 0.875rem corners.

### Inputs / Fields
- **Email field:** Space Ground-family fill at 50%, 14% Starlight hairline, 0.875rem corners, 0.875rem 1.125rem padding. Focus: gold border at 50% and a 3px gold ring at 70%.
- **Range slider:** native range input, 44px tall hit area, gold accent colour, gold 2px focus outline offset 2px. Its result line names the stop in gold and the verdict in Dust Grey.

### Navigation
- **Header:** transparent and full-width over the hero; after it, a floating pill (22px radius) of near-opaque dark glass with section links. Links are Outfit 0.875rem in Dust Grey, Starlight when active, with a 6% Starlight highlight behind the active one. Wordmark in Fraunces 1.25rem.
- **Links in text:** underlined, 4px offset, same colour as the text, 80% opacity on hover.

### Hero Scene (signature)
One WebGL scene, seen once, at one scale, from one moving point of view: the star cropped by the top-right edge with worlds on three gold orbits. Native scroll scrubs it through three beats (the star and its worlds, the system from overhead with the slider, the comet's return). DOM copy, ring labels and the slider are laid over it; the two blocks not in play are inert. A poster of the first frame paints before any script and stays if the scene never mounts. Reduced motion, no WebGL2, data saver or very low memory get no pin: three stills and the same three blocks of copy in normal flow, with the slider still working. Without script the pin unrolls and all three blocks show.

### Constellation Figure (signature)
Gold lines and Fraunces labels drawn over a real photograph of the constellations, positioned in the photograph's own pixel grid so they land on the stars. Lines draw with scroll and retrace on the way back; labels carry a ground-colour edge so a star behind a letter cannot erase it.

### Motion
- **Scrub:** hero and constellation lines follow scroll position directly; no easing, no autoplay.
- **Reveal:** one rise per block on entry (18px, 700ms, `cubic-bezier(0.22, 1, 0.36, 1)`), staggered 80 to 120ms, once only.
- **Interaction:** colour transitions at 120ms.
- **Reduced motion** (system setting or `html[data-motion="reduce"]`): no pin, no scrub, lines fully drawn, video replaced by its poster, cards do not move.

## Do's and Don'ts

### Do:
- **Do** keep the page dark on the starfield ground (`space-ground`), with `starlight` as the only text colour family on dark.
- **Do** use real imagery with a recorded source: every outside picture, model or clip gets an entry in `landing-credits.ts` and appears in the visible credits line.
- **Do** dissolve every photograph and video into the ground with a mask (transparent, black at 16%, black at 84%, transparent).
- **Do** start every section's type on the same left edge: gutter on the outer box, a 72rem column inside, copy capped at 28rem.
- **Do** set headlines in Fraunces directly on the image, with a scrim only where the picture is bright under the type.
- **Do** show the product as real crops at their own pixel size, with a phone capture for phones.
- **Do** make every scroll-linked piece its own reduced-motion gate and keep all copy in the server-rendered document.
- **Do** give a self-starting loop longer than five seconds a visible pause control.

### Don't:
- **Don't** fill a button or a surface with gold; gold is the star, lines, numerals, labels and states.
- **Don't** box a photograph or give it a corner radius.
- **Don't** fade a picture to a fixed colour; the ground is not one colour.
- **Don't** add a glass card as a frame for ordinary copy; a card appears only where a card is the content.
- **Don't** put a small label above a headline.
- **Don't** add a second ground change; the teal fields belong to "How it works" alone.
- **Don't** invent testimonials, logos, statistics or illustrative stand-ins for imagery; sample people in cards and figures are labelled as sample data in the source.
- **Don't** let the hero scene load in the page's first bundle or block the poster.
