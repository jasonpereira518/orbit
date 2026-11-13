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
sky loads (after idle,    the flight: already at speed, stars stream out of the
 as today, ~0.5–2s)       sun past the camera, covering the whole screen
 +0.3s                    short dashes; the flight is slowing
 +0.6s                    nearly settled
 +1.2s                    arrived: each star stops exactly where it rests today
solar system loads        starts at a fifth of its size and grows into place over 1.2s
 (same idle gate)         as the flight slows, scaling about its own centre
```

After that the page is exactly today's page. Scroll, clicks and the header work the
whole time; nothing waits on the intro and nothing can skip-lock it.

## Goals

- Plays once per browser session (per tab, `sessionStorage`). On localhost it plays on every load (Jason, Nov 12), so it can be watched while working on it.
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
~1.2s of drawing is the flight:

- Vanishing point `V`: the centre of the solar system's box, found once by a
  `data-sky-warp-origin` attribute on the stage wrapper in `hero-pin.tsx`. Fallback:
  the viewport centre.
- Revised twice on Nov 12. Jason: "Instead of all the stars coming from one place the
  whole screen should always be covered with stars", then "I want it to be like you are
  zooming to space and then you arrive at the solar system."
- A forward flight. Each star is drawn at `V + (rest − V) × e^u`, where `u` is its depth
  in log space: it streams outward past the camera and wraps back to `V`, like flying
  through an endless field, until the flight slows and its last lap ends at `u = 0`, its
  exact rest position. Two random numbers per star (lap offset, extra distance flown)
  spread the stars across every depth so the screen is full on every frame.
- As the flight slows every star closes in on its rest from `V`'s side, which would empty
  the edges. Temporary edge stars, resting off-screen out to 2x the screen's distance from
  `V`, fill them and land off-screen exactly when the flight ends.
- Toned down after the first look (Jason: "a little less dramatic"): slower flight and
  shorter streaks.
- Lighter (Jason: "Make it less dense when warping"): only 45% of the stars fly; the rest
  stay hidden and fade up at their places over the last 15% of the flight, so the resting
  sky is complete on arrival. Edge stars are thinned to the same share.
- Calmer and shorter (Jason: "Still a lot less movement for the stars", then "Make it half
  the time"): stars respawn at ~1/4 of their rest distance instead of ~1/11, fly less far,
  and the whole intro is 1.2s instead of 2.4s. Exact values are in lib/landing-intro.ts.
- The streak joins where the star was 45ms ago, so its length is the speed and it
  collapses on arrival; it is skipped across a wrap. Respawned stars fade up. No second
  canvas.
- The background blit and the stars' alpha ramp up over the first ~0.4s, so the sky
  does not pop in.
- Shooting stars wait until the warp is over.
- When the warp ends, the loop takes exactly the path it takes today. With the prop
  off, no star does any extra work.

The timing and the position formula live in one small pure module
(`src/lib/landing-intro.ts`) so they can be checked without a browser.

**The solar system.** CSS only. With the attribute present, `.landing-solar-enter`
uses a new keyframe: from 20% size and transparent, at the sun's position, growing to
rest over 1.2s (the flight's length), so you arrive at it. It scales about its own
centre and never moves toward the text. (Replaced the first build's left-to-right drift
when the flight was asked for.) It starts when the solar system
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
