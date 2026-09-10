---
name: Orbit
description: A calm personal networking workspace with a living celestial identity.
colors:
  orbit-teal: "#0f3d3e"
  orbit-blue: "#599de7"
  orbit-gold: "#f2c14e"
  app-canvas: "#fbfbf9"
  app-ink: "#1a1c1a"
  app-card: "#ffffff"
  app-muted: "#f0f2ee"
  app-muted-ink: "#5f6760"
  app-border: "#e4e7e1"
  dark-canvas: "#272727"
  space-canvas: "#05070f"
  space-ink: "#e8f3f1"
  space-muted-ink: "#9aada8"
typography:
  display:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "clamp(2rem, 5vw, 3.5rem)"
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "1.875rem"
    fontWeight: 400
    lineHeight: 1.15
  body:
    fontFamily: "Outfit, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Outfit, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "0.04em"
rounded:
  control: "0.625rem"
  card: "0.875rem"
  section: "1rem"
  pill: "9999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.orbit-teal}"
    textColor: "{colors.space-ink}"
    rounded: "{rounded.control}"
    padding: "0.5rem 0.75rem"
  card-default:
    backgroundColor: "{colors.app-card}"
    textColor: "{colors.app-ink}"
    rounded: "{rounded.card}"
    padding: "1rem"
  input-default:
    backgroundColor: "transparent"
    textColor: "{colors.app-ink}"
    rounded: "{rounded.control}"
    height: "2rem"
---

# Design System: Orbit

## Overview

**Creative North Star: "The Living Constellation"**

Orbit pairs a calm, practical relationship workspace with moments of genuine celestial scale. Everyday app surfaces stay light, legible, and restrained; the constellation, landing experience, and meaningful milestones may open into deep space, saturated plan colors, and authored motion. The identity comes from connected stars, orbital paths, soft atmospheric light, and information that feels organized rather than gamified.

**Key Characteristics:**

- Quiet, high-legibility operating surfaces with selective atmospheric depth.
- Fraunces for human, reflective headings; Outfit for clear product work.
- Teal in the light app, blue in the dark app and Orbit Pro, gold for offers and Orbit Lifetime.
- Rounded, softly bordered containers and pill-shaped state indicators.
- Snappy routine feedback with slower celestial motion reserved for earned moments.

## Colors

The app uses gentle warm neutrals and deep teal in light mode, graphite and clear blue in dark mode, and a fixed deep-space palette for marketing and constellation experiences.

### Primary

- **Orbit Teal:** the light app's main action, heading, focus, and navigation color.
- **Orbit Blue:** the dark app's main action color and the committed Orbit Pro identity.

### Secondary

- **Orbit Gold:** a scarce offer and milestone color, committed to Orbit Lifetime rather than routine app actions.

### Neutral

- **App Canvas, Card, Ink, Muted, Muted Ink, and Border:** the warm, low-contrast operating palette.
- **Dark Canvas:** the graphite app surface used in dark mode.
- **Space Canvas, Space Ink, and Space Muted Ink:** the fixed celestial world used by marketing and constellation experiences.

**The Earned Color Rule.** Blue and gold may drench a surface only when the state itself is the subject; routine application screens use color as hierarchy, not atmosphere.

## Typography

**Display Font:** Fraunces (with Georgia fallback)
**Body Font:** Outfit (with system sans-serif fallback)

**Character:** Fraunces gives relationship-centered moments a reflective, human voice. Outfit keeps dense controls, navigation, settings, and data highly legible.

### Hierarchy

- **Display:** regular-weight Fraunces with tight leading for marketing and singular milestone statements.
- **Headline:** regular-weight Fraunces for page titles and important section headings.
- **Body:** regular Outfit, generally 14–16px, for product copy and data.
- **Label:** medium Outfit, occasionally uppercase and tracked, for compact metadata and navigation group labels.

**The Two-Voice Rule.** Fraunces names and frames; Outfit explains and operates. Do not use the display face for dense controls or long product copy.

## Layout

The authenticated app uses a persistent desktop sidebar, a compact mobile header and bottom navigation, and a centered content column capped near 72rem. Settings narrow to a readable single column. Spacing is generous around section boundaries and compact inside controls. Full-viewport constellation experiences deliberately break the content container while preserving safe-area padding and mobile reachability.

## Elevation & Depth

Routine cards are primarily separated by tonal surfaces and translucent borders rather than heavy shadows. Interactive cards may gain one restrained ambient shadow. The sidebar uses layered liquid glass with bounded blur and inner highlights. Deep-space surfaces use glow, nebular light, and inset darkness instead of generic drop shadows.

**The Flat-Until-Meaningful Rule.** Elevation appears for interaction, persistent floating navigation, or celestial depth; static content does not receive decorative shadow stacks.

## Shapes

Controls use gently rounded corners, cards use larger soft corners, and major sections commonly use a 1rem radius. Pills are reserved for compact status, filters, and shared-element navigation state. Constellation geometry is circular and radial, but it should connect information rather than become decorative icon wallpaper.

## Components

### Buttons

- **Shape:** compact rounded controls with medium-weight labels.
- **Primary:** solid semantic primary color with high-contrast text; active state moves down by one pixel.
- **Hover / Focus:** short color transitions and a three-pixel translucent focus ring.
- **Secondary / Ghost:** tonal or transparent treatments that remain quieter than the primary action.

### Chips

- **Style:** pill-shaped, lightly bordered, and compact; selected state uses the semantic accent plus text, never color alone.

### Cards / Containers

- **Corner Style:** soft 0.875–1rem corners.
- **Background:** solid or lightly translucent card tones.
- **Shadow Strategy:** flat by default; ambient lift only for interactive or floating states.
- **Border:** subtle foreground or semantic-border tint.
- **Internal Padding:** typically 1–1.5rem.

### Inputs / Fields

- **Style:** transparent or tonal surface with a quiet border and compact height.
- **Focus:** semantic border plus translucent ring.
- **Error / Disabled:** retain readable text and pair state color with structure or copy.

### Navigation

Desktop navigation lives in a liquid-glass rail. The active destination uses a softly raised shared-element pill; inactive destinations remain muted until hover. Mobile navigation preserves the same hierarchy in a bottom-reachable form.

### Constellation Stage

The signature celestial component combines a deep tinted canvas, sparse stars, atmospheric nebulae, orbital connections, and selectively glowing nodes. Motion is slow and breathing at rest, then confident and directional when explaining a state change.

## Do's and Don'ts

### Do:

- **Do** reserve celestial spectacle for landing, constellation, onboarding, and genuinely earned milestones.
- **Do** keep routine transitions within the fast/base motion tier and use the house easing curve for authored arrivals.
- **Do** preserve strong written hierarchy and reduced-motion behavior whenever color and motion become expressive.

### Don't:

- **Don't** scatter blue and gold together as generic decoration; each has a plan and hierarchy role.
- **Don't** replace the product's connected-star language with generic confetti, trophies, or arcade badges.
- **Don't** stack blur, glow, gradients, and shadows unless each layer communicates depth or state.
