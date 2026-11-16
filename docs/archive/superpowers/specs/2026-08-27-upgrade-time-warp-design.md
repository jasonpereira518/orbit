# Time warp into /upgrade

**Date:** 2026-08-27
**Status:** Approved design, ready for planning

## Problem

`/upgrade` is reached from two places that feel nothing alike, and it greets
both with the same motion.

- From `/pricing` — [`pricing-tiers.tsx:113`](../../../src/components/pricing/pricing-tiers.tsx) —
  you are already in deep space, having just compared plans.
- From Settings — [`plan-settings.tsx:226`](../../../src/components/settings/plan-settings.tsx) —
  you are inside the product shell, possibly in light theme, and the decision
  to pay is the thing you just made.

Both land on the brick-assembly choreography in
[`upgrade-transition.tsx`](../../../src/components/motion/upgrade-transition.tsx):
each section descends a short distance and seats. It is a good, deliberately
quiet piece of motion, and it is the right answer for the `/pricing` path,
where the page is a continuation of the one before it.

It is the wrong answer for the in-app path. Settings offers two doors side by
side — "Compare plans" and "Upgrade" — and today one of them is a full-screen
rocket lift-off ([`warp-provider.tsx`](../../../src/components/warp/warp-provider.tsx))
while the other is a plain link. The louder journey leads to the page where
nothing can be bought.

## The idea

Going from the app to `/upgrade` is a **time warp forward**. The future being
travelled to is *your orbit, grown* — the network you would have if the free
tier's 500-contact ceiling were not in front of you.

It is told abstractly. No real user data, no contact counts, no numbers of any
kind. A user with twelve contacts watching a counter blow past 500 learns only
that they do not need this yet.

### The signature: long-exposure star trails

Orbit already owns a space warp. If the time warp is "stars streaking past, but
faster," the two blur into one effect with two names, and the second one always
loses — it is the one that is not a rocket.

So the vocabulary is **long-exposure astrophotography**. As time accelerates,
stars stop being points and stretch into arcs sweeping around a celestial pole.
The faster time runs, the longer the arcs. It is the one image essentially
everyone already decodes as *time passed*, it cannot be mistaken for spatial
travel, and it makes the growth story literal: arcs are elapsed time, and new
stars igniting mid-arc are new contacts.

Deceleration collapses every arc back into a point, and those points are the
still sky you land in. That collapse is the payoff shot.

## Decisions

| Question | Decision |
|---|---|
| Fiction | Time warp forward; the future is your orbit, grown |
| Doorway | **Settings → `/upgrade` only.** `/pricing` → `/upgrade` and direct loads keep today's assembly |
| Content | Abstract constellation. No numbers, no real user data |
| Signature | Long-exposure star trails; ignitions arrive in stuttered bursts |
| Arrival | The page resolves *out of* the stream; the stage hands off to a live `<Starfield />` that stays |
| Return | Full symmetric rewind, interruptible |
| Architecture | Generalize `WarpProvider` into one provider hosting two journeys |

### Why only the Settings door

Settings already has a `WarpLink` to `/pricing` immediately beside the Upgrade
button. Someone taking Settings → `/pricing` (1.65s lift-off) → `/upgrade`
(time warp) would get two full-screen set-pieces back to back, which is where
delight turns into "let me through."

Scoping the warp to the in-app door gives the panel two distinct journeys
through two adjacent doors, and neither ever stacks on the other.

### Why the starfield becomes permanent

`/upgrade` currently carries a deliberate comment saying it has no starfield,
on the grounds that "a moving background behind a card form is friction dressed
as delight." That objection is to *motion*, and the decision here overrides it:
the page keeps a live `<Starfield />` after arrival, twinkle and shooting stars
included.

This is what makes the arrival work. The stage decelerates and cross-fades into
the real sky, exactly as the lift-off already cross-fades into `/pricing`'s
starfield at the end of a climb. It also makes `/upgrade` visually continuous
with `/pricing` instead of being the one black page in the marketing world.

**The stale comment in `page.tsx` must be rewritten, not left to contradict the
code.**

## Architecture

One provider, two journeys — not a parallel `ChronoProvider`.

The sharing is not incidental. The paint-gated cruise hold is the most
load-bearing piece of the existing system (it is what stops
`PricingPageSkeleton` flashing mid-flight) and it is exactly as necessary for
the chrono trip, since `/upgrade` performs a session resolve plus three awaited
reads before it paints. Duplicating it means duplicating the part most likely
to be got subtly wrong.

Two independent providers would also both be able to fire. Settings' two doors
are adjacent buttons; two full-screen stages racing each other is not
hypothetical. With one `phaseRef`, the existing `if (phaseRef.current !==
"idle") return` guard covers both doors by construction.

### New and changed modules

```
src/lib/warp/journeys.ts        (new)    id -> { destination, beats, opaqueMs, returnMs, stage }
src/lib/warp/chrono.ts          (new)    chrono beat table
src/lib/warp/choreography.ts    (edit)   shared mechanism + liftoff beats
src/components/warp/chrono-stage.tsx     (new)
src/components/warp/warp-stage.tsx       (renamed -> liftoff-stage.tsx, internals untouched)
src/components/warp/warp-provider.tsx    (edit)   generalized
src/components/warp/warp-link.tsx        (edit)   gains `journey` prop, defaults to "liftoff"
src/components/pricing/back-control.tsx  (edit)   runs the return arc of whichever journey delivered you
src/components/motion/upgrade-transition.tsx (edit) gains a second arrival mode
src/components/settings/plan-settings.tsx    (edit) Upgrade link becomes a chrono WarpLink
src/app/(checkout)/upgrade/page.tsx          (edit) beacon + starfield + rewritten comment
src/app/globals.css                          (edit) qualify craft rules; add chrono shutter keyframes
```

### Provider changes

- `WarpRun` gains `journey: JourneyId` (`"liftoff" | "chrono"`).
- `launch()` takes a journey id alongside the origin rect.
- Durations are read from the journey descriptor instead of module constants.
  The timer bag, `clearTimers`, the cruise hold, `CRUISE_CAP_MS` and the
  reduced-motion collapse are all already journey-agnostic and stay as they are.
- `skip()` joins the API: clear every timer, navigate immediately if the push
  has not fired, snap to settled.

**Phase names go neutral:** `ascending -> outbound`, `descending -> inbound`.
`idle`, `cruise`, `arriving` and `landing` are already neutral. A mechanical
rename across provider, stage and CSS — but `data-warp="ascending"` on a *time*
warp would be a lie sitting in the DOM.

**The arrival gate generalizes almost for free.** `arrivedByWarp()` already
stores the destination *path* rather than a boolean. It stores
`"<journeyId>:<path>"` instead and returns the journey id, or `null`.
`BackControl` asks which journey delivered the visitor and runs that journey's
return arc. `/pricing` behaviour is unchanged, and `/upgrade` reached from
`/pricing` still returns `null` and keeps plain back-navigation.

**Stages load per journey.** The provider's dynamic import becomes a lookup, so
the chrono canvas never enters the bundle for someone who only launches the
rocket.

**CSS needs a qualifying pass.** Existing rules are
`html[data-warp="ascending"] [data-warp-craft]`. With two journeys sharing both
the attribute and the craft element, they would fire the rocket's ascend
keyframes on a chrono departure. Add `data-warp-journey` on `<html>` and
qualify the existing selectors with `[data-warp-journey="liftoff"]` — three
selectors plus the reduced-motion belt-and-braces block.

`data-warp-craft` already sits on the app shell
([`app-shell.tsx:68`](../../../src/components/layout/app-shell.tsx)), which is
the surface Settings lives in, so the chrono departure needs no new DOM hook.

## Rendering the trails

Not by stroking arcs. A real long exposure *is* accumulated light, so the
canvas does the same thing: **never clear the trail layer.** Each frame erases
only a fraction of it (`destination-out` at alpha `a`) and draws each star as a
point at its new position. The residue of previous frames *is* the trail. One
`fillRect` plus N points per frame, against thousands of path segments for
stroked arcs.

Trail length then falls out of a single number — **`a` is the shutter.** Low
`a` gives long arcs, high `a` gives points. Accelerating time raises the
angular velocity and lowers `a`; decelerating raises `a` back and the arcs
collapse into stars.

Two layers: a transparent trail canvas composited with `lighter` over the
deep-space base from `sky-palette`'s `paintSpace`, painted once per resize —
the liftoff stage already caches it exactly this way. Trails add light over the
nebulae instead of erasing them each frame.

**Pole placement:** on-screen, high and off to one side (~22% / 16%), with the
innermost radii thinned so there is no dense knot at the centre. Off-screen
would give safer, gentler curves, but the concentric sweep around a visible
pole is the image people decode as "hours passed." Thinning the core keeps it
from becoming a bullseye that fights the arriving page.

**Ignitions come free.** A star that ignites mid-run begins accumulating from
where it appeared, so its arc is visibly shorter than its neighbours'. New
contacts read as younger stars without any extra machinery. Bursts flash gold
(`STAR_GOLD`, already in the palette) and decay to white.

## Beats

### Outbound, ms from click

| Beat | Window | What happens |
|---|---|---|
| `shutter` | 0 – 380 | The room goes dark. App shell dims and desaturates, `scale(0.985)`, **no translation** — nothing is travelling through space. Stage fades to opaque. |
| *route push* | 380 | Swap behind the opaque stage. Earlier and `(app)` unmounts the craft mid-animation. |
| `spin` | 300 – 1250 | Angular velocity ramps 0 to peak on a cubic ease-in. `a` falls 0.55 to 0.045. Points become long arcs. |
| `growth` | 520 – 1400 | Seven ignition bursts at **uneven** spacing. Evenly spaced bursts read as a progress bar. |
| *outbound ends* | 1450 | End of the deterministic run: decelerate immediately if `/upgrade` has painted, otherwise hold. |
| `cruise` | as needed | Velocity and `a` held; bursts continue at a slower cadence, so a long hold still reads as growth rather than as a loop. |
| `arriving` | 620ms | Velocity decays to 0, `a` ramps to 1.0, arcs collapse into points over ~380ms while the canvas cross-fades into the real `<Starfield />` beneath. |

Roughly 2.0s click-to-usable, against the rocket's 2.1s. Deliberately not
shorter: this journey has a payoff shot the rocket does not.

### Inbound, ms from Back

| Beat | Window | What happens |
|---|---|---|
| `dissolve` | 0 – 300 | Panels smear back into the exposure — blur up, opacity down, offset along the tangent. Reverse stagger, last slot first, as today's exit already does. Starfield cross-fades back into the trail canvas. |
| *`router.back()`* | ~260 | Once the stage is opaque. **Unlike the rocket**, which navigates on frame one because nothing on screen is worth preserving — here the page dissolving is the shot. |
| `rewind` | 200 – 950 | Angular velocity ramps up **negative**; arcs sweep the other way. `a` falls, trails lengthen again. |
| `extinguish` | 350 – 1050 | Ignitions run backward — stars go out in bursts, the field thins from dense to sparse. The growth un-happens. |
| `collapse` | 1050 – 1400 | Velocity to 0, `a` to 1, arcs collapse to points. |
| `landing` | 1250 – 1500 | The room lights come back up: the shell's dim and desaturation lift, scale returns, stage fades out. Exact reverse of `shutter`, which is also how the dark-to-light theme boundary is crossed on the way home. |

~1500ms against ~2070ms outbound. Symmetric in vocabulary, slightly tighter in
fact, because there is no cruise hold — `(app)` is a client navigation back to
a page that is already warm.

**Interruption.** `skip()` is bound to Escape during any phase, and to a second
press of Back. Today that second press hits `reenter()`'s `phase !== "idle"`
guard and does nothing, which would feel broken now the arc is 1.5s long.

## The page resolving out of the stream

`upgrade-transition.tsx` gains a second mode.

- **`assemble`** — today's brick choreography, unchanged, for `/pricing`
  arrivals and direct loads.
- **`resolve`** — new. Each panel starts smeared by the same exposure:
  `opacity 0`, `blur(8px)`, `scale(1.015)`, offset ~14px **along the local
  tangent of its arc**, sharpening to rest. Stagger drops to 0.045 and the
  spring becomes an ease — a spring's overshoot is the click of a brick
  seating, which is the wrong verb now.

`resolve` starts at the **beginning** of `arriving`, not after it. Panels
sharpen while the arcs are still collapsing. That overlap is the entire
difference between "resolved out of the stream" and "sky cleared, then page
faded in."

**Known risk:** `filter: blur()` on full-width panels is expensive and
historically janky in Safari. Mitigation is a short ramp (8px to 0 over 260ms)
plus `will-change`, with a clean fallback to opacity and scale only. If it
stutters on real hardware, cut the blur rather than ship the stutter, and say
which one shipped.

**Mode selection must be hydration-safe.** `arrivedByWarp()` reads
`sessionStorage`, which cannot be touched during render. Use the pattern
already in
[`use-prefers-reduced-motion.ts`](../../../src/lib/use-prefers-reduced-motion.ts):
neutral on the first render, corrected in an effect on the first client frame.

`/upgrade` also picks up `<WarpArrivalBeacon />` — which ends the cruise hold
once its session resolve and three awaited reads finish — and the permanent
`<LandingStarfield />`.

## Reduced motion

Both journeys collapse to the shared `REDUCED_MS` cross-fade, and chrono
inherits it: no trails, no spin, no blur, no dimming. The stage fades in, the
route swaps, the stage fades out, panels render at rest. `Starfield` handles its
own reduced-motion behaviour internally, so the permanent sky needs nothing
extra.

## Edge cases

Most resolve by construction rather than by new code, which is the argument for
one shared provider.

- **`/pricing` → `/upgrade` after a rocket ride.** The gate holds
  `"liftoff:/pricing"`; on `/upgrade` the pathname no longer matches, so it
  returns `null` — plain assembly, plain back. Already correct.
- **Paid users.** Settings renders the Upgrade button only when `isFree`, so
  someone who already bought never sees the chrono door. A growth warp shown to
  a paying customer is prevented structurally, not by a conditional.
- **Direct load, deep link, `?period=annual`, post-sign-in redirect** — no warp,
  `assemble` mode.
- **cmd/ctrl/shift-click, middle-click, no JS, pre-hydration** — `WarpLink` is a
  real anchor; already handled.
- **A route that never resolves** — shared `CRUISE_CAP_MS` force-resolve.
- **Safari private mode** — `sessionStorage` throws, the gate catches, plain
  navigation. Existing behaviour.
- **The billing toggle changing the URL mid-stay** — confirm during
  implementation whether it pushes or replaces. If it pushes, the rewind still
  fires correctly but Back lands one step short of Settings.

## Verification

- **Rocket regression is the top risk**, since this refactors working code. Fly
  Settings → `/pricing` and back, before and after, and confirm the two are
  indistinguishable. Any observable difference is a bug, not a design choice.
- Exercise all four `/upgrade` entry paths by hand: chrono from Settings, from
  `/pricing`, direct load, reduced motion.
- **Measure** frame timing during the trail phase rather than asserting it. The
  accumulation approach should be cheap; confirm it against a real frame budget
  and report the number.
- Build clean. eslint must not exceed its 48-error baseline.
- Browser verification in this worktree needs `node_modules` symlinked from the
  main checkout and a preview on **port 3001** — the dev server on 3000 belongs
  to the user. Confirm the tab is genuinely visible before trusting what is on
  it: an occluded tab starves `rAF` and fakes animation bugs.

## Out of scope

- No new dependencies. `motion` and canvas are both already in play.
- No change to the rocket's beats, timings or feel.
- No change to `/pricing`.
- No `lib/journey` framework extraction. Two journeys is not enough evidence to
  design an abstraction for a third; the split can happen later if one appears.
