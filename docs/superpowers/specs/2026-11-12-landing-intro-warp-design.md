# Landing intro: the sky warps in

Date: 2026-11-12. Status: awaiting Jason's approval.

## Intent

The first time someone opens `/` in a browser session, the page arrives instead of
appearing. The text comes in line by line, the stars drop out of a warp into the
normal sky, and the solar system comes out of that warp into its place. Every later
visit in the same session shows today's page with no intro.

Why: a memorable first impression for the landing page.

## What Jason decided

- The text is never held back. It starts at first paint and does not wait for the sky.
- Nothing crosses over anything. The solar system never passes over or behind the text.
- The warp looks like the constellation page's warp (streaks from a vanishing point
  that slow down and collapse into points).
- The warp moves the landing sky's real stars, not a separate layer.
- The 3D celestial revamp branch is out of scope, now and later.

## What a visitor sees

```
0.00s  first paint        "Orbit" fades up
0.15s                     tagline and paragraph fade up
0.30s                     hero button fades up (md and wider; phones use the header's)
sky loads (after idle,    background and nebulae fade up over ~0.4s;
 as today, ~0.5–2s)       every star streaks outward from the sun's spot
 +0.5s                    full speed
 +1.1s                    streaks shorten as the stars slow
 +1.6s                    each star stops exactly where it rests today
solar system loads        comes out of the warp: small, faint, a little to the
 (same idle gate)         left of its spot, growing into place over ~1.1s
```

After that the page is exactly today's page. Scroll, clicks and the header work the
whole time; nothing waits on the intro and nothing can skip-lock it.

## Goals

- Plays once per browser session (per tab, `sessionStorage`).
- The resting sky is pixel-for-pixel what it is today once the warp ends.
- No change to when the text, sky or solar system load. The text stays the first
  thing painted.

## Non-goals

- No intro on pricing, docs, the waitlist page or `/upgrade`, which share the sky.
- No sound, no skip button, no replay control.
- No change to the scroll-driven hero pin that follows.

## Anti-goals

- Text that waits for a script or an animation before it is readable.
- A warp that reads as a zoom, or as a static sunburst of rays.
- Any motion for visitors who ask for reduced motion (system setting or Orbit's own).

## Approaches considered

1. **Reuse the constellation warp as a layer behind the hero.** Small, leaves the
   shared sky file alone, but the streaking stars are not the resting stars, so the
   hand-off is a cross-fade.
2. **Warp the real stars (picked by Jason).** The sky's own stars streak into their
   resting places, so there is no hand-off at all. Costs an edit to the sky file four
   other pages share, and a second warp to maintain.
3. **Zoom and blur the sky canvas with CSS.** Dropped: it reads as a zoom, not a warp.

## How it is built

**The gate.** A tiny inline script in the landing page's HTML, the same pattern as
`MARK_IF_JOINED` in `early-access-pill.tsx`: if `sessionStorage` has no
`orbit:landing-intro` key, set it and put `data-landing-intro` on `<html>`. It runs
before first paint, so CSS can key off the attribute with no flash. A client-side
navigation to `/` does not run inline scripts; that case shows today's page (my call:
someone already inside the site is not a first arrival).

**The text.** CSS only, in `theme.css`. Without the attribute, `.landing-fade` works
as today (one block). With it, the block's own fade is off and its three parts
("Orbit", tagline plus paragraph, button) reuse the `landing-fade` keyframes at 0,
150 and 300ms. The parts get a marker attribute in `landing-hero.tsx`.

**The warp.** A new `intro` prop on `Starfield` (off by default), passed only by the
landing page. When on, and the attribute is present, and motion is allowed, the first
~1.6s of drawing is the warp:

- Vanishing point `V`: the centre of the solar system's box, found once by a
  `data-sky-warp-origin` attribute on the stage wrapper in `hero-pin.tsx`. Fallback:
  the viewport centre.
- Each star is drawn at `V + (rest − V) × k`, where `k` runs from the star's own
  starting depth (a fixed random value below 1) up to exactly 1 on an ease-out. The
  per-star depth is what makes it a warp instead of a uniform zoom.
- The streak is a line from where the star was a fixed time ago to where it is now,
  computed from the same formula. Its length is the star's speed, it shrinks to a
  point at rest, and it does not depend on frame rate. No second canvas.
- The background blit and the stars' alpha ramp up over the first ~0.4s, so the sky
  does not pop in.
- Shooting stars wait until the warp is over.
- When the warp ends, the loop takes exactly the path it takes today. With the prop
  off, no star does any extra work.

The timing and the position formula live in one small pure module
(`src/lib/landing-intro.ts`) so they can be checked without a browser.

**The solar system.** CSS only. With the attribute present, `.landing-solar-enter`
uses a new keyframe: from about 30% size, transparent and shifted left by about a
fifth of its own width, to rest, over ~1.1s. On phones the shift is larger, since the
system sits under the text and nothing is beside it. It starts when the solar system
mounts; the sky starts when the sky mounts. Both sit behind the same idle gate, so
they start within a few tens of milliseconds of each other. No shared clock (my call:
add one only if the drift is visible).

**Reduced motion.** The warp decision reads the preference synchronously inside the
effect (`prefersReducedMotion()` from `lib/motion-preference.ts`), not from the hook,
whose first value is always "not reduced". The CSS parts sit inside
`prefers-reduced-motion: no-preference`.

## Left to the builder, to tune by eye

- Exact durations, the ease curve, and the range of starting depths.
- Whether every star draws a streak or only a share of them. Up to ~700 stars are on
  screen; the constellation warp found that too many streaks read as a sunburst and
  capped its field at 520.
- The solar system's exact start size and offset per breakpoint.

## Checks

- A registered smoke for `landing-intro.ts`: `k` ends at exactly 1, never overshoots,
  and the streak length is 0 at the end.
- A real browser run (Playwright with system Chrome, since a hidden preview pane never
  hydrates): first load shows the intro, a reload in the same tab does not, reduced
  motion shows neither, and a screenshot after the warp matches a no-intro load.
- Pricing and the waitlist page still render their skies unchanged.
