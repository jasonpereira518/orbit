# Accessibility, Responsive & Cross-Browser Audit

**Scope:** every routed page in `src/app` (42 product and marketing routes, 26 admin routes), with WCAG 2.2 AA as the target.
**Status:** fixes implemented after approval. See [§8](#8-scores-before-and-after) for before/after scores and [§9](#9-what-changed) for what changed, what departed from the plan, and what was deferred. §1–§7 are the original audit, unchanged.
**Date:** 2026-10-17, audited at `eb5d69d` on `main`.

---

## 1. Summary

Orbit already has a solid accessibility foundation:
- Overlays are built on Base UI, so they trap focus and handle Escape.
- Reduced motion is handled at almost every animation site.
- Icon buttons are almost all labelled.
- Tables are wrapped so they scroll.
- The `Input` and `Textarea` primitives already use 16px text on mobile.

Most of the problems come from **a handful of shared patterns repeated across many pages**, so a small number of fixes clears most of them.

| | Before |
|---|---|
| Lighthouse accessibility, mobile, 16 key pages | **80–100**, median 93 (table in §8) |
| axe violations (WCAG 2.0/2.1/2.2 A+AA + best practice) on 42 product and marketing routes at 360px | **19 distinct rules; at least 1 violation on 38 of 42 routes** |
| Routes with an extra, invisible tab stop | **Every app-shell route at phone width** (29 audited) (S-6) |
| Routes with horizontal overflow at 360px | 3 (`/admin`, `/admin/users`, `/admin/growth/interest-list`), plus every contact profile whose name is long (R-6) |
| Unusable at 360×640 or at 200% zoom | Reminder (and most other) dialogs: **the Save button can't be reached**. Chat: **the message area collapses to 0px**. |

### The ten that matter most

| # | Finding | Severity | Where |
|---|---|---|---|
| S-1 | Contact form and three other shared `Field` helpers have no programmatic labels. Each field's accessible name is its placeholder ("Jason Pereira"). | **Critical** | `/contacts/new`, edit sheet, onboarding manual step, bulk notes, capture review |
| R-1 | `DialogContent` has no max-height. On short phones and at 200% zoom the footer and Save button are clipped and can't be scrolled to. | **Critical** | 31 of 39 dialogs |
| R-2 | Viewport-locked pages (Chat, Constellation) leave no room for content at 200% zoom or in landscape. | **Serious** | `/chat`, `/graph` |
| S-3 | Every product page has the same `<title>`, so Next's route announcer never speaks. Client-side navigation is silent for screen-reader users. | **Serious** | 27 `(app)` routes |
| S-5 | Contact rows are `<li role="link">` with buttons nested inside. | **Serious** | `/contacts` (and therefore `/find` results) |
| S-6 | The mobile Capture button's `whileTap` gives an `aria-hidden` span `tabindex=0`, creating an invisible tab stop. | **Serious** | Every app page below `md` |
| S-9 | Body text using `text-muted-foreground/70` or `/80`, brand-tinted company names, and the amber tier badges fall below 4.5:1. | **Serious** | Contacts, Recruiters, admin; 66 call sites |
| S-8 | Undo toasts disappear after Sonner's 4s default (SC 2.2.1). | **Serious** | 28 `runToastAction` call sites |
| R-4 | Hover-revealed controls (e.g. delete chat) stay invisible on touch but can still be tapped. | **Serious** | Chat, notes sorter, feedback, ask bar, toasts |
| X-1 | Inputs and selects that override the primitive's `text-base` with `text-sm` make iOS Safari zoom the page on focus. | **Serious** | Contacts search, 30+ inputs and selects |

---

## 2. Method

**Environment.** The app ran under `next dev` in demo mode: no Clerk keys, a throwaway PGlite database, and the localhost demo network of 85 contacts. That is the same setup `playwright.config.ts` uses for CI. A second pass used an empty account (`ORBIT_DEMO_DATA=off`) to check onboarding and empty states. In demo mode the admin console renders for the demo user, so all 26 admin pages were audited too.

**Automated checks**
- **axe-core 4 via `@axe-core/playwright`.** Tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` and `best-practice`. Run at 360px and 1440px on every route, and in dark mode at 1280px for contrast.
- **Playwright layout probes at 360, 768, 1024 and 1440px.** Each probe measured:
  - document horizontal overflow, and which elements stick out past the viewport edge;
  - the box size of every interactive target, measured as rendered (the hit area added by `tap-target` is not counted);
  - landmarks, `<h1>`, skip link, `<title>`;
  - infinite animations still running.
- **Keyboard walk at 1440px.** Forty Tabs per route, recording what got focus and whether a visible outline or ring appeared.
- **Reflow and zoom.** 320px wide (SC 1.4.10, equivalent to 1280px at 400%) and 640×450 (1280×900 at 200%).
- **Reduced motion.** `prefers-reduced-motion: reduce`, then a count of running infinite animations and canvases still changing between frames.
- **Edge content.** Created contacts with:
  - a 120-character unbroken name, an unbroken company name and a URL as the title;
  - an Arabic name and company;
  - an emoji plus combining marks plus literal `<b>&amp;</b>`, and a CJK company name.

  Then viewed them in the list and on the profile at 360px and 1440px.
- **Form errors.** Submitted the contact form empty and recorded where focus went, `aria-invalid`, and any `role=alert`.
- **Lighthouse 12** accessibility category on 16 representative pages, mobile form factor.

**Manual review.** I read the code of the app shell, the UI primitives, the forms, toasts, overlays, motion and CSS, and checked screenshots of every route at every width.

### What I could not verify

| Area | Why | How the findings were produced |
|---|---|---|
| **Safari (macOS and iOS) and Firefox** | Only Chromium is installed in this environment (`/opt/pw-browsers`), and the environment rules out downloading WebKit or Firefox. | Code inspection against known engine behaviour. Every finding in §5 is a *risk* to confirm on a real device. |
| **Real screen readers** (VoiceOver, NVDA, TalkBack) | None available here. | Inferred from the accessibility tree, ARIA attributes and live-region code. |
| **Windows High Contrast / forced colors** | Chromium headless can emulate `forced-colors`, but I didn't run it. | S-7 is inferred from CSS (`outline-none` plus a box-shadow ring is removed in forced colors). |
| **Signed-in Clerk flows** (`/sign-in`, `/sign-up`, `/suspended`) | Without Clerk keys, demo mode redirects these routes to `/dashboard` or `/`. | Code review only. |
| **Real error states** | Error boundaries can't be triggered without breaking the server. | Code review of `error.tsx` coverage, plus the runtime 404 and missing-contact pages. |
| **Production build** | Audited under `next dev`. Lightning CSS adds `-webkit-` prefixes only in production builds. | Noted in §5. Contrast and ARIA results don't depend on the build. |
| **Admin user-contact detail, feedback detail, meeting with real transcript** | No seeded data for them. | Code review. |
| **Lighthouse on Safari** | No WebKit. | n/a |

---

## 3. Systemic findings (one fix, applied everywhere)

Severity scale:
- **Critical:** blocks a task for some users.
- **Serious:** a WCAG A or AA failure, or a large usability loss.
- **Moderate:** an AA failure in an edge case, or a notable degradation.
- **Minor:** best practice, or polish.

### S-1. Shared `Field` helpers don't label their controls. **Critical** (SC 1.3.1, 3.3.2, 4.1.2)

**Evidence**
- On `/contacts/new`, every input has `label=null` and `aria-label=null`. Its only name is the placeholder. "Full name" is announced as "Jason Pereira" and "Company" as "Amazon Web Services (AWS)".
- axe flags `label` (date and number inputs) and `select-name` (the "How you met" `<select>`). The other inputs pass axe only because axe accepts a placeholder as a name.
- The `" *"` required marker and the `hint` text ("Paste a profile URL to autofill role") aren't exposed to assistive technology at all.

**Cause:** four local `Field` helpers render `<Label>` with no `htmlFor` and don't wrap the control:
- `src/components/contacts/contact-form.tsx:570`, used by `/contacts/new`, the contact edit sheet and onboarding `manual-step.tsx`
- `src/components/chat/bulk-notes-panel.tsx:1731`
- `src/components/capture/review/person-fields.tsx:311`
- `src/components/events/edit-attendee-dialog.tsx:223`

**Fix (once)**
1. Add `src/components/ui/field.tsx`, built on `@base-ui/react/field` (already a dependency). It exports `Field`, `FieldLabel`, `FieldDescription` and `FieldError`, and wires `id`, `htmlFor`, `aria-describedby` and `aria-invalid` itself.
2. Replace the four local helpers with it.
3. Render the required marker as visible `*` plus sr-only "(required)" text, and keep `required` on the control.
4. In bulk-notes and person-fields, `*` currently means "low confidence". Replace it with visible "check this" text linked through `aria-describedby`.

**Placeholder-only inputs outside those helpers.** Give each a visible label or an `aria-label`:
- chat composer `chat/chat-panel.tsx:1709`
- command palette `layout/command-palette-dialog.tsx:506`
- floating ask bar `layout/floating-ask-bar.tsx:858`
- `contacts/contacts-filters.tsx:429`, `recruiters/recruiter-list.tsx:46`, `graph/network-graph.tsx:926`, `:1005`
- `dashboard/goals-summary.tsx:110`, `settings/goals-settings.tsx:108`
- `imports/calendar-subscribe-panel.tsx:71,77,82`
- `contacts/contact-follow-up-section.tsx:401,455`
- `outreach/message-editor-row.tsx:75,81`
- `capture/suggested-reminders-review.tsx:131,146`
- `settings/profile-settings.tsx:143`. Here `SettingsRow` renders an `<h4>`, so add a `labelFor` prop to `settings-section.tsx:106`.

**Button groups labelled by a bare `<Label>`** (`contacts/log-interaction-sheet.tsx:316`, `interaction-detail-sheet.tsx:332`): use `role="group" aria-labelledby`.

### S-2. Validation errors are announced only as toasts, and focus isn't moved. **Serious** (SC 3.3.1, 4.1.3)

**Evidence**
- Submitting `/contacts/new` empty relies on the browser's native bubble alone. That happens to work, but it has no `aria-invalid` and no inline message.
- In `reminders/reminder-form-dialog.tsx:118`, an empty title triggers `toast.error("Give it a title first")`. The input has no `required` and no `aria-invalid`, and focus stays on the Save button.
- Server-side save errors are toast-only in several places: `contact-form.tsx:283`, `recruiters/recruiter-log-form.tsx:89`, `settings/profile-settings.tsx:166,209,265`, `goals-settings.tsx:95`, `target-companies-settings.tsx:65` and onboarding `triage-step.tsx:112`.
- On `landing/waitlist-form.tsx:78`, the error has no `role="alert"`, and the success state replaces the form without announcing it, so focus is lost.

**Fix (once)**
1. Use `FieldError` from S-1. It renders an inline message with `aria-live="polite"`, and the field gets `aria-invalid`.
2. Add `focusFirstInvalid(form)` to `src/lib/forms.ts` and call it from each form's error path.
3. Keep the toast for errors that aren't about a field.
4. In waitlist-form, wrap the result in `role="status"` and add `autoComplete="email"`.

`marketing/contact-form.tsx` and `interest/interest-hero.tsx` already follow this pattern correctly; use them as the model.

### S-3. Product pages have no titles, so route changes aren't announced. **Serious** (SC 2.4.2, 4.1.3)

**Evidence:** 26 of 27 `(app)` routes and `admin/yc` report the same `<title>`, "Orbit — Personal Networking Tracker". There is no title template, so the one page that sets a title (`contacts/duplicates`) reads just "Duplicates".

Next 16's announcer (`node_modules/next/dist/client/components/app-router-announcer.js`) speaks only when `document.title` changes. Because every page has the same title, nothing is announced on navigation.

**Fix**
1. In `src/app/layout.tsx`, set `title: { template: "%s · Orbit", default: "Orbit — Personal Networking Tracker" }`.
2. Add `export const metadata = { title: "…" }` to each page. Use `generateMetadata` for the `[id]` routes: contact name, meeting title, recruiter name.
3. Add `metadata = { title: "Page not found" }` to `src/app/not-found.tsx` and a `<title>` to `global-error.tsx`.

**Related (SC 2.4.3), Moderate:** `(app)/template.tsx` remounts the page on every navigation. If the activating link was inside the page, focus falls to `<body>`. Add a small `RouteFocus` client component to the template. On a pathname change, but not on first load, it moves focus to the page `<h1>` (`tabIndex={-1}`).

### S-4. No skip link, and the shell's landmarks are nested. **Serious** (SC 2.4.1, 1.3.1)

**Evidence:** no route has a skip link (the keyboard walk's first Tab always lands on the logo or sidebar). Problems by component:
- **`app-shell.tsx:223`:** `<main>` wraps the mobile `<header>`, the notifications button, `FloatingAskBar` and `MobileNav`. The header is therefore not a banner, and the nav sits inside main.
- **`app-sidebar.tsx:198`:** the sidebar is an `<aside>` (complementary), and pages with their own `<aside>` trigger `landmark-unique` (`/reminders`, `/knowledge`).
- **`<nav>` without `aria-label`:** `app-sidebar.tsx:268`, `mobile-nav.tsx:651` and `admin-shell.tsx:96,187`.
- **Landing:** `<main>` wraps only the hero (`landing/hero-pin.tsx:170`), so axe reports `region`.
- **`not-found.tsx` and the missing-contact page:** no `<main>` at all (`landmark-one-main`).

**Fix**
1. Add one `SkipLink` component (`sr-only focus:not-sr-only`, `href="#main-content"`) as the first child of `<body>` in `src/app/layout.tsx`.
2. Put `id="main-content" tabIndex={-1}` on each shell's content column.
3. In `app-shell.tsx`, make `#app-main-scroll` a `<div>`, turn the content column into the `<main>`, and move the header and navs out of it.
4. Change the sidebar `<aside>` to a `<div>`.
5. Label the navs "Main", "More" and "Admin".
6. Move the landing `<main>` up to wrap `LandingPageShell`.
7. Wrap `not-found` in `<main>`.
8. Add `aria-current="page"` to the active item in `AppSidebar` and `MobileNav`. Admin nav already does this.

### S-5. Contact rows are `<li role="link">` with nested buttons. **Serious** (SC 1.3.1, 4.1.2)

**Evidence:** axe on `/contacts` reports:
- `aria-allowed-role` ×50
- `list` ×14 (the `<ul>` loses its list items)
- `nested-interactive`, from the LinkedIn, follow-up, delete and closeness-chip buttons inside the row
- the row's accessible name is the entire row's text

Code: `contacts/contacts-list.tsx:672`. Admin uses the same pattern: `<li role="button" aria-pressed>` in the billing bar and list charts (`/admin/billing/costs`, `/demand`, `/run-cost`).

**Fix:** keep a plain `<li>`. Make the name a real `<Link href={`/contacts/${id}`}>` that stretches over the row (`after:absolute after:inset-0`), and give the row's buttons `relative z-10`. This also enables open-in-new-tab and middle-click. Keep the intent-prefetch handlers on the link.

For the admin charts, put a `<button aria-pressed>` inside each `<li>`.

### S-6. Invisible extra tab stop on every app page at phone width. **Serious** (SC 2.4.3, 4.1.2)

**Evidence:** axe reports `aria-hidden-focus` on all 29 app-shell routes audited at 360px (including `/sign-in`, `/sign-up` and `/onboarding`, which redirect to the dashboard in demo mode).

**Cause:** `layout/mobile-capture-button.tsx:236`, an `<motion.span aria-hidden whileTap>`. Motion adds `tabindex="0"` to any element with `whileTap`, so keyboard and switch users land on an unnamed, hidden stop inside the Capture link.

**Fix:** add `tabIndex={-1}` to that `motion.span`.

**Similar case:** `layout/floating-ask-bar.tsx:579` sets `aria-hidden={!visible}` when the bar hides on scroll, but its input and buttons stay focusable. Replace it with `inert={!visible}`.

### S-7. Focus indicators. **Serious** (SC 2.4.7, 1.4.11)

**Forced colors.** The primitives and about 100 hand-rolled copies use `outline-none` plus a box-shadow `ring-*`:
- `ui/button.tsx:7`, `input.tsx`, `select.tsx`, `checkbox.tsx` and `textarea.tsx`
- Windows High Contrast removes box-shadows, so these controls have no focus indicator at all there.
- `globals.css:3075` already has a fallback for this, but it's opt-in (`.focus-ring-fallback`) and only used on rows.
- **Fix (once):** make the fallback global and unlayered: `@media (forced-colors: active) { :focus-visible { outline: 2px solid CanvasText; outline-offset: 2px } }`. Then switch the primitives from `outline-none` to `outline-hidden`, which Tailwind v4 emits as a transparent outline that forced colors repaints.

**Search bars with no or weak focus.** These were flagged by the keyboard walk as having no outline or ring on the focused element:
- contacts search `contacts-filters.tsx:376`
- reminders search `reminder-filters.tsx:77`
- floating ask bar `floating-ask-bar.tsx:852`
- the landing and interest waitlist email inputs

Their wrapper uses `focus-within:ring-primary/15`, which is under 3:1. **Fix:** use the same `focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50` as `ui/input`.

**Inputs whose replacement focus style is barely visible:**
- `editable-fact-list.tsx:142` and `contact-follow-up-section.tsx:406`: `focus:border-border`, which only changes border opacity from 70% to 100%
- admin `broadcast-composer.tsx:76,99,142`, `interest-list-manual-add.tsx:18`, `admin/feedback/page.tsx:148`
- `marketing/contact-form.tsx:14`, `share-row.tsx:123`
- `email/recipient-field.tsx:158`, which shows only the caret

**Fix:** use `<Input>` / `<Textarea>`.

**Constellation zoom targets.** On `/graph` (desktop canvas), 12 focusable `div`s ("Zoom to Google", …) show no visible focus. Add a `focus-visible:ring-2 ring-ring` treatment in `graph/graph-nodes.tsx`.

### S-8. Actionable toasts time out. **Serious** (SC 2.2.1)

**Evidence:** `runToastAction` (`src/lib/toast.tsx:380`) shows "Undo" with `keep: false` and no `duration`, so Sonner's 4s default applies. It is never filed in the notification panel.

It is used at 28 call sites: delete contact, dismiss, mark done and others. A keyboard user has to reach the toast region (Alt+T) and the button within 4s.

**Fix (once, in `lib/toast.tsx`):**
- Default `duration` to `Math.max(10_000, …)` whenever `action` is set.
- Keep the Undo toast in the notification panel for its valid window.
- Put "Press Alt+T to reach it" in the toast's accessible description.

Error toasts already last 10s and are kept, which is correct.

### S-9. Text contrast below 4.5:1. **Serious** (SC 1.4.3)

The measured failures fall into four groups.

**1. `text-muted-foreground/NN` opacity variants**

| Variant | Light | Dark | Call sites |
|---|---|---|---|
| `text-muted-foreground/80` | 3.77:1 | 4.38:1 | 11 |
| `text-muted-foreground/70` | 3.04:1 | 3.68:1 | 19 |
| `/60` and below | worse | worse | 35 |

Examples: the contact row's details line (`contacts-list.tsx:762`), "No community ratings" on `/recruiters`, and the dev-only integration notes.

**Fix (tokens):** add `--muted-foreground-subtle` to `:root` and `.dark` at about 4.6:1. Map it to `text-subtle` in `@theme`, use it in place of `/70` and `/80` on text, and keep the opacity variants only for icons and borders. A lint check (CI step below) prevents regressions.

**2. Brand-tinted company names** (`contacts/company-role-line.tsx`, via `lib/company-brand.ts`)

| Text | Color | Contrast |
|---|---|---|
| Figma | `#F24E1E` on white | 3.56:1 |
| Stripe, dark mode | `#635BFF` on `#222427` | 3.31:1 |
| Monochrome fallback (Vercel, Notion, X) | `#9CA3AF` | 2.5:1 |

**Fix (once):** keep the brand hex but render it as `color: color-mix(in oklab, var(--brand) 62%, var(--foreground))`. The brand hex goes in a CSS variable and the class lives in `company-role-line.tsx`. Because `--foreground` flips with the theme, one rule darkens the color in light mode and lightens it in dark mode. Change the fallback to `var(--muted-foreground)`. Verify with the existing `scripts/smoke-tier-contrast.ts` approach.

**3. Amber chips**
- the "MID ORBIT" tier badge: 4.48:1, `text-amber-700` on `bg-amber-500/15`, `closeness-tier-badge`
- admin health and product chips: 4.42:1 and 3.91:1, `--warning` on tinted fills

**Fix:** use `--warning` with a lighter surface (`--warning-surface`), or darken to amber-800 on tinted fills.

**4. Disabled-looking span in `/admin/growth/broadcasts`:** 1.79:1. If it is a non-interactive placeholder, it needs real text color. If it's disabled, mark it with `aria-disabled`.

The landing page's "Step 01 · you" captions measured 1.47:1, but only mid-way through their scroll-reveal animation. At rest they pass. I've treated this as a false positive and will re-check after the fixes.

### S-10. Buttons lose their name below 640px. **Serious** (SC 4.1.2)

**Evidence:** axe `button-name` on `/chat` (History, New chat, Context) and `/graph` (Refresh) at 360px only.

**Cause:** the label is `<span className="hidden sm:inline">`, which removes it from the accessibility tree.

**Fix (pattern):** change these to `max-sm:sr-only`, as `reminders/reminder-create-form.tsx:50` already does. Call sites:
- `chat/chat-panel.tsx:1454,1544,1555`
- `graph/network-graph.tsx:1177`
- `onboarding/steps/highlights-step.tsx:216`
- `radar/morning-briefing.tsx:149`

Also: the `/contacts` closeness popover trigger has no name at 360px (the chip's text is hidden there). The md-width sidebar rail (`app-sidebar.tsx:112`) relies on `title` alone. Wrap it in the existing `Tooltip`.

### S-11. ARIA misuse found by axe. **Moderate**

| Rule | Where | Fix |
|---|---|---|
| `aria-allowed-attr` (critical in axe) | `contacts/refresh-contacts-button.tsx:141`: `aria-valuemin`/`max` on a `<button>` | Move them to an inner `role="progressbar"` element with an `aria-label`. |
| `aria-prohibited-attr` | `contacts/contact-avatar.tsx:55`: `aria-label` on a `<span>` | Add `role="img"`, or put `alt` on the image and `aria-hidden` on the span. |
| `aria-progressbar-name` | `settings/plan-settings.tsx:214`, `settings/avatar-sync-status.tsx:51` | Add `aria-label` ("Credits used this month"). |
| `aria-toggle-field-name` | `recruiters/compose-workspace.tsx:144`: `Checkbox` with no label | Add `aria-label={`Include ${name}`}`. |
| `label-content-name-mismatch` (SC 2.5.3) | landing logo link: `aria-label="Back to top"` but visible text "Orbit" (`landing-header.tsx:126`); admin users "Change plan for demo-user" | Start the name with the visible text: "Orbit, back to top". |
| `image-redundant-alt` (every page) | the Orbit logo `<img alt="Orbit">` next to the text "Orbit" (`orbit-logo.tsx`) | Use `alt=""` when the wordmark is shown. |
| `scrollable-region-focusable` | `overflow-x-auto` table wrappers on `/privacy`, `/pricing`, `/admin/analytics/*`, `/admin/billing/movement`, `/admin/growth` | One shared `ScrollRegion` (`tabIndex={0} role="region" aria-label`) in `admin/primitives.tsx` and `marketing-doc`. |
| `heading-order` | `/reminders` jumps from h1 to h3 bucket headings (`reminders-stage.tsx:766`) | Use `h2`. |
| `landmark-unique` | `/settings` has two sections with the same label; sidebar `<aside>` (S-4) | Use unique `aria-labelledby` targets. |

### S-12. Loading, error and empty states. **Moderate** (SC 4.1.3)

- **Loading:** 65 `loading.tsx` files exist, but none is announced. Only `admin/loading-shells.tsx:86` sets `aria-busy`. **Fix (once):** a `LoadingRegion` wrapper (`role="status"`, sr-only "Loading contacts…") used by `loading/page-skeletons.tsx`, plus `aria-hidden` on `ui/skeleton.tsx`.
- **Error:** there is no root `src/app/error.tsx`. `error-fallback.tsx:52` has no `role="alert"` and doesn't move focus to its heading.
- **Empty:**
  - A brand-new account on `/contacts` sees "No contacts match these filters. Clear search to see everyone…" when no filter is active. It should say "No one here yet" and offer Capture and Import actions.
  - The empty Constellation shows only the user's own star, with nothing explaining it.
  - There is no shared app `EmptyState`; the admin one at `admin/primitives.tsx:493` is a bare `<p>`. **Fix:** add `ui/empty-state.tsx` (icon, heading, body, action) and use it on these two pages and the other ad-hoc empty states.

### S-13. Motion. **Moderate** (SC 2.2.2 at AA; 2.3.3 is AAA)

**Verified good:** under `prefers-reduced-motion: reduce`, **0 infinite animations were running on all 50 routes checked**. The only canvas still changing was the Constellation starfield's slow twinkle.

The global CSS catch-all (`globals.css:2548`) and `MotionConfig reducedMotion="user"` both work.

**Gaps**
- `MotionConfig` doesn't reach the admin area, auth pages, `/suspended` or not-found. **Fix:** move a single `<MotionConfig reducedMotion="user">` to `src/app/layout.tsx` and delete the copies in `app-shell.tsx` and `landing-motion-provider.tsx`.
- The desktop Constellation's camera flights (`graph/graph-canvas-flow.tsx:1913,1939,1977`) ignore reduced motion. The mobile canvas already handles this. **Fix:** set `duration: reduced ? 0 : CAMERA_MS`.
- SC 2.2.2 applies to every user, not only those with reduced motion set. These loop for more than 5s with no pause control:
  - the coming-soon marquee (`coming-soon/coming-soon.tsx:130`, 28s infinite)
  - `gold-shimmer-text` (`chat-panel.tsx:1587`)
  - `plan-badge-glint`
  - **Fix:** stop them after 1–2 iterations (`animation-iteration-count: 2`). Alternatively, add "Reduce motion" to Appearance settings, setting `html[data-motion="reduce"]`, which the CSS catch-all and `usePrefersReducedMotion` both read.
- **Interest page:** the demo tour's caption is `aria-live="polite"` (`interest/app-demo/demo-window.tsx:257`), so it narrates every beat, endlessly. Set it to `aria-live="off"` while the tour auto-plays.

### S-14. Other keyboard and screen-reader issues. **Moderate**

- **Custom full-screen overlays** (`credits-intro-stage.tsx`, `celebration-stage.tsx`) move focus in and handle Escape, but don't keep Tab inside or make the page behind `inert`. Wrap them in Base UI `Dialog`, as `linkedin-reminder-stage.tsx` does.
- **Reminders single-key shortcuts** (`reminders/use-triage-keys.ts:35`, SC 2.1.4) are bound on `window`. Scope them to focus within the list.
- **Contacts A–Z rail** (`contacts-list.tsx:975`): the buttons are `tabIndex=-1` and pointer-only, and measured **26×5px** at 360×780 with 9px text. Make it a single tab stop with arrow keys, like `timeline-date-scrubber.tsx`. Mark the letters `aria-hidden` and give the rail `role="slider"` semantics. Raise the text to 11px.
- **`ui/date-picker.tsx`:**
  - day buttons are announced as just "14"; add `aria-label` with the full date, `aria-pressed` and `aria-current="date"`
  - the month heading needs `aria-live`
  - `DatePickerButton` doesn't take an `id`, so `<Label htmlFor>` in `reminder-form-dialog.tsx:204` points at nothing
- **Minor:** the notifications panel's action names repeat ("Mark done", "Snooze 7 days"); include the item title. `email/recipient-field.tsx` combobox has no `aria-activedescendant`.

---

## 4. Responsive findings

Summary at each width (✓ = no overflow, clipping or unreachable controls found):

| Width | Product routes | Marketing routes | Admin routes |
|---|---|---|---|
| 360 | ✓ except long names (R-6), short-viewport dialogs (R-1), letter rail (S-14) | ✓ | ✗ `/admin` +101px, `/admin/users` +25px, `/admin/growth/interest-list` +45px (R-7) |
| 768 | ✓ | ✓ | ✓ |
| 1024 | ✓ | ✓ | ✓ |
| 1440 | ✓ | ✓ | ✓ |
| 320 (reflow) | ✓ | ✓ | ✗ `/admin` +141px, `/admin/users` +65px |
| 640×450 (200% zoom) | ✗ `/chat`, `/graph` (R-2); dialogs (R-1) | ✓ | ✓ |

### R-1. Dialogs have no height cap. **Critical** (SC 1.4.10, 2.4.11)

**Evidence:** at 360×640, opening New reminder on `/reminders` puts the dialog at 194–740px, with the Save button 100px below the fold. It has `overflow-y: visible` and the page behind is locked, so the form can't be submitted.

`ui/dialog.tsx:53` is `fixed top-1/2 -translate-y-1/2` with no max-height. 31 of 39 `DialogContent` uses add nothing, including `reminder-form-dialog`, `add-event-dialog`, `edit-attendee-dialog` and `comp-plan-dialog`. The rest cap with `vh`, which on iOS means the large viewport, so the bottom hides behind Safari's toolbar: `edit-event-dialog` (85vh), `notes-sorter-dialog` (90vh), `capture-source-card` (75vh) and both export guides.

**Fix (once, base class):** add `max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain`, and on phones `max-sm:top-4 max-sm:translate-y-0` so inputs sit above the iOS keyboard. Then change every `max-h-[NNvh]` to `dvh`. Apply the same to the `Textarea` primitive's `max-h-[50vh]`.

### R-2. Viewport-locked pages at 200% zoom and in landscape. **Serious** (SC 1.4.10, 1.4.4)

**Evidence:** at 640×450 (1280×900 at 200%), `/chat`'s message list is **0px tall**. The composer is half-covered by the mobile nav, and `#app-main-scroll` is `overflow: hidden` with nothing to scroll. Any answer would be invisible. `/graph` has the same lock (`network-graph.tsx:806,839`, `100dvh-15.125rem`).

**Fix:** in `app-shell.tsx`, keep `isViewportLocked` only when the viewport is taller than 500px:
- `[@media(max-height:500px)]:overflow-y-auto` on `<main>`
- `[@media(max-height:500px)]:h-auto min-h-[28rem]` on the chat and graph frames

The same pattern already exists at `globals.css:3269` for the letter rail.

### R-3. Small tap targets. **Serious** for under-24px (SC 2.5.8 AA), Moderate for under-44px

**`ui/button.tsx` sizes:** `default` 32px, `sm` 28px, `xs` 24px, `icon` 32px, `icon-sm` 28px, `icon-xs` 24px. The existing `tap-target` utility (`globals.css:3281`) grows the hit area to 44px on coarse pointers, but:
- it's used at only 37 sites, against roughly 486 small buttons;
- it needs a positioned parent, and `Button` isn't `relative`.

**Measured under 24px:**
- the A–Z rail letters: **26×5px**
- reminders and recruiters-compose checkboxes: 16×16px
- delete-chat buttons: 22×22px
- admin product plan radios: 35–40×22px

Code review also found these under 24px: `chat-panel.tsx:1498` (about 18px), `chat-panel.tsx:2219,2231` (20px), `email/recipient-field.tsx:94`, `attachment-list.tsx:46`, `reply-picker.tsx:77` and `scan/scan-camera.tsx:262`.

**Fix (once)**
1. Add `relative` to the `buttonVariants` base and `tap-target` to `xs`, `sm`, `icon-xs`, `icon-sm` and `icon`. The `::after` only exists on coarse pointers, so desktop is unchanged.
2. Add `relative tap-target` to the `Checkbox` primitive.
3. Move the raw icon buttons listed above to `<Button size="icon-xs">`.

### R-4. Hover-revealed controls are invisible on touch. **Serious**

In Tailwind v4, `hover:` and `group-hover:` apply only under `@media (hover: hover)`, so `opacity-0 group-hover:opacity-100` leaves the control invisible on touch screens. It can still be tapped, and some of these are destructive. iOS doesn't focus a tapped button, so `focus-within` doesn't reveal it either.

Affected:
- `chat/chat-history-rail.tsx:198` (delete chat)
- `chat/chat-panel.tsx:1498,1995`
- `capture/notes-sorter-dialog.tsx:711` (its comment calls it the touch path)
- `feedback/feedback-panel.tsx:635`
- `layout/floating-ask-bar.tsx:714,721`
- toast close (`ui/sonner.tsx:281`)

**Fix (once):** add a `reveal-on-hover` utility in `globals.css` that hides only under `(hover: hover) and (pointer: fine)` and reveals on group hover, `focus-within`, `focus-visible` and `[data-popup-open]`, then use it at those call sites. `reminders/reminder-rail.tsx:229` already does this by hand.

### R-5. Focus and scrolled-to content hidden under fixed bars. **Moderate** (SC 2.4.11)

There's no `scroll-padding` anywhere. `#app-main-scroll` has the mobile nav (about 5.5rem plus safe area) and the floating ask bar over its bottom, and sticky letter, date and bucket headers over its top. Tabbing or `scrollIntoView` can put the focused row right under them.

**Fix:** on the scroller, add `scroll-pt-12 scroll-pb-[calc(9.625rem+env(safe-area-inset-bottom))] md:scroll-pb-24`, matching the existing content padding. Also add `scroll-padding-top: 4rem` to the admin shell.

### R-6. Long, RTL and unusual content. **Serious** for long names, Moderate for RTL

**Long names:** a contact named with 120 unbroken characters makes the profile's scroll container **1,630px wider than the 360px viewport**. Overflowing elements:
- the hero `<h1>`
- the URL title line
- the "Where things stand" and "Who they are" cards

The `<h1>` (`contact-profile-hero.tsx:421`) is `flex flex-wrap break-words`, but the name is an anonymous flex item, so its min-width is its full min-content width.

The contacts list handles the same data correctly, with truncation and `min-w-0`. The chat user bubble (`chat-panel.tsx:2000`) and `chat-markdown.tsx` have the same risk with pasted URLs.

**Fix**
1. Add `overflow-wrap: anywhere` to `body` in `globals.css`. It inherits, and doesn't affect normal words.
2. In the hero, wrap `{displayName}` in `<span className="min-w-0">`.
3. Add `break-words` to the profile's role and meta lines.

**RTL:** an Arabic title and company render as "مدير المنتجات · شركة الاتصالات السعودية" inside an LTR paragraph, so the order flips for RTL readers. `dir="auto"` and `<bdi>` aren't used anywhere. **Fix:** add `dir="auto"` to the `Input` and `Textarea` primitives and to `MentionText`. Wrap name, company and title spans in `<bdi>`, via `CompanyRoleLine` and the profile hero.

**Unusual characters:** `<b>&amp;</b>` renders literally, so escaping is correct. Emoji, combining marks and CJK render correctly. A name starting with an emoji is filed under "#", which is reasonable.

**Initials:** `src/lib/initials.ts:9`, `admin-metrics.ts:120` and `capture/note-batch-result.tsx:131` index by UTF-16 code unit, so a name like "😀 Sam" produces a lone surrogate. **Fix:** use `Intl.Segmenter` graphemes, skip characters that aren't letters, and route all callers through `initialsFromName`. This is Minor; the main `ContactAvatar` uses an image placeholder and isn't affected.

### R-7. Admin overflow at phone width. **Moderate**

| Route | Overflow at 360px | Overflow at 320px | Overflowing element |
|---|---|---|---|
| `/admin` | +101px | +141px | Activation bars and "Signed up recently" card (screenshot shows both running off-screen) |
| `/admin/users` | +25px | +65px | Segmented state filter (`users-filter-bar.tsx`) |
| `/admin/growth/interest-list` | +45px | — | Header action row |

**Fix:** in `admin/primitives.tsx`, add `min-w-0` to grid and flex children and make segmented controls `overflow-x-auto`. The header action row should use `flex-wrap`.

### R-8. Small fixed text. **Moderate** (SC 1.4.4 robustness)

- `text-[10px]`: 117 uses
- `text-[11px]`: 138 uses
- `text-[9px]`: 7 uses
- `.constellation-edge-label`: 8px

All are px-based, so they ignore the user's browser font-size setting. **Fix:** add `--text-2xs: 0.6875rem` (11px, rem-based) to `@theme`, replace the 9px and 10px sizes with it, and keep 11px uses as `text-2xs`.

---

## 5. Cross-browser findings (code inspection; confirm on devices)

**Browser floor:** Tailwind v4 needs Safari 16.4+, Firefox 128+ and Chrome 111+ (`@property`, `color-mix`, `oklch`). `globals.css` uses `color-mix` and `oklch` with no fallback. Document 16.4 as the supported floor.

| # | Issue | Browsers | Severity | Fix |
|---|---|---|---|---|
| X-1 | Inputs and selects whose `text-sm`/`text-xs` beats the primitive's `text-base` make iOS zoom on focus. Key cases: contacts search `contacts-filters.tsx:388`, native `<select>`s (`contact-form.tsx:455`, measured at 14px; outreach, recruiter, reminder-card), `chat-panel.tsx:1960`, `follow-up-draft-composer.tsx:147`, `profile-settings.tsx:149`, both delete dialogs, and admin inputs. | iOS Safari | **Serious** | One global rule in `@layer base`: `@media (pointer: coarse) { input:not([type=checkbox],[type=radio],[type=range]), textarea, select { font-size: max(16px, 1em) } }`. |
| X-2 | `Textarea` grows with `field-sizing: content`, which Firefox doesn't support and older Safari lacks, so the chat composer (`rows={1}`) stays one line and scrolls. | Firefox, older Safari | Serious | In `ui/textarea.tsx`, add a `useLayoutEffect` fallback that runs only when `!CSS.supports("field-sizing","content")`. |
| X-3 | No root `viewport` export: only `scan/[token]` sets `viewportFit: "cover"`. Every `env(safe-area-inset-*)` (bottom nav, corner tokens) is 0 in landscape and in home-screen web apps. | iOS | Moderate | In `src/app/layout.tsx`, add `export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" }`. Don't add `maximumScale`; none is set today, which is correct. |
| X-4 | `min-h-screen` / `100vh` on iOS means the large viewport, so centered cards sit low and the page scrolls slightly. Affects the onboarding shell `app-shell.tsx:153`, sign-in and sign-up, `upgrade/page.tsx:78`, `page-skeletons.tsx:527,763`, `global-error.tsx`, and the command palette `top-[14vh]`/`60vh`. | iOS Safari | Moderate | Use `min-h-dvh` and `dvh`. |
| X-5 | Native `type=date` / `datetime-local` inputs (contact form, log interaction, events) are centered, blank when empty, and have an intrinsic min-width on iOS. | iOS Safari | Moderate | Add a `@layer base` reset: `appearance:none; min-width:0`, and `::-webkit-date-and-time-value { text-align:start }`. |
| X-6 | Clipboard writes aren't awaited, so a success toast shows even when Safari rejects the write. Affects `outreach-actions.tsx:61,82`, `bulk-action-bar.tsx:89`, `reminder-card.tsx:318`, `reminder-detail-pane.tsx:231`, `follow-up-draft-sheet.tsx:231,238` and `contact-follow-up-section.tsx:217`. | Safari | Minor | Add a shared `copyText()` with try/catch. `gmail-send-dialog.tsx:143` already does this correctly. |
| X-7 | `[scrollbar-width:none]` alone (`admin/section-tabs.tsx:48`, `product-tabs.tsx:48`, `highlights-step.tsx:286`) doesn't hide the scrollbar before Safari 18.2. | Safari < 18.2 | Minor | Also add `[&::-webkit-scrollbar]:hidden`. |
| X-8 | `<summary class="list-none">` still shows a disclosure triangle (`bulk-notes-panel.tsx:1187`, `person-fields.tsx:198,216`). | Safari | Minor | Add `[&::-webkit-details-marker]:hidden`. |
| X-9 | `body { background-attachment: fixed }` (`globals.css:471`) is ignored on iOS and repaints on scroll in macOS Safari. | Safari | Minor | Move the gradients to a `position: fixed` pseudo-element. |
| X-10 | Hand-written `backdrop-filter` (`globals.css:511,1365,1440`) gets its `-webkit-` prefix only from Lightning CSS in production builds. Dev previews in Safari before 18 show no blur. | Safari < 18 (dev only) | Info | No production impact. A `@supports not` fallback already exists. |

**Already robust:**
- `requestIdleCallback` has a fallback, and `OffscreenCanvas` and the worker are feature-detected.
- Voice capture records WAV via AudioWorklet, which avoids MediaRecorder MIME differences.
- Web Speech uses its `webkit` prefix with a fallback.
- `navigator.share` is guarded.
- View Transitions go through React and degrade on their own.
- `formatDetection` prevents iOS hydration mismatches.
- Dark mode sets `color-scheme`.

---

## 6. Findings by page

The systemic IDs above apply wherever listed. Every app page also has **S-3** (title), **S-4** (skip link and landmarks), **S-6** (hidden tab stop at phone width), **S-7** (forced colors) and **S-12** (silent loading), so those aren't repeated per row.

### Marketing and public

| Page | axe at 360 / 1440 | Responsive | Findings |
|---|---|---|---|
| `/` landing | color-contrast\*, image-redundant-alt, label-content-name-mismatch, region | ✓ at all widths | S-4 landing `<main>`, S-11 "Back to top", S-7 waitlist input focus, S-2 waitlist errors and success, S-13 reduced motion verified. \*Contrast only mid-animation. |
| `/interest` | 0 / 0 | ✓ | S-13 tour `aria-live` narration. Lighthouse 100. |
| `/interest/privacy` | 0 / 0 | ✓ | Has no `loading.tsx`, so it inherits the interest skeleton. |
| `/privacy`, `/terms` | scrollable-region-focusable (`/privacy`), image-redundant-alt | ✓ | S-11 ScrollRegion. |
| `/contact` | 0 | ✓ | Form is a good model (labels, `aria-invalid`, `role=alert`). Focus style weak (S-7). |
| `/connect` | 0 | ✓ | — |
| `/pricing` | scrollable-region-focusable, image-redundant-alt | ✓ | S-11 ScrollRegion. Lighthouse 99. |
| `/upgrade` | 0 | ✓ | X-4 `min-h-screen`. |
| `/scan/[token]` | 0 | ✓ | Sets its own viewport (`viewport-fit=cover`). Raw button 20px (R-3). |
| `/sign-in`, `/sign-up`, `/suspended` | not reachable in demo mode | — | Code: no `<main>`, no title (S-3, S-4), X-4. |
| 404 / missing contact | landmark-one-main, region, page-has-heading-one (missing contact) | ✓ | S-3, S-4, S-12. |

### App

| Page | axe at 360 / 1440 | Responsive | Page-specific findings |
|---|---|---|---|
| `/onboarding` (empty account) | 0 / 0 | ✓ | Terms checkbox 16px (R-3). The manual step uses the contact form (S-1). |
| `/dashboard` | aria-hidden-focus / 0 | ✓ | Lighthouse 96. Nothing else beyond the global issues. |
| `/contacts` | aria-allowed-attr, aria-allowed-role ×50, button-name, color-contrast ×3, list ×14 / + color-contrast ×11 | ✓ (rail overlaps search at 320) | **S-5** row semantics, **S-9** muted/80 and brand colors, S-10 chip trigger, S-11 refresh button ARIA, **S-14 / R-3** A–Z rail at 26×5px, X-1 search zoom, S-12 empty copy. Lighthouse **80**, the lowest. |
| `/contacts/[id]` | aria-prohibited-attr ×2, label-content-name-mismatch | ✓ normal names; **✗ +1,630px with long names** (R-6) | S-11 avatar span, **R-6** hero overflow and bidi, R-3 date chips 20px tall. |
| `/contacts/new` | **label ×4, select-name** | ✓ | **S-1**, S-2, X-1 select at 14px, X-5 date input. Lighthouse 89. |
| `/contacts/duplicates` | 0 | ✓ | The only page with a title ("Duplicates", no suffix). |
| `/capture` | aria-allowed-role | ✓ | Composer chips; the role misuse sits on the source picker. |
| `/capture/[batchId]` | 0 | ✓ | `person-fields` Field (S-1), `<summary>` marker (X-8). |
| `/chat` | aria-allowed-role, **button-name ×2** / aria-allowed-role | ✓ at 360–1440; **✗ at 200% zoom** (R-2) | **R-2**, S-10, S-1 composer label, R-4 delete and edit invisible on touch, R-3 delete 22px, R-6 bubble wrapping, X-2 composer autosize, S-13 shimmer. |
| `/find`, `/events`, `/outreach`, `/outreach/new`, `/radar` | 0 (coming-soon screens) | ✓ | S-13 the 28s marquee loops forever. |
| `/graph` | **button-name** / 0 | ✓; **✗ at 200% zoom** (R-2) | S-10 Refresh, S-7 zoom targets lack focus style, S-13 camera flights, R-8 9px labels. Empty account: no empty state (S-12). |
| `/meetings`, `/meetings/[id]` | 0 | ✓ | `[id]` has no `loading.tsx`. |
| `/reminders` | heading-order / landmark-unique | ✓ | **S-2** title error toast-only, S-14 single-key shortcuts and date-picker, R-3 checkboxes 16px, **R-1** dialog clipped at 360×640. Lighthouse 94. |
| `/recruiters` | 0 / color-contrast ×4 | ✓ | S-9 muted/70. |
| `/recruiters/[id]`, `/recruiters/new` | 0 | ✓ | X-1 selects. |
| `/recruiters/compose` | **aria-toggle-field-name** | ✓ | S-11 unlabelled checkbox, R-3. |
| `/knowledge` | landmark-unique | ✓ | S-4 `<aside>`. |
| `/imports` | 0 | ✓ | Export-guide dialogs use `vh` (R-1). |
| `/settings` | aria-progressbar-name, landmark-unique | ✓ | S-11, S-1 `SettingsRow` labelling, X-1 profile inputs. Lighthouse 92. |

### Admin (all 26 pages audited)

| Page | axe | Responsive | Findings |
|---|---|---|---|
| `/admin` | 0 | **✗ +101px at 360, +141px at 320** | R-7. |
| `/admin/users` | label-content-name-mismatch | **✗ +25px at 360** | R-7 filter bar, S-11 "Change plan" name. |
| `/admin/users/[userId]` | 0 | ✓ | — |
| `/admin/billing/costs`, `/demand`, `/run-cost` | aria-allowed-role ×6/×12/×6, list | ✓ | S-5 `li role=button`. |
| `/admin/billing/movement`, `/admin/analytics/engagement`, `/funnel`, `/admin/growth` | scrollable-region-focusable | ✓ | S-11 ScrollRegion. Growth range links are 16px tall (R-3). |
| `/admin/growth/broadcasts` | color-contrast (1.79:1) | ✓ | S-9; composer focus weak (S-7). |
| `/admin/growth/interest-list` | 0 | **✗ +45px at 360** | R-7. |
| `/admin/health` | color-contrast ×4 (4.42:1) | ✓ | S-9 amber chips. |
| `/admin/product` | color-contrast ×4 (3.91:1) | ✓ | S-9; plan radios 22px tall (R-3). |
| `/admin/access`, `/analytics`, `/analytics/radar`, `/audit`, `/avatars`, `/billing`, `/feedback`, `/yc`, `/yc/*` | 0 | ✓ | Global issues only. `admin/yc` has no title or `loading.tsx`. |

---

## 7. Already done well (don't change)

- **Overlays:** Base UI Dialog, Sheet, Popover, Menu and Select trap focus, close on Escape, return focus, and every instance has a title. `plan-downgrade-stage` traps Tab correctly by hand.
- **Command palette:** a correct combobox with `aria-activedescendant`.
- **Toasts:** Sonner's region is `aria-live="polite"` with the Alt+T hotkey, and error toasts last 10s and are kept.
- **Icon buttons:** all `size="icon*"` buttons and 134 raw icon buttons have names, except the 640px-breakpoint cases in S-10.
- **Reduced motion:** a global CSS catch-all, `MotionConfig` in both shells, and every canvas and requestAnimationFrame loop checks the preference. Verified at runtime.
- **Dragging alternatives (SC 2.5.7):** the capture deck, notes sorter and mobile nav lens all offer non-drag paths.
- **Tables:** all wrapped in `overflow-x-auto`, and the prospect table reflows to cards on mobile.
- **No `maximum-scale`:** users can always pinch-zoom.
- **iOS input text size:** the `Input` and `Textarea` primitives already use 16px on mobile.
- **Contrast tokens:** the semantic tokens (`--success`, `--warning`, `--info`, tier and interaction colors) already clear 4.5:1 and are smoke-tested. The failures in S-9 come from opacity modifiers and external brand hexes, not from the tokens.
- **Contacts list wrapping:** truncation is correct; long, RTL and emoji names stay inside the row at 360px.

---

## 8. Scores: before and after

**Lighthouse accessibility, mobile emulation, `next dev`, demo data:**

| Page | Before | After |
|---|---|---|
| `/` | 96 | 96\* |
| `/interest` | 100 | 100 |
| `/pricing` | 99 | 100 |
| `/dashboard` | 96 | 100 |
| `/contacts` | **80** | 100 |
| `/contacts/[id]` | 92 | 100 |
| `/contacts/new` | **89** | 100 |
| `/capture` | 96 | 100\*\* |
| `/chat` | 90 | 99\*\* |
| `/graph` | 90 | 100 |
| `/reminders` | 94 | 100 |
| `/recruiters/compose` | 92 | 100 |
| `/settings` | 92 | 100 |
| `/imports` | 96 | 100 |
| `/admin` | 100 | 100 |
| `/admin/users` | 100 | 100 |

\* Lighthouse runs without reduced motion. It measures the landing page's scroll-scrubbed "How it works" captions before they have been scrolled into place, while they are still fading in, and reads them as low contrast. At their resting position they are 4.9:1. CI checks this page with reduced motion on, and it passes.
\*\* Remaining `aria-allowed-role` (minor): the mention composer is a `<textarea role="combobox">`. Strict ARIA-in-HTML allows `combobox` only on `<input>`. I kept it on purpose: dropping the role would also drop `aria-expanded`, the only way a screen reader learns the @-mention list is open.

**axe (WCAG 2.0/2.1/2.2 A+AA + best practice), same routes and widths as before:**

| | Before | After |
|---|---|---|
| 42 product and marketing routes at 360px: distinct rules | 19 | 2 (`color-contrast`, `aria-allowed-role`) |
| …routes with any violation | 38 / 42 | 4 / 42 |
| …serious or critical (route × rule) | 47 | 2: the landing page's scroll-fade (\*), counted twice because `/suspended` redirects to `/` in demo mode |
| …at 1440px: routes with any violation | 20 / 41 | 2 / 42 (both the minor `aria-allowed-role`, \*\*) |
| 26 admin routes: serious or critical (route × rule) | 11 | 0 |
| Routes with horizontal overflow at 360px | 3 (+ every long-named profile) | 0 (long-named profiles included) |

**Layout, zoom and content probes (none of these move a Lighthouse score):**

| Check | Before | After |
|---|---|---|
| Profile of a contact with a 120-character name, 360px | scroll column 1,630px too wide | 0px, name wraps |
| Arabic name and company on the profile | title and company in the wrong order | kept in order (`<bdi>`) |
| New reminder at 360×640 | Save button 100px below the fold, no scroll | fits, bottom at 635px |
| Chat at 200% zoom (640×450) | message area 0px tall | composer 40px tall, page scrolls |
| Reminders / Constellation at 200% zoom | panes collapsed | usable height, page scrolls |
| Running infinite animations with reduced motion on | 0 | 0 |
| Contact form: fields with a programmatic label | none (placeholder only) | all |
| App pages with their own `<title>` | 1 of 27 | 27 of 27 |
| First Tab on every page | the logo or the sidebar | "Skip to content" |
| Extra invisible tab stop at phone width | 29 routes | 0 |

**Test suites:**
- typecheck, lint (0 errors; the same 49 warnings as `main`) and production build all pass.
- Smoke suite: 528 of 542 pass. The 14 failures are the same 14 that fail on a clean `main` checkout in this environment. All of them need outbound network: avatar lookups, CalDAV, event and job feeds, and the sync scheduler.
- e2e: the six existing flows pass. The new `07-a11y.spec.ts` (66 tests) passes.

---

## 9. What changed

All of it went through the shared layer first: the primitives, the theme tokens and the app shell. Call sites changed only where a page did something of its own.

| Finding | Status | Fix |
|---|---|---|
| S-1 labels | **Fixed** | New `ui/field.tsx`. `Input` and `Textarea` read its context, so every control inside it gets a label, a hint and an error. The four local `Field` copies use it. The placeholder-only inputs listed in S-1 are named. `SettingsRow` can render a real `<label>`. |
| S-2 errors | **Fixed** | The reminder title shows an inline, announced error and takes focus. Waitlist errors and success are announced. Every other form that reported a failed save only as a toast now also shows it next to its button through a shared `FormError` (`role=alert`), and keeps it until the next attempt: contact form, profile (bio, socials, LinkedIn import), goals, target companies and schools, recruiter log, onboarding ratings. Validation errors (a bad social link, a refused goal or company) are inline only, mark the field invalid and focus it. `focusFirstInvalid()` is exported from `ui/field`. |
| S-3 titles | **Fixed** | Title template `%s · Orbit`. Every page has metadata, and detail pages show the record's name through the page's own cached data helper. `RouteFocus` moves focus to `#main-content` when a navigation destroyed the focused link. |
| S-4 skip link, landmarks | **Fixed** | `SkipLink` is the first thing in `<body>`. Every page has one `<main id="main-content">`. On desktop the sidebar is the page `<header>`. The ask bar, the A–Z rail, the profile's pinned summary and the landing pill are each their own landmark. Navs are labelled and the active item has `aria-current`. |
| S-5 row semantics | **Fixed** | Contact rows are a real `<Link>` stretched over the row. Admin chart rows and the admin confirm-dialog triggers are real `<button>`s; the triggers were spans that couldn't be reached by keyboard. |
| S-6 hidden tab stop | **Fixed** | `tabIndex={-1}` on the Motion `whileTap` elements, in the Capture button and the chat reminder button. |
| S-7 focus | **Fixed** | Global unlayered `:focus-visible` outline under `forced-colors`. Search bars and raw inputs use the `ui/input` ring. The constellation's zoom targets show a ring. |
| S-8 toast timing | **Fixed** | Any toast with an action stays up for at least 10s (`lib/toast.tsx`). |
| S-9 contrast | **Fixed** | `--muted-foreground-subtle` (5.2:1 on a card) replaces `/70`–`/90` text everywhere. Brand-tinted company names are clamped to 4.5:1 per theme; this departs from the plan, see below. `--destructive` darkened to 5.1:1 on its own 10% tint. Amber chips moved to amber-800. |
| S-10 hidden names | **Fixed** | `hidden sm:inline` labels became `max-sm:sr-only`. |
| S-11 ARIA one-offs | **Fixed** | Every row in the S-11 table. Wide tables are a `ScrollRegion` (tabbable only while they overflow). |
| S-12 states | **Fixed** | Page skeletons announce "Loading…" through `LoadingRegion`. There is a root `error.tsx`, and `ErrorFallback` has `role=alert` and moves focus to its heading. `not-found` has a title and a `<main>`. An empty account sees an `EmptyState` with Capture and Import, not a filters message. |
| S-13 motion | **Fixed** | One `MotionConfig` for the whole `(clerk)` group. Camera flights respect reduced motion. Glints and shimmers stop after two passes. The coming-soon scene has a pause toggle. The demo tour no longer narrates. Under reduced motion, the landing scroll visuals now pass resting values; dropping the style left Motion's last inline opacity behind, which is why captions stayed at 3.3:1. |
| S-14 keyboard | **Fixed**, with one exception | The A–Z rail is a single slider tab stop with arrow keys. Reminders shortcuts only act inside the queue. Date-picker days have full-date names. The email recipient combobox announces the highlighted suggestion (`aria-activedescendant`). The bulk-notes "Save as" choices are one named radio group. The full-screen celebration overlays still don't trap Tab (out of scope, below). |
| R-1 dialogs | **Fixed** | `DialogContent` and `PopoverContent` are capped at the viewport or the measured space, and scroll. On phones dialogs sit near the top. `vh` became `dvh`. |
| R-2 locked pages | **Fixed** | Below 500px tall the app column scrolls. Chat, the constellation and `data-fill-route` pages keep a usable height. |
| R-3 tap targets | **Fixed** | `Button` is `relative tap-target`: a 44px hit area on touch screens, with no visual change. Raw buttons under 24px are now at least 24px. Correction to the audit: the 16×16px checkboxes it flagged already had a 40×32px hit area through `::after` in the `Checkbox` primitive; the probe measured only the painted box. |
| R-4 hover reveal | **Fixed** | `pointer-fine:opacity-0` at every call site. |
| R-5 focus obscured | **Fixed** | `scroll-padding` on the app column and the admin page. |
| R-6 long and RTL content | **Fixed** | `overflow-wrap: break-word` on `body`, `wrap-anywhere` and `min-w-0` in the profile, `<bdi>` around names, companies and titles, `dir="auto"` on inputs and textareas, grapheme-safe initials. |
| R-7 admin overflow | **Fixed** | `min-w-0` on admin panels and grids, wrapping filter bars. The plan badge's sr-only suffix had been escaping the table's scroll box. |
| R-8 px text | **Fixed** | Rem-based tokens `text-3xs` (10px) and `text-2xs` (11px). The 9px text moved up to 10px. |
| X-1 iOS zoom | **Fixed** | One coarse-pointer rule sets 16px on every text field and select. |
| X-2 textarea autosize | **Fixed** | A JS fallback in `ui/textarea.tsx` where `field-sizing` is unsupported. |
| X-3 viewport | **Fixed** | Root `viewport` export with `viewport-fit=cover`. |
| X-4 `vh` on iOS | **Fixed** | Every height uses `dvh`. |
| X-5 date inputs | **Fixed** | `min-width: 0` and start-aligned value everywhere; `appearance: none` on iOS only (behind `@supports (-webkit-touch-callout: none)`), because elsewhere it can drop desktop Chrome's calendar icon. |
| X-6 clipboard | **Fixed** | Shared `copyText()`, so a success toast only shows on success. |
| X-7 / X-8 Safari scrollbars, `<summary>` marker | **Fixed** | |
| X-9 `background-attachment: fixed` | **Fixed** | The body's ambient glow is a fixed `body::before` layer. The admin console's optional YC theme still uses the property; admin is a desktop tool, so it was left. |

**Where the implementation departs from the plan:**
- **Brand colours.** The plan proposed `color-mix(… 62%, var(--foreground))`. Bright brands (Snapchat yellow) fail at any single mix, so each brand hex is instead clamped to 4.5:1 per theme with the existing `clampForContrast`. Every curated brand and 400 hashed fallbacks pass on all four card surfaces (`smoke-brand-colors`).
- **Reminders heading order.** The real cause was that the h2 above the queue was `hidden` below lg. It's now `max-lg:sr-only`, so the bucket headings stay h3.
- **Coming-soon marquee.** It gets a pause toggle, not an iteration limit, because the rings and crane in the same scene loop too.
- **Root `MotionConfig`.** It sits in the `(clerk)` layout, not the root layout. That keeps Motion out of the marketing pages' bundle; they have their own provider.

**Visible changes worth a look before merging:**
- The settings card "Integrations" is now "Connections", so it doesn't share a landmark name with the group heading it sits in.
- Small text is 1px larger where it was 9px.
- Light-mode destructive red is slightly darker.
- There is a pause toggle on coming-soon pages.
- The empty-account copy on `/contacts` has changed.
- **`scripts/legal-pages.lock.json` was re-recorded.** The only edits to `/privacy` and `/terms` are the page `<title>` (the template now adds "· Orbit") and a `ScrollRegion` around the Google-permissions table. No legal text changed. The lock exists so a person checks this, so please confirm.

**Also fixed:** constellation edge labels are 10px in rem (were 8px) at 0.6 white (were 0.32, about 3:1).

**Out of scope, not done in this PR (as agreed in the plan):**
- Tab trapping and `inert` for the full-screen celebration and credits overlays (S-14).
- Listbox semantics for reminder rows.
- An in-app "Reduce motion" setting.

**Found after the audit, still open:** on the landing page, "How it works" steps the dot hasn't reached are dimmed or invisible while on screen, and the fixed "Join the waitlist" pill covers text at the bottom on phones.

---

## CI

- **`e2e/07-a11y.spec.ts`** runs in the existing Playwright job, against the same demo server. For every page at 360px and 1280px it runs axe with WCAG 2.0, 2.1 and 2.2 A/AA rules and **fails on any serious or critical violation**. Moderate and minor findings are printed but don't fail the build. It also fails on any horizontal overflow. Four flow tests hold the audit's worst findings in place: unique page titles, the skip link as the first Tab, the New reminder form fitting a 360×640 phone, and Chat at 200% zoom.
- **`scripts/smoke-a11y-patterns.ts`** (pure tier, so it runs in the smoke job) fails on the source patterns behind the systemic findings:
  - muted text below 4.5:1
  - `vh` and `*-screen` heights
  - `role="link"` on an element that isn't a link
  - hover-only reveals
  - button names hidden below a breakpoint
  - focusable `aria-hidden` Motion elements
  - px text sizes
- **`@axe-core/playwright` 4.13.0** is a dev dependency.

---

## Fix plan (as approved)

Proposed order. Each step is one shared change, followed by its call sites.

1. **Primitives and tokens** (fixes the most in one go)
   - `ui/button.tsx`: `relative`, `tap-target` on small sizes, `outline-hidden`
   - `ui/checkbox.tsx`: tap target
   - `ui/dialog.tsx`: `max-h`, `dvh`, phone pinning
   - `ui/textarea.tsx`: autosize fallback, `dvh`, `dir="auto"`
   - `ui/input.tsx`: `dir="auto"`
   - `ui/skeleton.tsx`: `aria-hidden`
   - new `ui/field.tsx`, `ui/empty-state.tsx`, `ui/skip-link.tsx`, `ui/scroll-region.tsx`
   - `globals.css`:
     - forced-colors focus
     - coarse-pointer 16px inputs
     - `reveal-on-hover` utility
     - `overflow-wrap: anywhere`
     - date-input reset
     - `--muted-foreground-subtle`
     - `--text-2xs`
2. **Shell:** root layout (`viewport`, title template, `SkipLink`, `MotionConfig`), `app-shell` landmarks and `scroll-padding`, short-viewport unlock, `RouteFocus`, nav labels and `aria-current`, the Capture-button `tabIndex`, ask-bar `inert`.
3. **Forms:** migrate the four `Field` helpers, label the placeholder-only inputs, add `focusFirstInvalid`, and fix the waitlist and reminder errors.
4. **Pages:**
   - contacts row → stretched link, plus the A–Z rail
   - profile hero wrapping and `<bdi>`
   - per-page `metadata`
   - `max-sm:sr-only` labels
   - axe one-offs (S-11)
   - admin overflow
   - brand-color mix
   - toast durations
   - coming-soon marquee iterations
   - empty-state copy
   - graph focus and camera flights
5. **CI:**
   - Add `@axe-core/playwright` as a devDependency.
   - Add `e2e/a11y.spec.ts`. It runs in the existing `e2e` job, so no new workflow, against the same demo server. For each route at 360px and 1280px it:
     - runs axe (WCAG 2.2 AA tags) and fails on serious or critical violations
     - asserts no horizontal overflow
     - asserts every dialog fits a 360×640 viewport
     - asserts the page `<title>` is unique
     - runs one keyboard pass checking that the first Tab reaches the skip link
   - Add a small static check to the existing smoke suite (`scripts/smoke-a11y-patterns.ts`). It fails on `text-muted-foreground/[1-8]0` on text, `hidden sm:inline` inside buttons, and `opacity-0 group-hover:opacity-100` without `reveal-on-hover`.
6. **Report:** fill in the "After" columns above (Lighthouse and axe), re-run the zoom, overflow and edge-content probes, and list anything deferred.

Out of scope unless you want them: the in-app "Reduce motion" setting (S-13 alternative), migrating the full-screen celebration overlays to Base UI (S-14), and the reminders listbox semantics rework.
