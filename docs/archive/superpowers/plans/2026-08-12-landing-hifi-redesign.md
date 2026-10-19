# Landing Page Hi-Fi Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revise the four sections added in the prior landing-page plan (Features, How it works, Social proof, Pricing/CTA+Footer) into a hi-fi design: richer per-feature visuals, an orbit-map "how it works" diagram with scroll-driven rotation, a real reply-rate stat, a Clerk-waitlist-backed signup section (replacing the pricing/CTA framing), a proper multi-group footer with new Terms/Contact stub pages, upgraded starfield motion, and scroll-reveal animation on every section.

**Architecture:** New design tokens and a few shared CSS primitives (`.landing-glass`, `.landing-reveal`) land first in `globals.css`, since every later task depends on them. Each section component is then rewritten in place (same file, same export name) to match the hi-fi spec. `LandingPricingCta` is replaced by a new `LandingWaitlist` component (+ a `WaitlistForm` client subcomponent wired to Clerk's waitlist mode). `LandingFooter` gains two more nav links, requiring two new stub routes.

**Tech Stack:** Next.js App Router, React, Tailwind CSS v4, TypeScript strict, `@clerk/nextjs` v7 (`useClerk().joinWaitlist`).

**Source spec:** The original hi-fi spec (`/Users/jasonpereira/Downloads/CLAUDE_CODE_PROMPT.md`, pasted into chat) is authoritative for every exact value in this plan — colors, sizes, spacing, positions. This plan translates that prose into the codebase's existing conventions (Tailwind arbitrary-value syntax, `font-[family-name:var(--font-display)]`, etc.) established in `landing-hero.tsx` and the previously-built section files.

## Global Constraints

- Follow existing conventions in `src/components/landing/*`: function components, Tailwind v4 utility classes, no CSS-in-JS (inline `style` objects are used only where Tailwind arbitrary values can't express something — dynamic gradients, computed transforms — matching how `hero-solar-system.tsx` already does this).
- Reuse existing primitives: `LandingStarfield`/`LandingSolarSystem` from `landing-visuals.tsx`, `OrbitLogo`, `cn` from `@/lib/utils`. Do not invent new motifs beyond what this plan specifies.
- Colors: existing `#05070f` background, `#e8f3f1` primary text, `#9aada8` muted, `#6d807c` dim, PLUS the new tokens added in Task 1 (`#f2c14e` accent, `#eef7f4` button surface, `#0f2e28` button label). No generic shadcn `--color-*` tokens on this page — same rule as the prior plan.
- TypeScript strict: true, no `any`.
- No test framework exists in this repo — verify manually via dev server + browser/`get_page_text` checks, same as the prior plan.
- `prefers-reduced-motion: reduce` must be respected everywhere motion is added: scroll-reveal resolves to final state, the orbit map's scroll listener is never attached, starfield paints one static frame with no rAF loop (already true — no change needed there), orbit rotation is disabled.
- Two decisions already resolved with the user (do not re-litigate):
  1. Starfield stays `position: absolute` inside the page wrapper (sized via `ResizeObserver`+`scrollHeight`, already built) — NOT `position: fixed`. The spec's suggested `fixed inset-0 -z-0` was rejected as fragile (it only "works" today because `.page-transition`'s transform animation coincidentally creates a containing block).
  2. Hero keeps `min-h-[calc(100svh-5.5rem)]` (already in place) — NOT literal `min-h-screen` — since the header now sits above it as a separate element.
- The hero's old footer links were already removed in a prior task; `landing-hero.tsx` needs no changes in this plan.
- The `2.4×` reply-rate stat is a real, confirmed number (per the user) — ship it as final copy, not a placeholder. Remove the old `[CONFIRM]` comment language when rewriting `LandingProof`.
- Do not build a shared `<LandingSection>` wrapper component — repeat the section-shell className literal in each component, matching the prior plan's explicit "don't abstract yet" guidance from its final review.

---

## File Structure

| File | Change |
|---|---|
| `src/app/globals.css` | Add `--color-landing-accent`, `--color-landing-button-surface`, `--color-landing-button-label` theme tokens; `--landing-page-gradient` CSS var; `.landing-glass` class; `.landing-reveal` class + scroll-timeline animation + `@supports` fallback; fold both new animated classes into the existing `prefers-reduced-motion` block. |
| `src/components/landing/starfield.tsx` | Canvas becomes transparent (stops painting its own opaque background gradient — that moves to the page wrapper as a CSS gradient); adds gold stars + bloom; retunes shooting-star cadence and star density to match spec. |
| `src/components/landing/landing-page.tsx` | Applies `--landing-page-gradient` to the wrapper; swaps `LandingPricingCta` → `LandingWaitlist`. |
| `src/components/landing/landing-features.tsx` | Full rewrite: eyebrow/H2 header, 3 glass cards with per-card absolutely-positioned mini visuals, card 2 reversed on desktop. |
| `src/components/landing/landing-how-it-works.tsx` | Full rewrite: becomes a client component; orbit-map layout (rings, glow, sun, 4 nodes at 12/3/6/9) with scroll-driven rotation and counter-rotating labels. |
| `src/components/landing/landing-proof.tsx` | Full rewrite: eyebrow, 2-col grid, pull quote + founder blurb + avatar/credit on the left, real `2.4×` stat panel on the right. |
| `src/components/landing/landing-pricing-cta.tsx` | Deleted — replaced by `landing-waitlist.tsx`. |
| `src/components/landing/landing-waitlist.tsx` | New: waitlist section (headline + glass form card), decorative glow, renders `WaitlistForm`. |
| `src/components/landing/waitlist-form.tsx` | New client component: email input + submit button wired to Clerk's `useClerk().joinWaitlist()`, with loading/success/error states, and a non-Clerk fallback for demo mode. |
| `src/components/landing/landing-footer.tsx` | Rewrite: 3-group layout (logo+wordmark, nav links incl. new Terms/Contact, credit link). |
| `src/app/(marketing)/terms/page.tsx` | New stub route, modeled on `privacy/page.tsx`. |
| `src/app/(marketing)/contact/page.tsx` | New stub route, modeled on `privacy/page.tsx`. |

---

### Task 1: Design tokens + shared CSS primitives (foundation)

**Files:**
- Modify: `src/app/globals.css`

**Interfaces:**
- Produces: Tailwind utilities `bg-landing-accent`, `text-landing-accent`, `border-landing-accent`, `bg-landing-button-surface`, `text-landing-button-label` (auto-generated by Tailwind v4 from `--color-landing-*` theme tokens).
- Produces: CSS var `--landing-page-gradient`, usable via `style={{ backgroundImage: "var(--landing-page-gradient)" }}`.
- Produces: CSS classes `.landing-glass` and `.landing-reveal` for later tasks to apply.

- [ ] **Step 1: Add the three new color tokens to `@theme inline`**

In `src/app/globals.css`, inside the existing `@theme inline { ... }` block (around line 8-47), add these three lines alongside the other `--color-*` entries:

```css
  --color-landing-accent: #f2c14e;
  --color-landing-button-surface: #eef7f4;
  --color-landing-button-label: #0f2e28;
```

- [ ] **Step 2: Add the page-background gradient var**

In the `:root { ... }` block (around line 49-83), add:

```css
  --landing-page-gradient: radial-gradient(
    130% 80% at 64% 34%,
    #111c33 0%,
    #0a1120 42%,
    #05070f 78%
  );
```

- [ ] **Step 3: Add `.landing-glass`**

Add a new section near the existing `/* ── Landing hero ── */` block (around line 580):

```css
/* ── Landing glass surfaces ── */

.landing-glass {
  border: 1px solid rgba(232, 243, 241, 0.08);
  background: linear-gradient(
    180deg,
    rgba(232, 243, 241, 0.045) 0%,
    rgba(232, 243, 241, 0.015) 100%
  );
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
```

Note: `.landing-glass` intentionally does NOT set `border-radius` — call sites add their own `rounded-*` utility (12px buttons/inputs, 16px inner cards, 24px/`rounded-3xl` feature cards), matching the spec's per-context radii.

- [ ] **Step 4: Add `.landing-reveal`**

Immediately after `.landing-glass`:

```css
@keyframes landing-reveal-in {
  from {
    opacity: 0;
    transform: translateY(22px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.landing-reveal {
  animation: landing-reveal-in 0.8s cubic-bezier(0.2, 0.7, 0.3, 1) both;
  animation-timeline: view();
  animation-range: entry 8% cover 30%;
}

@supports not (animation-timeline: view()) {
  .landing-reveal {
    animation: none;
    opacity: 1;
    transform: none;
  }
}
```

- [ ] **Step 5: Fold `.landing-reveal` into the existing reduced-motion block**

Find the `@media (prefers-reduced-motion: reduce) { ... }` block at the end of the file (around line 728). Add `.landing-reveal` to the selector list that gets `animation: none !important; transition: none !important;` (alongside `.landing-fade`, `.landing-solar-enter`, etc.), AND add it to the second selector list right below that already resets `opacity: 1; transform: none;` for `.landing-fade`, `.landing-solar-enter`, `.page-transition`. Concretely, change:

```css
    .landing-fade,
    .landing-solar-enter,
    .landing-credit-shimmer,
    .page-transition {
```
to
```css
    .landing-fade,
    .landing-solar-enter,
    .landing-credit-shimmer,
    .landing-reveal,
    .page-transition {
```
(in the `animation: none !important` list), and change:
```css
  .landing-fade,
  .landing-solar-enter,
  .page-transition {
    opacity: 1;
    transform: none;
  }
```
to
```css
  .landing-fade,
  .landing-solar-enter,
  .landing-reveal,
  .page-transition {
    opacity: 1;
    transform: none;
  }
```

- [ ] **Step 6: Verify**

Run `npm run dev`, confirm it compiles with no errors. Run `npx tsc --noEmit` if convenient (CSS changes don't affect TS, but confirms nothing else broke). No visual check needed yet — nothing consumes these tokens/classes until later tasks.

- [ ] **Step 7: Commit**

```bash
git add src/app/globals.css
git commit -m "feat: add hi-fi landing design tokens and shared glass/reveal CSS"
```

---

### Task 2: Starfield upgrade + page background gradient

**Files:**
- Modify: `src/components/landing/starfield.tsx`
- Modify: `src/components/landing/landing-page.tsx`

**Interfaces:**
- No signature changes — `Starfield()` and `LandingPage({ clerkOn, demoMode })` keep their existing props.
- Depends on: `--landing-page-gradient` from Task 1.

**Design intent (important — read before coding):** the canvas currently paints its OWN opaque background gradient every frame (`ctx.fillRect` with a radial gradient, then a teal wash) before drawing stars. That means any CSS background placed on an ancestor element is completely hidden behind the canvas. To let the new `--landing-page-gradient` show through, the canvas must become transparent except for the stars themselves — stop painting the background fills, and rely on `ctx.clearRect` each frame instead. This is a deliberate technical call to satisfy the spec's "apply the page background gradient at the wrapper" instruction; note it in your report so it's visible to review.

- [ ] **Step 1: Make the canvas transparent (remove its own background painting)**

In `src/components/landing/starfield.tsx`, inside the `draw(now)` function, remove the two blocks that paint the deep-space gradient and the teal wash:

```tsx
      // Deep space base + subtle nebula wash
      const g = ctx!.createRadialGradient(...);
      g.addColorStop(0, "#12182a");
      g.addColorStop(0.55, "#0a0d18");
      g.addColorStop(1, "#05070f");
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, width, height);

      const teal = ctx!.createRadialGradient(...);
      teal.addColorStop(0, "rgba(15, 61, 62, 0.28)");
      teal.addColorStop(1, "rgba(15, 61, 62, 0)");
      ctx!.fillStyle = teal;
      ctx!.fillRect(0, 0, width, height);
```

Keep the `ctx!.clearRect(0, 0, width, height);` line at the top of `draw()` — that's what keeps the canvas transparent between frames now that nothing repaints an opaque background.

- [ ] **Step 2: Add gold stars + bloom**

Update the `Star` type and star generation to carry a color and bloom flag:

```tsx
type Star = {
  x: number;
  y: number;
  r: number;
  a: number;
  twinkle: number;
  phase: number;
  gold: boolean;
  bloom: boolean;
};
```

In the star-generation `Array.from(...)` inside `resize()`, add the two new fields:

```tsx
      stars = Array.from({ length: Math.min(count, 1400) }, () => {
        const gold = Math.random() < 0.04;
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          r: Math.random() * 1.4 + 0.3,
          a: Math.random() * 0.55 + 0.25,
          twinkle: Math.random() * 0.008 + 0.004,
          phase: Math.random() * Math.PI * 2,
          gold,
          bloom: gold && Math.random() < 0.35,
        };
      });
```

In the star-drawing loop inside `draw()`, use the color and bloom:

```tsx
      for (const s of stars) {
        const alpha = reduced
          ? s.a
          : s.a * (0.65 + 0.35 * Math.sin(now * s.twinkle + s.phase));
        const color = s.gold
          ? `rgba(242, 193, 78, ${alpha})`
          : `rgba(232, 243, 241, ${alpha})`;
        ctx!.beginPath();
        ctx!.fillStyle = color;
        if (s.bloom) {
          ctx!.shadowBlur = 6;
          ctx!.shadowColor = s.gold ? "rgba(242, 193, 78, 0.8)" : "rgba(232, 243, 241, 0.6)";
        } else {
          ctx!.shadowBlur = 0;
        }
        ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.shadowBlur = 0;
```

(The trailing `ctx!.shadowBlur = 0;` after the loop prevents bloom from leaking into the shooting-star draw calls that follow.)

- [ ] **Step 3: Retune density to ~1 star per 2400px² and shooting-star cadence to 5-14s**

In `resize()`, replace the density calculation:

```tsx
      const count = Math.floor((width * height) / 2400);
```

(This replaces the existing `density`/`count` two-line calculation — the `Math.min(count, 1400)` cap already applied in Step 2's `Array.from` call.)

In `spawnShooter()`, change the `nextShot` line from `Math.random() * 2800 + 2200` to:

```tsx
      nextShot = now + Math.random() * 9000 + 5000;
```

- [ ] **Step 4: Apply the page gradient at `landing-page.tsx`**

In `src/components/landing/landing-page.tsx`, add the gradient as an inline style on the existing wrapper `<div>` (Tailwind can't express a `var()`-based `background-image` with this exact gradient syntax cleanly, so use `style` here — same pattern as `hero-solar-system.tsx` already uses for computed values):

```tsx
    <div
      className="relative flex min-h-screen flex-col overflow-hidden bg-[#05070f] text-[#e8f3f1]"
      style={{ backgroundImage: "var(--landing-page-gradient)" }}
    >
```

(Keep `bg-[#05070f]` as the fallback base color for browsers/moments before the gradient paints; the inline `style` layers on top.)

- [ ] **Step 5: Manual verification**

Run `npm run dev`, open `http://localhost:3000`. Confirm: the deep-blue radial gradient is visible behind the stars (not flat black), stars still twinkle, occasional gold stars are visible, shooting stars still appear (now rarer — you may need to wait up to ~14s to see one). Check `prefers-reduced-motion` still works (starfield should render one static frame, no shooting stars) by emulating reduced motion in devtools or the browser tool's equivalent.

- [ ] **Step 6: Commit**

```bash
git add src/components/landing/starfield.tsx src/components/landing/landing-page.tsx
git commit -m "feat: upgrade starfield motion and apply page background gradient"
```

---

### Task 3: `LandingFeatures` hi-fi rewrite

**Files:**
- Modify: `src/components/landing/landing-features.tsx` (full rewrite)

**Interfaces:**
- Produces: `LandingFeatures(): JSX.Element` — no props (unchanged signature).
- Depends on: `.landing-glass`, `landing-accent` token from Task 1.

- [ ] **Step 1: Rewrite the component**

```tsx
const FEATURES = [
  {
    kicker: "01 — Automatic",
    title: "Unified contacts",
    body: "LinkedIn and Apollo enrichment merge into a single contact record. Titles, employers and emails arrive already filled in — there is no form for you to keep feeding.",
  },
  {
    kicker: "02 — Assembled for you",
    title: "Targeted outreach",
    body: "Name an employer and Orbit builds the list. Demo results while you explore, live Apollo results the moment you're ready to send.",
  },
  {
    kicker: "03 — Learned over time",
    title: "Reply-rate optimization",
    body: "Orbit reads what comes back and surfaces what's working, so the next message is shorter, better aimed, and one of fewer.",
  },
] as const;

function ContactsVisual() {
  return (
    <div className="relative h-[200px] w-full" aria-hidden="true">
      <div className="absolute left-0 top-3.5 w-[154px] -rotate-6 rounded-2xl border border-[#e8f3f1]/10 bg-[#05070f]/70 px-3.5 py-3">
        <p className="text-[11px] uppercase tracking-wide text-[#6d807c]">LinkedIn</p>
        <p className="mt-1.5 text-sm text-[#e8f3f1]">Priya Raman</p>
        <p className="text-xs text-[#9aada8]">Head of Growth</p>
      </div>
      <div className="absolute left-11 top-[104px] w-[154px] rotate-3 rounded-2xl border border-[#e8f3f1]/10 bg-[#05070f]/70 px-3.5 py-3">
        <p className="text-[11px] uppercase tracking-wide text-[#6d807c]">Apollo</p>
        <p className="mt-1.5 text-sm text-[#e8f3f1]">priya@northwind.io</p>
        <p className="text-xs text-[#9aada8]">Northwind · 240 emp.</p>
      </div>
      <div className="absolute right-0 top-11 w-[190px] rounded-2xl border border-[#f2c14e]/35 bg-[#f2c14e]/[0.07] p-4 shadow-[0_0_40px_rgba(242,193,78,0.14)]">
        <div className="h-[30px] w-[30px] rounded-full bg-[#e8f3f1]/15" />
        <p className="mt-2 text-sm text-[#e8f3f1]">Priya Raman</p>
        <p className="text-xs text-[#9aada8]">Northwind</p>
        <p className="mt-2 text-[11px] uppercase tracking-wide text-landing-accent">One record</p>
      </div>
    </div>
  );
}

function OutreachVisual() {
  return (
    <div className="w-full" aria-hidden="true">
      <div className="flex items-center gap-2.5 rounded-xl border border-[#e8f3f1]/[0.12] bg-[#05070f]/60 px-4 py-3">
        <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-[#9aada8]" />
        <p className="text-sm">
          <span className="text-[#9aada8]">employer: </span>
          <span className="text-[#e8f3f1]">Northwind</span>
        </p>
        <span className="ml-auto rounded-full border border-[#f2c14e]/40 px-2 py-0.5 text-[11px] text-landing-accent">
          Live
        </span>
      </div>
      <div className="mt-3 space-y-2.5">
        {[100, 100, 50].map((opacity, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-xl bg-[#e8f3f1]/[0.035] px-3.5 py-3"
            style={{ opacity: opacity / 100 }}
          >
            <span className="h-6 w-6 shrink-0 rounded-full bg-[#e8f3f1]/10" />
            <div className="flex-1 space-y-1.5">
              <div className="h-2 rounded-full bg-[#e8f3f1]/10" style={{ width: "50%" }} />
              <div className="h-2 rounded-full bg-[#e8f3f1]/10" style={{ width: "38%" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReplyRateVisual() {
  const bars = [
    { h: 26, color: "rgba(232,243,241,0.12)" },
    { h: 38, color: "rgba(232,243,241,0.14)" },
    { h: 34, color: "rgba(232,243,241,0.12)" },
    { h: 56, color: "rgba(242,193,78,0.30)" },
    { h: 72, color: "rgba(242,193,78,0.45)" },
    { h: 96, color: "#f2c14e" },
  ];
  return (
    <div className="flex h-[170px] w-full items-end gap-2.5" aria-hidden="true">
      {bars.map((bar, i) => (
        <div
          key={i}
          className="flex-1 rounded-t-lg rounded-b-[3px]"
          style={{
            height: `${bar.h}%`,
            background: bar.color,
            boxShadow: i === bars.length - 1 ? "0 0 30px rgba(242,193,78,0.35)" : undefined,
          }}
        />
      ))}
    </div>
  );
}

const VISUALS = [ContactsVisual, OutreachVisual, ReplyRateVisual];

export function LandingFeatures() {
  return (
    <section className="landing-reveal relative z-10 mx-auto w-full max-w-6xl border-t border-[#e8f3f1]/[0.07] px-6 py-20 md:px-10 md:py-24">
      <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">What Orbit does</p>
      <h2 className="mt-3 max-w-[16ch] font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,50px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]">
        It keeps itself up to date.
      </h2>

      <div className="mt-12 flex flex-col gap-7">
        {FEATURES.map((feature, index) => {
          const Visual = VISUALS[index];
          const reversed = index === 1;
          return (
            <div
              key={feature.title}
              className="landing-glass grid items-center gap-9 rounded-3xl p-7 sm:p-10 lg:grid-cols-2"
            >
              <div className={reversed ? "lg:order-2" : undefined}>
                <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">{feature.kicker}</p>
                <h3 className="mt-3 font-[family-name:var(--font-display)] text-[clamp(24px,2.8vw,32px)] font-normal tracking-tight text-[#e8f3f1]">
                  {feature.title}
                </h3>
                <p className="mt-3 max-w-[44ch] text-base leading-[1.7] text-[#9aada8]">{feature.body}</p>
              </div>
              <div className={reversed ? "lg:order-1" : undefined}>
                <Visual />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: No composition change needed**

`landing-page.tsx` already renders `<LandingFeatures />` in the right position (from the prior plan) — this task only changes the component's internals, not its usage.

- [ ] **Step 3: Manual verification**

Run `npm run dev`, open `http://localhost:3000`, scroll to the features section. Confirm: three glass cards render with distinct mini-visuals (overlapping LinkedIn/Apollo/merged cards; search bar + skeleton rows; six ascending bars), card 2's visual is on the left / copy on the right at `lg`+ widths, and everything stacks to one column below `lg`. Check no horizontal overflow at 375px width.

- [ ] **Step 4: Commit**

```bash
git add src/components/landing/landing-features.tsx
git commit -m "feat: rewrite landing features section with hi-fi per-card visuals"
```

---

### Task 4: `LandingHowItWorks` orbit-map rewrite (client component)

**Files:**
- Modify: `src/components/landing/landing-how-it-works.tsx` (full rewrite, becomes `"use client"`)

**Interfaces:**
- Produces: `LandingHowItWorks(): JSX.Element` — no props (unchanged signature), but now a client component.

- [ ] **Step 1: Rewrite the component**

```tsx
"use client";

import { useEffect, useRef } from "react";

const STEPS = [
  {
    kicker: "Step 01 · you",
    title: "Connect",
    body: "Link LinkedIn and Apollo once.",
    dot: "#e8f3f1",
    glow: "0 0 20px rgba(232,243,241,.7)",
  },
  {
    kicker: "Step 02 · automatic",
    title: "Contacts populate",
    body: "Records fill in and enrich themselves.",
    dot: "#f2c14e",
    glow: "none",
  },
  {
    kicker: "Step 03 · you",
    title: "Send outreach",
    body: "Target by employer, send from Orbit.",
    dot: "#f2c14e",
    glow: "none",
  },
  {
    kicker: "Step 04 · automatic",
    title: "Replies come back",
    body: "Orbit tracks them and resurfaces who's due.",
    dot: "#9aada8",
    glow: "none",
  },
] as const;

// 12 / 3 / 6 / 9 o'clock, matching STEPS in order.
const NODE_POSITIONS = [
  { top: "0%", left: "50%" },
  { top: "50%", left: "100%" },
  { top: "100%", left: "50%" },
  { top: "50%", left: "0%" },
] as const;

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LandingHowItWorks() {
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prefersReducedMotion()) return;

    const ring = ringRef.current;
    if (!ring) return;

    let raf = 0;

    function onScroll() {
      raf = requestAnimationFrame(() => {
        const rect = ring!.getBoundingClientRect();
        const p =
          (window.innerHeight - rect.top) / (window.innerHeight + rect.height);
        const clamped = Math.min(Math.max(p, 0), 1);
        const rotation = clamped * 34 - 17;
        ring!.style.setProperty("--ring-rotation", String(rotation));
      });
    }

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section className="landing-reveal relative z-10 mx-auto w-full max-w-6xl border-t border-[#e8f3f1]/[0.07] px-6 py-20 md:px-10 md:py-24">
      <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">How it works</p>
      <h2 className="mt-3 max-w-[18ch] font-[family-name:var(--font-display)] text-[clamp(30px,4.4vw,50px)] font-normal leading-[1.15] tracking-[-0.025em] text-[#e8f3f1]">
        Four steps, three of which run without you.
      </h2>

      <div
        ref={ringRef}
        className="relative mx-auto mt-16 aspect-square w-full max-w-[760px]"
        style={{
          transform: "rotate(calc(var(--ring-rotation, 0) * 1deg))",
          transition: "transform .18s linear",
        }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-[6%] rounded-full border border-dashed border-[#e8f3f1]/[0.13]"
        />
        <div
          aria-hidden="true"
          className="absolute inset-[24%] rounded-full border border-[#e8f3f1]/[0.07]"
        />
        <div
          aria-hidden="true"
          className="absolute inset-[34%] rounded-full"
          style={{ background: "radial-gradient(circle, rgba(242,193,78,.16), transparent 70%)" }}
        />

        <div
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 h-[78px] w-[78px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(circle at 46% 42%, #fffdf2 6%, #ffe89a 34%, #f5c451 62%, #eba92c 100%)",
            boxShadow: "0 0 60px 14px rgba(245,196,81,0.35)",
          }}
        />
        <div
          data-counter-rotate
          className="absolute left-1/2 top-1/2 mt-14 -translate-x-1/2 translate-y-1/2 text-center"
          style={{ transform: "translate(-50%, 55px) rotate(calc(var(--ring-rotation, 0) * -1deg))" }}
        >
          <p className="font-[family-name:var(--font-display)] text-[19px] text-[#e8f3f1]">Orbit</p>
          <p className="text-xs text-[#6d807c]">the record keeps itself</p>
        </div>

        {STEPS.map((step, index) => (
          <div
            key={step.title}
            data-counter-rotate
            className="absolute w-[42%] max-w-[230px] text-center"
            style={{
              top: NODE_POSITIONS[index].top,
              left: NODE_POSITIONS[index].left,
              transform: "translate(-50%, -50%) rotate(calc(var(--ring-rotation, 0) * -1deg))",
            }}
          >
            <span
              aria-hidden="true"
              className="mx-auto block h-3 w-3 rounded-full"
              style={{ background: step.dot, boxShadow: step.glow }}
            />
            <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-[#6d807c]">{step.kicker}</p>
            <p className="mt-1 font-[family-name:var(--font-display)] text-[19px] text-[#e8f3f1]">{step.title}</p>
            <p className="mt-1 text-[13px] leading-[1.6] text-[#9aada8]">{step.body}</p>
          </div>
        ))}
      </div>

      <p className="mt-8 text-center text-sm text-[#6d807c]">
        The loop keeps running whether or not you open the app.
      </p>
    </section>
  );
}
```

Note on the "Orbit" label under the sun: it's positioned just below the 78px sun circle (`mt-14` context nudged via the inline `translate(-50%, 55px)`) rather than literally centered inside it, so the sun's glow isn't covered by text — this is a reasonable reading of "centered: a 78px sun ... with Orbit ... beneath". If a reviewer or the user wants it literally overlapping the sun, that's a one-line `style` tweak, not a structural change.

- [ ] **Step 2: Manual verification**

Run `npm run dev`, open `http://localhost:3000` at ≥1024px width, scroll to "How it works". Confirm: dashed + solid rings render, gold glow visible at center, sun renders with "Orbit" label beneath it, 4 step nodes sit at top/right/bottom/left. Scroll the page up and down past this section and confirm the ring visibly rotates a few degrees each way (use `get_page_text`/`read_page` plus a screenshot if the browser tool is working, or describe the computed `transform` via `javascript_tool` if screenshots are unreliable). Enable reduced-motion emulation and confirm the ring does NOT rotate.

- [ ] **Step 3: Commit**

```bash
git add src/components/landing/landing-how-it-works.tsx
git commit -m "feat: rewrite how-it-works as scroll-rotating orbit map"
```

---

### Task 5: `LandingProof` rewrite with real stat

**Files:**
- Modify: `src/components/landing/landing-proof.tsx` (full rewrite)

**Interfaces:**
- Produces: `LandingProof(): JSX.Element` — no props (unchanged signature).

- [ ] **Step 1: Rewrite the component**

```tsx
export function LandingProof() {
  return (
    <section className="landing-reveal relative z-10 mx-auto w-full max-w-6xl border-t border-[#e8f3f1]/[0.07] px-6 py-20 md:px-10 md:py-24">
      <p className="text-xs uppercase tracking-[0.18em] text-[#6d807c]">Why it exists</p>

      <div className="mt-10 grid items-center gap-10 lg:grid-cols-2">
        <div>
          <p className="max-w-[22ch] font-[family-name:var(--font-display)] text-[clamp(26px,3.6vw,40px)] font-light leading-[1.3] text-[#e8f3f1]">
            Orbit was built by one person who was tired of losing track of people.
          </p>
          <p className="mt-6 max-w-[46ch] text-base leading-[1.75] text-[#9aada8]">
            It started as a personal fix: a contact list that updated itself,
            remembered the last conversation, and said who was overdue.
            Everything here is the version I use every day.
          </p>
          <div className="mt-7 flex items-center gap-3">
            <span className="h-[34px] w-[34px] shrink-0 rounded-full bg-[#e8f3f1]/15" />
            <div className="min-w-max">
              <p className="text-sm text-[#e8f3f1]">Jason Pereira</p>
              <p className="whitespace-nowrap text-xs text-[#6d807c]">Building Orbit solo</p>
            </div>
          </div>
        </div>

        <div className="landing-glass rounded-3xl p-8 sm:p-10">
          <p className="font-[family-name:var(--font-display)] text-[clamp(52px,8vw,80px)] font-light leading-none text-landing-accent">
            2.4×
          </p>
          <p className="mt-4 text-base leading-[1.7] text-[#e8f3f1]">
            reply rate on outreach sent through Orbit versus the same lists sent manually.
          </p>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Manual verification**

Run `npm run dev`, open `http://localhost:3000`, scroll to the proof section. Confirm the 2-column layout (pull quote + founder credit on the left, `2.4×` stat panel on the right), collapsing to one column below `lg`. Confirm the founder credit block never wraps (`Jason Pereira` / `Building Orbit solo` stay on one line each even at narrow widths).

- [ ] **Step 3: Commit**

```bash
git add src/components/landing/landing-proof.tsx
git commit -m "feat: rewrite social proof section with founder note and real reply-rate stat"
```

---

### Task 6: `LandingWaitlist` + `WaitlistForm` (replaces `LandingPricingCta`, wires Clerk waitlist)

**Files:**
- Create: `src/components/landing/waitlist-form.tsx`
- Create: `src/components/landing/landing-waitlist.tsx`
- Delete: `src/components/landing/landing-pricing-cta.tsx`
- Modify: `src/components/landing/landing-page.tsx`

**Interfaces:**
- Produces: `WaitlistForm({ clerkOn, demoMode }: { clerkOn: boolean; demoMode?: boolean }): JSX.Element` — client component.
- Produces: `LandingWaitlist({ clerkOn, demoMode }: { clerkOn: boolean; demoMode?: boolean }): JSX.Element`.
- Consumes: `useClerk` from `@clerk/nextjs` (confirmed exported, along with a `joinWaitlist({ emailAddress }): Promise<WaitlistResource>` method on the returned Clerk instance — see `node_modules/@clerk/shared/dist/types/clerk.d.ts`).

**Important — read before coding:**
- `useClerk()` (and any other Clerk hook) throws if called outside a mounted `<ClerkProvider>`. Per `src/components/auth-provider.tsx`, `ClerkProvider` is ONLY mounted when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is set — i.e., exactly when `clerkOn` is true. So the Clerk-hook-using code must never be reached when `clerkOn` is false: gate on `clerkOn` at the point where you choose which subcomponent to render, not with a conditional hook call inside one component (conditional hooks are illegal regardless of the runtime value).
- `joinWaitlist({ emailAddress })` requires the Clerk Dashboard's sign-up mode to be set to **Waitlist** — that's an external Clerk Dashboard configuration, not something this code can set. Assume it's configured; if the call fails in practice because it isn't, that will surface as a runtime API error the form's error state already handles.
- In demo mode (`clerkOn` false), there is no real waitlist to join — show a simple, honest fallback instead of a broken Clerk call.

- [ ] **Step 1: Write `WaitlistForm`**

```tsx
// src/components/landing/waitlist-form.tsx
"use client";

import { useState } from "react";
import { useClerk } from "@clerk/nextjs";

const inputClass =
  "w-full rounded-xl border border-[#e8f3f1]/[0.14] bg-[#05070f]/50 px-4.5 py-3.5 text-[#e8f3f1] placeholder:text-[#6d807c] focus:border-[#f2c14e]/50 focus:outline-none";

const buttonClass =
  "w-full whitespace-nowrap rounded-xl bg-landing-button-surface px-4.5 py-3.5 font-medium text-landing-button-label transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

function ClerkWaitlistForm() {
  const clerk = useClerk();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setStatus("loading");
    try {
      await clerk.joinWaitlist({ emailAddress: email });
      setStatus("success");
    } catch {
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <p className="text-sm text-[#e8f3f1]">
        You&apos;re on the list — we&apos;ll email you as spots open.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <label htmlFor="waitlist-email" className="sr-only">
        Email address
      </label>
      <input
        id="waitlist-email"
        type="email"
        required
        placeholder="you@company.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className={inputClass}
      />
      <button type="submit" disabled={status === "loading"} className={buttonClass}>
        {status === "loading" ? "Joining…" : "Join the waitlist"}
      </button>
      {status === "error" && (
        <p className="text-sm text-[#e8a84e]">
          Something went wrong — please try again.
        </p>
      )}
    </form>
  );
}

function DemoWaitlistForm() {
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return (
      <p className="text-sm text-[#e8f3f1]">
        Thanks! (Demo mode — no real waitlist entry was created.)
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
      }}
      className="space-y-3"
    >
      <label htmlFor="waitlist-email-demo" className="sr-only">
        Email address
      </label>
      <input
        id="waitlist-email-demo"
        type="email"
        required
        placeholder="you@company.com"
        className={inputClass}
      />
      <button type="submit" className={buttonClass}>
        Join the waitlist
      </button>
    </form>
  );
}

export function WaitlistForm({ clerkOn }: { clerkOn: boolean; demoMode?: boolean }) {
  return clerkOn ? <ClerkWaitlistForm /> : <DemoWaitlistForm />;
}
```

- [ ] **Step 2: Write `LandingWaitlist`**

```tsx
// src/components/landing/landing-waitlist.tsx
import { WaitlistForm } from "@/components/landing/waitlist-form";

export function LandingWaitlist({
  clerkOn,
  demoMode = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
}) {
  return (
    <section className="landing-reveal relative z-10 mx-auto w-full max-w-6xl overflow-hidden border-t border-[#e8f3f1]/[0.07] px-6 py-20 md:px-10 md:py-24">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-[-420px] left-1/2 h-[900px] w-[900px] -translate-x-1/2 rounded-full"
        style={{ background: "radial-gradient(circle, rgba(242,193,78,0.14), transparent 62%)" }}
      />

      <div className="relative grid items-center gap-11 lg:grid-cols-2">
        <div>
          <h2 className="max-w-[14ch] font-[family-name:var(--font-display)] text-[clamp(34px,5.2vw,58px)] font-normal leading-[1.1] tracking-[-0.03em] text-[#e8f3f1]">
            Keep every connection in orbit.
          </h2>
          <p className="mt-5 max-w-[40ch] text-base leading-[1.7] text-[#9aada8] sm:text-lg">
            Early access is free. There is nothing to import and nothing to maintain.
          </p>
        </div>

        <div className="landing-glass rounded-3xl p-8">
          <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">Waitlist</p>
          <p className="mt-2 text-base text-[#e8f3f1]">Join and you&apos;ll get in as spots open.</p>
          <div className="mt-5">
            <WaitlistForm clerkOn={clerkOn} demoMode={demoMode} />
          </div>
          <p className="mt-4 text-xs text-[#6d807c]">No credit card. No setup.</p>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Delete `landing-pricing-cta.tsx` and wire `LandingWaitlist` into `landing-page.tsx`**

Delete `src/components/landing/landing-pricing-cta.tsx`.

In `src/components/landing/landing-page.tsx`, replace the `LandingPricingCta` import and usage with `LandingWaitlist`:

```tsx
import { LandingWaitlist } from "@/components/landing/landing-waitlist";
```

```tsx
        <LandingWaitlist clerkOn={clerkOn} demoMode={demoMode} />
```

(Same position in the `<main>` composition that `LandingPricingCta` occupied — last section before `</main>`.)

- [ ] **Step 4: Manual verification**

Run `npm run dev`. In demo mode (`clerkOn=false`, the default for a keyless worktree dev server), submit the waitlist form and confirm the demo success message appears, no console errors, no Clerk-hook crash. If you have Clerk keys available to test the `clerkOn=true` path, confirm the form calls `joinWaitlist` and shows either the success or error state appropriately; if not, at minimum confirm `ClerkWaitlistForm` type-checks and the conditional rendering in `WaitlistForm` never reaches the Clerk hook when `clerkOn` is false (grep the demo-mode HTML response for absence of any Clerk-related error).

- [ ] **Step 5: Commit**

```bash
git add src/components/landing/waitlist-form.tsx src/components/landing/landing-waitlist.tsx src/components/landing/landing-page.tsx
git rm src/components/landing/landing-pricing-cta.tsx
git commit -m "feat: replace pricing CTA with Clerk-backed waitlist section"
```

---

### Task 7: Footer rewrite + Terms/Contact stub pages

**Files:**
- Modify: `src/components/landing/landing-footer.tsx` (full rewrite)
- Create: `src/app/(marketing)/terms/page.tsx`
- Create: `src/app/(marketing)/contact/page.tsx`

**Interfaces:**
- Produces: `LandingFooter(): JSX.Element` — no props (unchanged signature).
- Produces: default-exported page components at `/terms` and `/contact`.

- [ ] **Step 1: Rewrite `LandingFooter`**

```tsx
// src/components/landing/landing-footer.tsx
import Link from "next/link";
import type { JSX } from "react";
import { OrbitLogo } from "@/components/orbit-logo";

const NAV_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/contact", label: "Contact" },
] as const;

export function LandingFooter(): JSX.Element {
  return (
    <footer className="relative z-10 mx-auto flex w-full max-w-6xl flex-wrap items-start justify-between gap-8 border-t border-[#e8f3f1]/[0.07] px-6 py-10 md:px-10 md:py-11">
      <Link href="/" className="flex items-center gap-2.5" aria-label="Orbit home">
        <OrbitLogo size="sm" />
        <span className="font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1]">
          Orbit
        </span>
      </Link>

      <nav className="flex gap-6 text-sm">
        {NAV_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="text-[#9aada8] transition-colors hover:text-[#e8f3f1]"
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <a
        href="https://jasonpereira.live/"
        target="_blank"
        rel="noopener noreferrer"
        className="landing-credit-shimmer text-sm text-[#6d807c]"
      >
        By Jason Pereira
      </a>
    </footer>
  );
}
```

- [ ] **Step 2: Create the Terms stub page**

Model this on `src/app/(marketing)/privacy/page.tsx`'s structure (same header, same `<main>`/`<article>` shell, same `Section` helper pattern), but with placeholder terms-of-service content — this is a stub, not a legal document, so keep it short and clearly provisional:

```tsx
// src/app/(marketing)/terms/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { OrbitLogo } from "@/components/orbit-logo";

export const metadata: Metadata = {
  title: "Terms of Service — Orbit",
  description: "Terms governing use of Orbit, a personal networking tracker.",
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-5 md:px-8">
        <Link href="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-80">
          <OrbitLogo size="sm" />
          <span className="font-[family-name:var(--font-display)] text-xl tracking-tight text-primary">
            Orbit
          </span>
        </Link>
        <Link
          href="/sign-in"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Sign in
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl px-6 pb-16 md:px-8">
        <article className="space-y-6">
          <header className="space-y-3">
            <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-primary sm:text-5xl">
              Terms of Service
            </h1>
            <p className="text-base leading-relaxed text-muted-foreground">
              Orbit is an early-stage, solo-built product. Formal terms of
              service are being finalized. By using Orbit today, you agree to
              use it in good faith and understand it is under active
              development. Questions can be directed to the contact page.
            </p>
          </header>
        </article>

        <p className="mt-12 text-sm text-muted-foreground">
          <Link href="/" className="text-primary underline-offset-4 hover:underline">
            Back to home
          </Link>
        </p>
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Create the Contact stub page**

```tsx
// src/app/(marketing)/contact/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { OrbitLogo } from "@/components/orbit-logo";

export const metadata: Metadata = {
  title: "Contact — Orbit",
  description: "Get in touch about Orbit, a personal networking tracker.",
};

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-5 md:px-8">
        <Link href="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-80">
          <OrbitLogo size="sm" />
          <span className="font-[family-name:var(--font-display)] text-xl tracking-tight text-primary">
            Orbit
          </span>
        </Link>
        <Link
          href="/sign-in"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Sign in
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl px-6 pb-16 md:px-8">
        <article className="space-y-6">
          <header className="space-y-3">
            <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight text-primary sm:text-5xl">
              Contact
            </h1>
            <p className="text-base leading-relaxed text-muted-foreground">
              Orbit is built and run by one person. The fastest way to reach
              out is via{" "}
              <a
                href="https://jasonpereira.live/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline-offset-4 hover:underline"
              >
                jasonpereira.live
              </a>
              .
            </p>
          </header>
        </article>

        <p className="mt-12 text-sm text-muted-foreground">
          <Link href="/" className="text-primary underline-offset-4 hover:underline">
            Back to home
          </Link>
        </p>
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Manual verification**

Run `npm run dev`. Confirm `/terms` and `/contact` both render with no errors. On `/`, confirm the footer shows all three groups (logo+wordmark, Privacy/Terms/Contact nav, credit link) and that all three nav links navigate correctly.

- [ ] **Step 5: Commit**

```bash
git add src/components/landing/landing-footer.tsx "src/app/(marketing)/terms/page.tsx" "src/app/(marketing)/contact/page.tsx"
git commit -m "feat: rewrite landing footer with Terms/Contact links and stub pages"
```

---

## Self-Review Notes

- **Spec coverage:** every numbered section of the source spec (Features, How it works, Proof, Waitlist+Footer) has a task; the "Motion" section is split across Task 1 (CSS primitives), Task 2 (starfield), and each content task applying `.landing-reveal`/scroll rotation where relevant; "Before you start" conflicts were already surfaced and resolved with the user in chat (starfield positioning, hero height) and are recorded in Global Constraints so no task re-derives them.
- **No placeholders:** all component code is complete; the only deliberately-left review note is the "Orbit" label position under the sun in Task 4 (a judgment call on ambiguous spec wording, not a missing implementation), and the `2.4×` stat is shipped as final copy per the user's confirmation.
- **Type consistency:** `clerkOn`/`demoMode` prop shapes match `LandingAuthControls`'s existing convention (`clerkOn: boolean; demoMode?: boolean`) across `LandingWaitlist` and `WaitlistForm`; `LandingPage`'s existing props are unchanged, so no cross-task signature drift.
