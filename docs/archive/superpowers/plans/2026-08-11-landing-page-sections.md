# Landing Page Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Orbit marketing landing page (currently hero-only) with four new sections below the hero — Features, How it works, Social proof, and Pricing + final CTA/footer — carrying the "effortless relationship management" message, in the existing dark-space/orbit visual language.

**Architecture:** Extract the current monolithic `LandingHero` into a page-level wrapper (`LandingPage`) that owns the shared starfield background and header, plus a slimmed-down `LandingHero` for just the hero content. Add four new section components as siblings, each self-contained, composed together in `LandingPage`. `src/app/(marketing)/page.tsx` renders `LandingPage` instead of `LandingHero` directly.

**Tech Stack:** Next.js App Router (server components by default), React, Tailwind CSS v4 (`@theme inline` tokens in `src/app/globals.css`), TypeScript strict mode.

## Global Constraints

- This repo's Next.js has breaking changes from stock Next.js per `AGENTS.md` — before writing any App Router code, skim `node_modules/next/dist/docs/` for anything relevant to Server/Client Components and layouts.
- No test framework is configured anywhere in this repo (confirmed: no jest/vitest config, no `*.test.tsx` files). Do not introduce one as a side effect of this plan. Verification is manual: run `npm run dev` and visually check `http://localhost:3000` after each task.
- Package manager is npm (`package-lock.json` present) — use `npm run dev` / `npm run build`.
- TypeScript is `strict: true` — all new components must be fully typed, no `any`.
- Fonts: use the existing convention from `landing-hero.tsx` — `font-[family-name:var(--font-display)]` for display/headline text (Fraunces), default body font (Outfit, `--font-sans`) otherwise. Do not switch to the `--font-heading` theme token; match the existing hardcoded-var pattern already used in this page.
- Palette: reuse the exact hex values already used in `landing-hero.tsx` (`#05070f` background, `#e8f3f1` primary text, `#9aada8` muted text, `#6d807c` dim text) rather than the generic `--color-*` theme tokens — the landing page is intentionally visually independent from the app's light theme.
- Respect `prefers-reduced-motion` for any animation, following the existing pattern in `hero-solar-system.tsx`/`starfield.tsx` (`usePrefersReducedMotion` from `@/components/onboarding/use-prefers-reduced-motion`) and the `motion-reduce:` Tailwind variant used in `landing-hero.tsx`.
- No fabricated testimonials, customer logos, or invented usage statistics. The social-proof section must use only real, honest content — placeholder stat callouts must be clearly marked `[CONFIRM]` in code comments so they aren't shipped un-reviewed.
- All new files live in `src/components/landing/`, matching the existing flat structure of that directory.
- Reuse existing primitives instead of inventing new ones: `cn` from `@/lib/utils`, `OrbitLogo` from `@/components/orbit-logo`, `LandingSolarSystem`/`LandingStarfield` from `@/components/landing/landing-visuals`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/components/landing/landing-header.tsx` (new) | Sticky/top header: logo + wordmark + `LandingAuthControls variant="header"`. Extracted from `landing-hero.tsx`. |
| `src/components/landing/landing-hero.tsx` (modified) | Slimmed to just the hero `<section>`: headline, tagline, hero CTAs, solar-system visual. Loses the outer page wrapper, starfield, header, and footer links it currently owns. |
| `src/components/landing/landing-features.tsx` (new) | "Features" section — 3 feature cards. |
| `src/components/landing/landing-how-it-works.tsx` (new) | "How it works" section — 4-step orbit-diagram visual. |
| `src/components/landing/landing-proof.tsx` (new) | "Social proof / results" section — single honest proof statement, no fake testimonials. |
| `src/components/landing/landing-pricing-cta.tsx` (new) | "Pricing + final CTA" section, plus the real `<footer>` (Privacy + credit links, replacing the two absolutely-positioned links removed from `landing-hero.tsx`). |
| `src/components/landing/landing-page.tsx` (new) | Top-level composition: owns the full-page wrapper + `LandingStarfield` background, renders `LandingHeader`, `LandingHero`, `LandingFeatures`, `LandingHowItWorks`, `LandingProof`, `LandingPricingCta` in order. |
| `src/app/(marketing)/page.tsx` (modified) | Renders `<LandingPage clerkOn={...} demoMode={...} />` instead of `<LandingHero ... />`. |

---

### Task 1: Extract header + slim hero + page wrapper (foundation)

This task must land first — every later task inserts a section into `LandingPage`, which this task creates.

**Files:**
- Create: `src/components/landing/landing-header.tsx`
- Create: `src/components/landing/landing-page.tsx`
- Modify: `src/components/landing/landing-hero.tsx` (full rewrite)
- Modify: `src/app/(marketing)/page.tsx`

**Interfaces:**
- Produces: `LandingHeader({ clerkOn: boolean; demoMode: boolean }): JSX.Element`
- Produces: `LandingHero({ clerkOn: boolean; demoMode: boolean }): JSX.Element` — now renders only the hero `<section>`, no wrapping `<div>`/starfield/header/footer.
- Produces: `LandingPage({ clerkOn: boolean; demoMode?: boolean }): JSX.Element` — the full page.
- Consumes (existing, unchanged): `LandingAuthControls({ clerkOn, demoMode, variant }` from `@/components/landing/landing-auth-controls`; `LandingSolarSystem`, `LandingStarfield` from `@/components/landing/landing-visuals`; `OrbitLogo` from `@/components/orbit-logo`; `cn` from `@/lib/utils`.

- [ ] **Step 1: Skim Next.js docs for this repo's App Router conventions**

Run: `ls node_modules/next/dist/docs/` and read anything about Server/Client Components, layouts, or route groups that looks non-standard. Note anything that changes how `page.tsx` should compose child components before proceeding.

- [ ] **Step 2: Create `LandingHeader`**

```tsx
// src/components/landing/landing-header.tsx
import Link from "next/link";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { OrbitLogo } from "@/components/orbit-logo";

export function LandingHeader({
  clerkOn,
  demoMode = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
}) {
  return (
    <header className="relative z-10 flex items-center justify-between px-6 py-5 md:px-10">
      <Link href="/" className="flex items-center gap-2.5" aria-label="Orbit home">
        <OrbitLogo size="md" priority />
        <span className="font-[family-name:var(--font-display)] text-xl tracking-tight text-[#e8f3f1]">
          Orbit
        </span>
      </Link>
      <LandingAuthControls clerkOn={clerkOn} demoMode={demoMode} variant="header" />
    </header>
  );
}
```

- [ ] **Step 3: Slim `LandingHero` to just the hero section**

Replace the full file contents of `src/components/landing/landing-hero.tsx`:

```tsx
// src/components/landing/landing-hero.tsx
import { cn } from "@/lib/utils";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";
import { LandingSolarSystem } from "@/components/landing/landing-visuals";

export function LandingHero({
  clerkOn,
  demoMode = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
}) {
  return (
    <section className="relative z-10 flex flex-1 flex-col justify-center px-6 pb-16 pt-4 md:px-10 md:pb-20">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-12">
        <div
          className={cn(
            "landing-fade max-w-3xl",
            "motion-reduce:opacity-100 motion-reduce:translate-y-0"
          )}
        >
          <p className="font-[family-name:var(--font-display)] text-6xl leading-[0.95] tracking-tight text-white sm:text-7xl md:text-8xl lg:text-[5.5rem] xl:text-9xl">
            Orbit
          </p>
          <h1 className="mt-6 max-w-xl font-[family-name:var(--font-display)] text-2xl leading-snug tracking-tight text-[#e8f3f1] sm:mt-8 sm:text-3xl md:text-4xl">
            Keep every connection in orbit.
          </h1>
          <p className="mt-4 max-w-md text-base leading-relaxed text-[#9aada8] sm:text-lg">
            Your people, your last conversation, your next follow-up — all in one place.
          </p>
          <div className="mt-8 sm:mt-10">
            <LandingAuthControls clerkOn={clerkOn} demoMode={demoMode} variant="hero" />
          </div>
        </div>

        <LandingSolarSystem className="w-full max-w-[min(100%,560px)] lg:max-w-[580px] lg:justify-self-end" />
      </div>
    </section>
  );
}
```

Note: the `Link`, `OrbitLogo`, and `LandingStarfield` imports are removed here — they now live in `LandingHeader`/`LandingPage`. The two absolutely-positioned footer links (`Privacy`, `By Jason Pereira`) are also removed here — they move to `LandingPricingCta` in Task 5.

- [ ] **Step 4: Create `LandingPage`**

```tsx
// src/components/landing/landing-page.tsx
import { LandingHeader } from "@/components/landing/landing-header";
import { LandingHero } from "@/components/landing/landing-hero";
import { LandingStarfield } from "@/components/landing/landing-visuals";

export function LandingPage({
  clerkOn,
  demoMode = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
}) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#05070f] text-[#e8f3f1]">
      <LandingStarfield />
      <LandingHeader clerkOn={clerkOn} demoMode={demoMode} />
      <LandingHero clerkOn={clerkOn} demoMode={demoMode} />
    </div>
  );
}
```

- [ ] **Step 5: Wire `page.tsx` to `LandingPage`**

Modify `src/app/(marketing)/page.tsx` to import and render `LandingPage` instead of `LandingHero` (keep whatever `clerkOn`/`demoMode` resolution logic already exists — only swap the rendered component and its import).

- [ ] **Step 6: Manual verification**

Run: `npm run dev`, open `http://localhost:3000` in a browser.
Expected: page looks pixel-identical to before this task — starfield, header, hero copy, solar system all render exactly as they did. No console errors. Resize to mobile width and confirm the header/hero still stack correctly.

- [ ] **Step 7: Commit**

```bash
git add src/components/landing/landing-header.tsx src/components/landing/landing-page.tsx src/components/landing/landing-hero.tsx "src/app/(marketing)/page.tsx"
git commit -m "refactor: extract landing header and page wrapper from hero"
```

---

### Task 2: Features section

**Files:**
- Create: `src/components/landing/landing-features.tsx`
- Modify: `src/components/landing/landing-page.tsx`

**Interfaces:**
- Produces: `LandingFeatures(): JSX.Element` — no props, self-contained static section.
- Consumes: nothing beyond `cn` from `@/lib/utils` (optional).

**Content (locked from prior planning — do not invent new copy):**

| Title | Body |
|---|---|
| Unified contacts | LinkedIn and Apollo enrichment merge into one contact record automatically — no manual data entry. |
| Targeted outreach | Search and target by employer, with demo vs. live Apollo results. |
| Reply-rate optimization | Orbit surfaces what's working in your outreach, so you send fewer, better messages. |

- [ ] **Step 1: Write `LandingFeatures`**

```tsx
// src/components/landing/landing-features.tsx
const FEATURES = [
  {
    title: "Unified contacts",
    body: "LinkedIn and Apollo enrichment merge into one contact record automatically — no manual data entry.",
  },
  {
    title: "Targeted outreach",
    body: "Search and target by employer, with demo vs. live Apollo results.",
  },
  {
    title: "Reply-rate optimization",
    body: "Orbit surfaces what's working in your outreach, so you send fewer, better messages.",
  },
] as const;

export function LandingFeatures() {
  return (
    <section className="relative z-10 px-6 py-20 md:px-10 md:py-28">
      <div className="mx-auto max-w-6xl">
        <h2 className="font-[family-name:var(--font-display)] max-w-xl text-3xl leading-tight tracking-tight text-[#e8f3f1] sm:text-4xl">
          Effortless, by design.
        </h2>
        <p className="mt-3 max-w-lg text-base leading-relaxed text-[#9aada8] sm:text-lg">
          Orbit does the upkeep so you don&apos;t have to.
        </p>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm transition-colors hover:border-white/20"
            >
              <h3 className="font-[family-name:var(--font-display)] text-lg tracking-tight text-[#e8f3f1]">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-[#9aada8]">
                {feature.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Insert into `LandingPage`**

Modify `src/components/landing/landing-page.tsx`: import `LandingFeatures` from `@/components/landing/landing-features` and render it directly after `<LandingHero ... />`.

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, open `http://localhost:3000`.
Expected: scrolling past the hero reveals the "Effortless, by design." section with 3 glass cards, single column on mobile, 2-up on `sm`, 3-up on `lg`. No layout overflow at 375px width.

- [ ] **Step 4: Commit**

```bash
git add src/components/landing/landing-features.tsx src/components/landing/landing-page.tsx
git commit -m "feat: add landing page features section"
```

---

### Task 3: How it works section

**Files:**
- Create: `src/components/landing/landing-how-it-works.tsx`
- Modify: `src/components/landing/landing-page.tsx`

**Interfaces:**
- Produces: `LandingHowItWorks(): JSX.Element` — no props.

**Content (locked):** 4 steps — Connect → Contacts populate & enrich automatically → Send targeted outreach → Orbit tracks replies and resurfaces who needs a follow-up.

Layout: on `lg`+ screens, render the 4 steps as nodes around a circular orbit path (SVG ring) with the wordmark at the center — continuing the orbit motif. On smaller screens, render the same 4 steps as a simple vertical stack (the circular layout doesn't reflow legibly below `lg`). Both layouts are always in the DOM; visibility is toggled with Tailwind's `lg:hidden` / `hidden lg:block` so there's no JS layout logic and no hydration mismatch risk.

- [ ] **Step 1: Write `LandingHowItWorks`**

```tsx
// src/components/landing/landing-how-it-works.tsx
const STEPS = [
  { title: "Connect", body: "Link your LinkedIn — Orbit reads your existing network." },
  { title: "Enrich", body: "Contacts populate and enrich automatically from LinkedIn and Apollo." },
  { title: "Reach out", body: "Send targeted outreach, filtered by employer." },
  { title: "Follow up", body: "Orbit tracks replies and resurfaces who needs a follow-up." },
] as const;

// Node positions around a circle of radius 42% centered at (50%, 50%),
// at 90°/0°/270°/180° (top, right, bottom, left).
const NODE_POSITIONS = [
  { top: "8%", left: "50%" },
  { top: "50%", left: "92%" },
  { top: "92%", left: "50%" },
  { top: "50%", left: "8%" },
] as const;

export function LandingHowItWorks() {
  return (
    <section className="relative z-10 px-6 py-20 md:px-10 md:py-28">
      <div className="mx-auto max-w-6xl">
        <h2 className="font-[family-name:var(--font-display)] max-w-xl text-3xl leading-tight tracking-tight text-[#e8f3f1] sm:text-4xl">
          How it works
        </h2>

        {/* Circular orbit layout — lg and up */}
        <div className="relative mx-auto mt-16 hidden aspect-square max-w-xl lg:block">
          <svg
            viewBox="0 0 100 100"
            className="absolute inset-0 h-full w-full text-white/10"
            aria-hidden="true"
          >
            <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="0.5" />
          </svg>

          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
            <p className="font-[family-name:var(--font-display)] text-2xl tracking-tight text-[#e8f3f1]">
              Orbit
            </p>
          </div>

          {STEPS.map((step, index) => (
            <div
              key={step.title}
              className="absolute w-48 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/10 bg-[#05070f]/90 p-4 text-center backdrop-blur-sm"
              style={{ top: NODE_POSITIONS[index].top, left: NODE_POSITIONS[index].left }}
            >
              <p className="text-xs font-medium uppercase tracking-wide text-[#6d807c]">
                {String(index + 1).padStart(2, "0")}
              </p>
              <p className="mt-1 font-[family-name:var(--font-display)] text-base text-[#e8f3f1]">
                {step.title}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-[#9aada8]">{step.body}</p>
            </div>
          ))}
        </div>

        {/* Vertical stack — below lg */}
        <ol className="mt-12 space-y-6 lg:hidden">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              <span className="font-[family-name:var(--font-display)] text-lg text-[#6d807c]">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <p className="font-[family-name:var(--font-display)] text-lg text-[#e8f3f1]">
                  {step.title}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-[#9aada8]">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Insert into `LandingPage`**

Modify `src/components/landing/landing-page.tsx`: import `LandingHowItWorks` and render it after `<LandingFeatures />`.

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, open `http://localhost:3000` at a `lg`+ width (≥1024px).
Expected: 4 step-cards arranged around a faint circular ring with "Orbit" centered. Shrink the window below 1024px and confirm it swaps to the numbered vertical list with no visual overlap or duplicate rendering.

- [ ] **Step 4: Commit**

```bash
git add src/components/landing/landing-how-it-works.tsx src/components/landing/landing-page.tsx
git commit -m "feat: add landing page how-it-works section"
```

---

### Task 4: Social proof section

**Files:**
- Create: `src/components/landing/landing-proof.tsx`
- Modify: `src/components/landing/landing-page.tsx`

**Interfaces:**
- Produces: `LandingProof(): JSX.Element` — no props.

**Content:** Orbit is solo-built and early-stage — this section must not contain fabricated testimonials, logos, or invented metrics. Use the honest founder-framing statement, with any numeric claim marked for confirmation before ship.

- [ ] **Step 1: Write `LandingProof`**

```tsx
// src/components/landing/landing-proof.tsx
export function LandingProof() {
  return (
    <section className="relative z-10 px-6 py-20 md:px-10 md:py-28">
      <div className="mx-auto max-w-3xl text-center">
        <p className="font-[family-name:var(--font-display)] text-2xl leading-snug tracking-tight text-[#e8f3f1] sm:text-3xl">
          Built by one person who was tired of losing track of people.
        </p>
        <p className="mt-4 text-base leading-relaxed text-[#9aada8] sm:text-lg">
          No sales team, no growth hacks — just a tool built to solve a real
          problem, refined by using it every day.
        </p>
        {/*
          [CONFIRM] If a real reply-rate or usage stat exists, replace the
          paragraph above (or add beneath it) with something like:
          "Orbit users see a {X}% higher reply rate on outreach." Do not
          ship a number here without the user confirming it's real.
        */}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Insert into `LandingPage`**

Modify `src/components/landing/landing-page.tsx`: import `LandingProof` and render it after `<LandingHowItWorks />`.

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, open `http://localhost:3000`.
Expected: centered single-statement section renders between "How it works" and (once Task 5 lands) pricing/CTA. Confirm with the user whether a real stat should be added per the `[CONFIRM]` comment before considering this section final.

- [ ] **Step 4: Commit**

```bash
git add src/components/landing/landing-proof.tsx src/components/landing/landing-page.tsx
git commit -m "feat: add landing page social proof section"
```

---

### Task 5: Pricing + final CTA + footer section

**Files:**
- Create: `src/components/landing/landing-pricing-cta.tsx`
- Modify: `src/components/landing/landing-page.tsx`

**Interfaces:**
- Produces: `LandingPricingCta({ clerkOn: boolean; demoMode: boolean }): JSX.Element`
- Consumes: `LandingAuthControls` from `@/components/landing/landing-auth-controls` (reuse `variant="hero"` for the final CTA buttons).

**Content:** free-to-start pricing framing, closing CTA restating "Keep every connection in orbit," and the real footer — replaces the two absolutely-positioned links (`Privacy`, `By Jason Pereira`) that were removed from `landing-hero.tsx` in Task 1.

- [ ] **Step 1: Write `LandingPricingCta`**

```tsx
// src/components/landing/landing-pricing-cta.tsx
import Link from "next/link";
import { LandingAuthControls } from "@/components/landing/landing-auth-controls";

export function LandingPricingCta({
  clerkOn,
  demoMode = false,
}: {
  clerkOn: boolean;
  demoMode?: boolean;
}) {
  return (
    <>
      <section className="relative z-10 px-6 py-20 md:px-10 md:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-medium uppercase tracking-wide text-[#6d807c]">
            Pricing
          </p>
          <h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl leading-tight tracking-tight text-[#e8f3f1] sm:text-4xl">
            Free to start. No setup required.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-[#9aada8] sm:text-lg">
            Keep every connection in orbit.
          </p>
          <div className="mt-8 flex justify-center">
            <LandingAuthControls clerkOn={clerkOn} demoMode={demoMode} variant="hero" />
          </div>
        </div>
      </section>

      <footer className="relative z-10 flex flex-col items-center gap-2 border-t border-white/10 px-6 py-8 text-sm text-[#6d807c] sm:flex-row sm:justify-between md:px-10">
        <Link href="/privacy" className="transition-colors hover:text-[#e8f3f1]">
          Privacy
        </Link>
        <a
          href="https://jasonpereira.live/"
          target="_blank"
          rel="noopener noreferrer"
          className="landing-credit-shimmer"
        >
          By Jason Pereira
        </a>
      </footer>
    </>
  );
}
```

- [ ] **Step 2: Insert into `LandingPage`**

Modify `src/components/landing/landing-page.tsx`: import `LandingPricingCta` and render it as the last child, after `<LandingProof />`, passing `clerkOn`/`demoMode` through.

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, open `http://localhost:3000`.
Expected: page ends with pricing/CTA section then a real `<footer>` with working "Privacy" and "By Jason Pereira" links, styled consistently with the rest of the page. Confirm the old absolutely-positioned footer links from the original hero no longer appear (they were removed in Task 1 and are only in this footer now). Click through the full page top-to-bottom once to confirm section order: Hero → Features → How it works → Social proof → Pricing/CTA → Footer.

- [ ] **Step 4: Commit**

```bash
git add src/components/landing/landing-pricing-cta.tsx src/components/landing/landing-page.tsx
git commit -m "feat: add landing page pricing, final CTA, and footer"
```

---

## Self-Review Notes

- **Spec coverage:** All four sections from the approved design prompt (Features, How it works, Social proof, Pricing + final CTA/footer) have a task each; the foundational refactor (Task 1) is required infrastructure not in the original spec but necessary to compose them without duplicating the starfield/header.
- **No placeholders:** All component code is complete and copy-pasteable; the only intentionally-flagged placeholder is the `[CONFIRM]` comment in `LandingProof` for a real stat, which is a content decision reserved for the user, not a missing implementation.
- **Type consistency:** `clerkOn`/`demoMode` prop names and types match `LandingAuthControls`'s existing signature across every task; `LandingPage`'s props match what `page.tsx` will pass.
