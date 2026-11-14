# Landing Intro Warp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the first load of `/` in a tab session, stagger the hero text in, warp the landing sky's real stars out of the solar system's centre into their resting places, and grow the solar system into place.

**Architecture:** A pre-paint inline script sets `html[data-landing-intro]` once per session. CSS keyed on that attribute staggers the hero text and swaps the solar system's entrance keyframe. `Starfield` gains an `intro` prop. When on, it draws each star along a pure warp curve from `src/lib/landing-intro.ts` for its first 1.6s, then falls back to today's loop unchanged.

**Tech Stack:** Next.js (repo's version — read `node_modules/next/dist/docs/` before touching framework APIs), React client components, Canvas 2D, Tailwind v4 + `src/app/theme.css`, tsx smokes via `scripts/run-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-11-12-landing-intro-warp-design.md`

## Global Constraints

- The text is never held back: it starts at first paint, and nothing in this plan changes when the text, sky or solar system load (`useAfterIdle` in `landing-visuals.tsx` stays as is).
- The solar system never passes over or behind the text.
- Once the warp ends, the resting sky must be exactly today's: the same stars, positions, alphas and loop path.
- Once per tab session (`sessionStorage`). There is no intro under reduced motion, whether from the system setting or Orbit's own `html[data-motion="reduce"]`, or after a client-side navigation to `/`.
- Pricing, docs, `/interest` and `/upgrade` share `Starfield`. With `intro` off they must do no extra per-star work.
- The 3D celestial revamp branch is out of scope; build on main's landing only.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Client-side navigation back to `/`** (e.g. pricing → logo): no warp and no staggered or drifting entrance. Pinned in Task 2 (`LandingIntroGate` removes the attribute on unmount) and Task 1 (`takeLandingIntro` is true at most once per page load).
2. **Opening `/#features` or any URL with a hash:** the visitor lands mid-page, so there is no intro. The gate script skips when `location.hash` is non-empty (Task 1 smoke asserts the script text checks `location.hash`).
3. **Resize or rotate mid-warp:** stars end at rest, with no stretched streaks. In Task 3, `resize()` ends the warp.
4. **Tab opened in the background, or hidden mid-warp:** on return the sky is at rest with no screen-wide streak. Elapsed time runs past the end, so `warpProgress` is 1 and the streak length is 0. Pinned in the Task 1 smoke.
5. **Storage blocked** (Safari private mode, disabled storage): no intro and no thrown error. The gate script is wrapped in `try{}catch(e){}` (Task 1 smoke asserts it).

---

### Task 1: Pure intro module + smoke

**Files:**
- Create: `src/lib/landing-intro.ts`
- Create: `scripts/smoke-landing-intro.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST: add `"smoke-landing-intro": "pure",` next to `"smoke-reveal-reduced-motion"`, line ~374)
- Also commit: `docs/superpowers/specs/2026-11-12-landing-intro-warp-design.md`, this plan

**Interfaces:**
- Produces (all exported from `src/lib/landing-intro.ts`):
  - `LANDING_INTRO_KEY = "orbit:landing-intro"`, `LANDING_INTRO_ATTR = "data-landing-intro"`
  - `LANDING_INTRO_PREPAINT_SCRIPT: string`: the dependency-free inline script
  - `WARP_MS = 1600`, `SKY_FADE_MS = 400`, `STREAK_LAG_MS = 60`, `WARP_DEPTH_MIN = 0.02`, `WARP_DEPTH_MAX = 0.35` (tuning knobs; the values are starting points)
  - `warpProgress(elapsedMs: number): number`: eased 0→1 over `WARP_MS`, clamped, ease-out cubic, 0 for negative input
  - `warpK(depth0: number, p: number): number`: `depth0 + (1 - depth0) * p`
  - `warpPoint(restX: number, restY: number, ox: number, oy: number, k: number): { x: number; y: number }`: `origin + (rest - origin) * k`
  - `skyAlpha(elapsedMs: number): number`: linear 0→1 over `SKY_FADE_MS`, clamped
  - `takeLandingIntro(): boolean`: true only if `document.documentElement` has `LANDING_INTRO_ATTR`, no reduced motion (`prefersReducedMotion()` from `@/lib/motion-preference`), and it has not returned true before in this page load (module-level flag)

- [ ] **Step 1: Write the failing smoke** `scripts/smoke-landing-intro.ts`, in the same `CASES` / `ok`/`FAIL` / `process.exit` style as `scripts/smoke-reveal-reduced-motion.ts`. Cases:
  - `warpProgress(0) === 0`, `warpProgress(-50) === 0`, `warpProgress(WARP_MS) === 1`, `warpProgress(WARP_MS * 40) === 1` (tab hidden for a minute)
  - monotonic and never above 1: sample 0..WARP_MS in 16ms steps
  - `warpK(0.2, 1) === 1` exactly, and `warpK(0.2, 0) === 0.2`
  - `warpPoint(300, 200, 100, 100, 1)` deep-equals `{ x: 300, y: 200 }` exactly (stars land on their rest pixel)
  - streak length is 0 once the warp is over: at `e = WARP_MS + STREAK_LAG_MS`, `warpPoint(…, warpK(0.2, warpProgress(e)))` equals `warpPoint(…, warpK(0.2, warpProgress(e - STREAK_LAG_MS)))`
  - `skyAlpha(0) === 0`, `skyAlpha(SKY_FADE_MS) === 1`, `skyAlpha(1e6) === 1`
  - `LANDING_INTRO_PREPAINT_SCRIPT` includes `"sessionStorage"`, `"location.hash"`, `"data-motion"`, `"prefers-reduced-motion: reduce"`, `LANDING_INTRO_KEY`, `LANDING_INTRO_ATTR`, starts with `"try{"`, and ends with `"}catch(e){}"`

- [ ] **Step 2: Run it and see it fail**

Run: `npx tsx scripts/smoke-landing-intro.ts`
Expected: fails to import `../src/lib/landing-intro`

- [ ] **Step 3: Implement `src/lib/landing-intro.ts`** with the exports above. Do not import `next/*` or React. The prepaint script, as one string with the same shape as `MOTION_PREPAINT_SCRIPT`, is: inside try/catch, if `!location.hash`, `document.documentElement` has no `data-motion="reduce"`, `!matchMedia("(prefers-reduced-motion: reduce)").matches`, and `!sessionStorage.getItem(KEY)`, then `sessionStorage.setItem(KEY,"1")` and set the attribute to `""`. A doc comment says why it is pre-paint (CSS keys off it with no flash) and that it runs after the root layout's `MOTION_PREPAINT_SCRIPT`, which is why `data-motion` is already set.

- [ ] **Step 4: Add it to the manifest and run**

Run: `npx tsx scripts/smoke-landing-intro.ts && npx tsx scripts/run-smoke.ts --check`
Expected: all cases `ok`; then `run-smoke: manifest covers N scripts; structure ok.`

- [ ] **Step 5: Commit**

```bash
git add src/lib/landing-intro.ts scripts/smoke-landing-intro.ts scripts/run-smoke.ts docs/superpowers/specs/2026-11-12-landing-intro-warp-design.md docs/superpowers/plans/2026-11-12-landing-intro-warp.md
git commit -m "feat(landing): intro warp timing module and once-per-session gate script"
```

---

### Task 2: Gate on the page + staggered hero text

**Files:**
- Create: `src/components/landing/landing-intro-gate.tsx`
- Modify: `src/components/landing/landing-page.tsx` (render `<LandingIntroGate />` as the FIRST child of `.landing-root`, before `<LandingStarfield />`)
- Modify: `src/components/landing/landing-hero.tsx` (root div gets `data-landing-hero`; `<p>Orbit</p>` gets `data-intro-step="1"`; the `<h1>` and the paragraph each get `data-intro-step="2"`; the auth-controls wrapper div gets `data-intro-step="3"`)
- Modify: `src/app/theme.css` (after `.landing-solar-enter`, ~line 1617)

**Interfaces:**
- Consumes: `LANDING_INTRO_PREPAINT_SCRIPT`, `LANDING_INTRO_ATTR` from Task 1
- Produces: `export function LandingIntroGate(): JSX.Element` (`"use client"`); the attribute `html[data-landing-intro]` that Tasks 3 and 4 read

- [ ] **Step 1: Implement `LandingIntroGate`.** Follow `early-access-pill.tsx`'s pattern: `<script dangerouslySetInnerHTML={{ __html: LANDING_INTRO_PREPAINT_SCRIPT }} />`. Add one `useEffect` whose cleanup removes `LANDING_INTRO_ATTR` from `<html>` on unmount, so a client-side return to `/` sees no attribute (Review Focus 1). Unlike the pill, it does NOT set the attribute in an effect: a client navigation is not a first arrival.

- [ ] **Step 2: Add the CSS.** Inside `@media (prefers-reduced-motion: no-preference)`:
  - `html[data-landing-intro] [data-landing-hero] { animation: none; }`
  - `html[data-landing-intro] [data-intro-step] { animation: landing-fade var(--transition-duration-celestial) var(--ease-house) both; }`
  - `[data-intro-step="2"]` → `animation-delay: 150ms`; `[data-intro-step="3"]` → `animation-delay: 300ms` (both scoped under `html[data-landing-intro]`)

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit -p . && npx eslint src/components/landing src/lib/landing-intro.ts`
Expected: no errors (warnings at or under the repo's ratchet)

- [ ] **Step 4: Verify in a real browser.** A hidden preview pane never hydrates, so use Playwright with system Chrome (`channel: "chrome"`) against the worktree's dev server. Load `/` in a fresh context and check:
  - `document.documentElement.hasAttribute("data-landing-intro") === true`
  - `getComputedStyle([data-intro-step="3"]).animationDelay === "0.3s"`
  - reload the same page: attribute absent
  - new context with `reducedMotion: "reduce"`: attribute absent
  - new context, `/#features`: attribute absent

- [ ] **Step 5: Commit**

```bash
git add src/components/landing/landing-intro-gate.tsx src/components/landing/landing-page.tsx src/components/landing/landing-hero.tsx src/app/theme.css
git commit -m "feat(landing): once-per-session intro gate and staggered hero text"
```

---

### Task 3: Warp the real stars

**Files:**
- Modify: `src/components/landing/starfield.tsx`
- Modify: `src/components/landing/landing-visuals.tsx` (`LandingStarfield({ interactive = false, intro = false })`, passing `intro` through)
- Modify: `src/components/landing/landing-page.tsx` (`<LandingStarfield intro />`)
- Modify: `src/components/landing/hero-pin.tsx` (the solar stage wrapper `motion.div` with `ref={camWrapRef}` gets `data-sky-warp-origin`)

**Interfaces:**
- Consumes: `takeLandingIntro`, `warpProgress`, `warpK`, `warpPoint`, `skyAlpha`, `WARP_MS`, `STREAK_LAG_MS`, `WARP_DEPTH_MIN`, `WARP_DEPTH_MAX` from Task 1
- Produces: `Starfield({ interactive?: boolean; intro?: boolean })`; the `intro` prop defaults to `false`

- [ ] **Step 1: Add the warp state to `Starfield`'s effect.**
  - `const warp = intro && !interactive && !reduced && takeLandingIntro();` is read once at the top of the effect. Add `intro` to the effect deps.
  - `let warpStart = warp ? -1 : Infinity;` is set to `now` on the first `draw`.
  - The origin is `ox, oy`: the centre of `document.querySelector("[data-sky-warp-origin]")?.getBoundingClientRect()`, read once at the first warp frame. The fallback is `width / 2, height / 2`.
  - Add `d0: number` to `Star`. Set it in `resize()` to `WARP_DEPTH_MIN + Math.random() * (WARP_DEPTH_MAX - WARP_DEPTH_MIN)` only when `warp` (otherwise `0`), so non-intro skies make no extra random calls per star.
  - `resize()` sets `warpStart = Infinity` (ends the warp) when it runs after the first frame (Review Focus 3).
  - `nextShot` is pushed to at least `warpStart + WARP_MS + 800` while warping.

- [ ] **Step 2: Draw the warp in `draw(now)`.** Let `e = now - warpStart` and `warping = e < WARP_MS`.
  - When `warping`, the background blit and every star's alpha are multiplied by `skyAlpha(e)`.
  - In the `!active` branch only, after computing the rest `x, y` and before the cull: `k = warpK(s.d0, warpProgress(e))`, then draw at `warpPoint(x, y, ox, oy, k)`. The streak is a line from `warpPoint` at `warpK(s.d0, warpProgress(e - STREAK_LAG_MS))` to the current point, `lineWidth = r * 2`, `lineCap = "round"`, same fill colour and alpha. Fall back to the existing `arc` when the segment is under 0.5px.
  - Cull on the warped position.
  - When not `warping`, the loop must be byte-for-byte today's path: one boolean check per star, no other work.
  - Add `!warping` to the calm-frame skip condition.

- [ ] **Step 3: Typecheck, lint, and rerun the Task 1 smoke**

Run: `npx tsc --noEmit -p . && npx eslint src/components/landing && npx tsx scripts/smoke-landing-intro.ts`
Expected: no errors; smoke passes

- [ ] **Step 4: Verify in a real browser** (Playwright + system Chrome, as in Task 2).
  - A fresh context on `/`: screenshots at about 200ms, 800ms and 1400ms after the canvas first paints show streaks from the solar system's centre.
  - A screenshot at 3s compared to a reload's screenshot at 3s (no intro). Star positions match; the twinkle and random field differ per load, so compare by eye, not pixel diff (the stars are re-randomised per load). What to look for: no star still moving or streaked at 3s, and the same density and brightness as the reload.
  - `/pricing` renders its sky with no warp.
  - Resize the window to 390×844 at 600ms: there is no stretched streak, and the sky is at rest by the next frame.
  - Tune `WARP_DEPTH_*`, `WARP_MS` and streak drawing by eye. If the streaks read as a sunburst, draw streaks for only a share of stars (e.g. `s.r > 0.8`) and plain dots for the rest.

- [ ] **Step 5: Commit**

```bash
git add src/components/landing/starfield.tsx src/components/landing/landing-visuals.tsx src/components/landing/landing-page.tsx src/components/landing/hero-pin.tsx src/lib/landing-intro.ts
git commit -m "feat(landing): warp the real stars into place on the first visit"
```

---

### Task 4: Solar system comes out of the warp

**Files:**
- Modify: `src/app/theme.css` (next to `@keyframes landing-solar-enter`, ~line 1598)

**Interfaces:**
- Consumes: `html[data-landing-intro]` (Task 2); the existing `.landing-solar-enter` class on `.hero-solar` in `hero-solar-system.tsx:285` (unchanged)

- [ ] **Step 1: Add `@keyframes landing-solar-warp`.** It goes from `opacity: 0; transform: translateX(var(--solar-warp-x)) scale(0.3)` to `opacity: 1; transform: none`. Inside `@media (prefers-reduced-motion: no-preference)`: `html[data-landing-intro] .landing-solar-enter { --solar-warp-x: -20%; animation-name: landing-solar-warp; animation-duration: 1.1s; }`. Below `md` (`@media (max-width: 767px)`), `--solar-warp-x: -60%`. Keep the existing 0.15s delay and `--ease-house`.

- [ ] **Step 2: Verify in a real browser.**
  - At 1440×900, take frames during the entrance. The solar system's bounding box never overlaps the hero copy's bounding box: compare `getBoundingClientRect()` of `.hero-solar` and `[data-landing-hero]` on each sampled frame.
  - At 390×844 it slides in from the left under the text.
  - A reload shows today's 0.9s scale-in.

- [ ] **Step 3: Commit**

```bash
git add src/app/theme.css
git commit -m "feat(landing): solar system grows out of the warp on the first visit"
```

---

### Task 5: Whole-branch check

**Files:** none new.

- [ ] **Step 1: Run the repo checks**

Run: `npx tsc --noEmit -p . && npx eslint . && npx tsx scripts/run-smoke.ts --check && npx tsx scripts/smoke-landing-intro.ts && npx tsx scripts/smoke-reveal-reduced-motion.ts && npx tsx scripts/smoke-landing-anchors.ts && npx tsx scripts/smoke-marketing-footer.ts`
Expected: tsc and eslint report 0 errors; every smoke passes. If a smoke fails, rerun it alone before treating it as yours, since smokes flake under load.

- [ ] **Step 2: Walk through the Review Focus list in the browser.** Check client navigation pricing → `/`, `/#features`, a mid-warp resize, a tab opened in the background, and storage blocked (`sessionStorage.setItem` throwing via an init script). Each shows no intro or a sky at rest, with no console errors.

- [ ] **Step 3: Production build** (stop any `next dev` on this worktree first; the build shares `.next`)

Run: `npm run build`
Expected: the build passes; `/` first-load JS stays within the existing page budget (`npx tsx scripts/smoke-page-budgets.ts`).
