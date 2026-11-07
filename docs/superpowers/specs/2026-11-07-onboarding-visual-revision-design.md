# Onboarding visual revision: simpler, Orbit-branded, no scrolling

Status: design from conversation, Nov 7 2026. Builds on PR #520 (the About you step), same branch.
Mockups (local, git-ignored): `.superpowers/brainstorm/82467-1794013433/content/` —
`goals-screen.html` (option **A** chosen), `onboarding-flow.html` (all eight pages),
`marks.html` (mark **A** chosen).

## Why

Jason looked at the new "What are you going for?" and "Here's what Orbit understood" screens and
asked for them to be simpler, with icons, better spacing, more Orbit branding, and **no
scrolling**. He then asked for the same treatment across the whole onboarding flow.

## Jason's decisions

1. **Layout direction A ("icon tiles")** for the goals screen, and that style for every
   onboarding page: icon tiles for single big choices, icon chips for short lists, a
   three-way segmented switch for "When", one card per choice elsewhere.
2. **"When" options:** *As soon as possible · In the next year · In the future*
   (replacing This term · This year · No rush).
3. **Confirm screen:** "What you do now" becomes **"Your major(s)"**.
4. **More Orbit branding** across the flow.
5. **A new animated mark**, not "a circle and a dot": **mark A, the ringed planet**. A teal
   planet with a tilted gold ring; a small gold moon rides the ring. It spins.
6. **Path cards show how long each path takes**, and the two are different.
7. **No page scrolls** at a normal laptop viewport.

## Goals

- Every onboarding page fits in one viewport with no scrolling at 1280×720 and above (the
  baseline laptop size). Phones (375px) may scroll, but nothing overflows sideways.
- One visual system across all eight pages (see mockup `onboarding-flow.html`):
  - **Header:** the mark plus the "Orbit" wordmark on Welcome. Every other page gets a Back link
    and a **named stepper**: dots, the current stage as a pill, gold for done stages.
  - **Eyebrow:** the small mark plus the stage label ("About you · 2 of 3").
  - **Type:** a Fraunces heading in teal, then a one-line description in muted text.
  - **Icons:** every choice carries a lucide icon. Teal on light; gold on the selected teal fill.
  - **Footer:** pinned to the bottom of the stage. "Skip for now" on the left, the main button
    on the right.
  - **Background:** a faint gold glow in the top-right plus a few still star dots (CSS only, no
    canvas).
- The mark exists as one reusable component and replaces the invented ring mark used in the
  mockups.

## Non-goals

- No change to steps, step order, saving rules, or anything PR #520's data layer does. This is
  presentation, plus three copy/label changes (When, majors, time estimates).
- No change to the app's logo (`OrbitLogo`, the blue constellation disc). The new mark is
  onboarding's motif. The app logo stays where it is today.
- No new illustration assets or animation libraries. SVG plus CSS/SMIL only.
- Dark mode gets the same layout with the existing dark tokens; no new dark palette.

## Anti-goals

- **Scroll creeping back in.** A screen that only fits because type was shrunk below
  readability. Body text stays at 13px or more, labels at 12px or more, and tap targets at
  36px or more.
- **Motion that nags.** The mark loops slowly: one moon lap takes about 5s, and the planet
  itself never moves. It is still under `prefers-reduced-motion` (the repo's one global
  mechanism, per the design-language memory). Nothing else animates beyond the existing step
  transitions.
- **Icons as decoration only.** Every icon pairs with a visible text label. Icons are
  `aria-hidden`.

## Page by page (copy as in the mockup unless noted)

1. **Welcome.** The mark at hero size (about 64–72px), "Welcome to Orbit", one line of
   description. Two path cards:
   - Guided tour: compass icon, "Recommended" tag, primary button.
   - Quick setup: lightning icon, ghost button.

   Each card shows its time:
   - **Quick setup: "About 2 minutes."**
   - **Guided tour: "About 5 minutes."**

   *Claude's estimate.* The tour itself is three minutes, plus About you and accounts.

   The terms checkbox sits under the cards.
2. **About you · 1 of 3 — LinkedIn.**
   - A card with the URL field (LinkedIn icon) plus Continue and "I don't use LinkedIn".
   - Below it, two icon notes: "What Orbit reads" and "You approve it".
3. **About you · 2 of 3 — goals.** Direction A:
   - **Your aim:** a 4-column grid of icon tiles.
     - Internship (backpack), Full-time job (briefcase), Switch roles (shuffle).
     - Grow where I am (sprout), Grad school or research (graduation cap).
     - Explore a field (compass), Build something (rocket).
   - **Field:** icon chips.
     - Product (layout grid), Software (code), Finance (line chart).
     - Consulting (presentation), Design (palette), Research (flask).
     - Disabled until an aim is picked, as today.
   - **Dream companies:** a pill input with a building icon, chips inline, "up to 5".
   - **When:** a segmented switch with As soon as possible (lightning), In the next year
     (calendar), In the future (telescope).
4. **About you · 3 of 3 — confirm.**
   - A gold note when the lookup was confident ("Found you on LinkedIn…"). Otherwise the
     existing "couldn't confirm" line, in the same note style.
   - One card:
     - **Your major(s)** (book icon) and **School** (landmark icon) side by side.
     - **Your goal** (target icon), full width.
     - **How Orbit introduces you** (quote icon), full width, with its hint.
5. **Your people** (quick setup): three icon cards (sparkles, user-plus, upload). The
   recommended one is outlined in teal.
6. **Your accounts:** Google and Microsoft rows, each with an icon, a one-line description and a
   Connect button. Then "What you get" chips.
7. **What Orbit does** (quick setup ends here): one feature card at a time, with a large icon,
   Fraunces title, description, preview area, dots and arrows. The **first** chapter becomes
   "People who fit your goal" (new chapter in `highlights/chapters.ts`). *Claude's call; Jason
   can drop it.*
8. **Setting the stage** (the tour ends here): the mark at hero size, animated, plus a
   three-line checklist.

## Data and copy changes

- **When labels.** Keep the stored ids `this_term | this_year | no_rush`, so saved
  `career_profile.aim.timeline` values stay valid. Change only `TIMELINE_LABELS` and the
  goal-sentence clause:
  - this_term → "As soon as possible" / "as soon as possible"
  - this_year → "In the next year" / "in the next year"
  - no_rush → "In the future" / no time clause
  - *Claude's call*: avoids a data migration for a wording change.
- **Majors.** The confirm screen's first row becomes "Your major(s)".
  - Store as a new optional `career_profile.majors?: string[]` (a jsonb key, no DDL).
    Comma-separated in the input, capped at 3, each line length-capped like schools.
  - The self-lookup prefills majors only if the web result carries a field of study (check
    `IncomingExperience` / `PersonDossier`); otherwise the row starts empty.
  - The lookup's headline is still saved by the existing fill-empty rule, but it's no longer
    shown. *Claude's call*: Jason renamed the row, and he didn't ask to drop the headline data.
  - `composeSelfIntro` uses majors plus school when present ("CS and Econ student at UNC, aiming
    for software internships."), falling back to today's headline logic.
  - The fill-only-empty and `edited` rules apply to majors exactly as they did to headline.
  - **Open (Jason):** for aims like "Grow where I am", the row still says "Your major(s)". See
    below.

## Constraints

- Next.js in this repo differs from training data: read `node_modules/next/dist/docs/`
  before touching routing.
- Use the existing tokens in `src/app/globals.css` (teal primary, gold accent, Fraunces and
  Outfit) and `lucide-react`. No new dependencies.
- **Layout traps from the onboarding memory:**
  - `min-w-0` on grid/flex children holding chip strips, or controls get pushed off-screen
    under `overflow-x-clip`.
  - `.liquid-glass` is unlayered and position-relative: put it on an inner element.
  - `MotionConfig reducedMotion="user"` makes transforms instant: pass travel 0 for exits.
- **Fitting without scrolling:** the stage is a column with the footer pinned (`mt-auto`). If
  content can exceed the viewport (long company lists, error lines), the middle region
  scrolls, never the whole page. Verify at 1280×720, 1440×900 and 375×812.
- The e2e specs (`01-onboarding`, `06-guided-tour`) and `smoke-onboarding-copy` pin copy and
  labels. Update them.

## Left to the builder

- Exact spacing values and breakpoints, as long as the no-scroll goal holds at 1280×720.
- How the mark's SVG is split for the moon (SMIL `animateMotion` or CSS offset-path).
- Icon choices beyond those named above.
- Whether the feature-preview area in "What Orbit does" reuses `highlights/previews.tsx` as is.

## Rulings after the builder check (Claude's calls, Nov 7; Jason said "implement")

1. **Header ownership.** The shell keeps the one header for every step. It gets the new mark,
   the "Orbit" wordmark and the restyled stepper. The header's "Skip setup" (which leaves
   onboarding) stays as quiet text on the right. Steps keep their own Back button and their own
   footer. "Skip for now" (advance one step) stays in each step's pinned footer where it exists
   today. These are two different actions, and both survive.
2. **Launch.** Behaviour is unchanged: it auto-runs, holds, then redirects, with no Back and no
   button. Only the visuals change: the mark at hero size replaces the ring and logo, and the
   existing status lines are restyled. The mockup's button and checklist are not built.
3. **Branch steps** (import, capture, manual, triage, failed launch) get the shared chrome
   (heading, eyebrow, footer styling) through the shared components. They may scroll inside
   their middle region; the no-scroll goal covers the eight main pages only.
4. **Stepper.** `OnboardingProgress` is restyled, not rewritten. Same stages logic and
   `layoutId`. Done stages turn gold, the current one shows as a pill with the stage label, and
   the rest are muted dots. The About sub-step ("· 2 of 3") lives only in the eyebrow.
5. **"People who fit your goals" chapter.** Static copy, not personalised. No company names; it
   reads the same for people who skipped About. It reuses an existing preview, or a simple
   icon preview. Existing chapters keep their bullets and tags. It goes first.
6. **Majors.**
   - One comma-separated input, stored as `career_profile.majors: string[]` (at most 3).
   - Prefill from the `fieldOfStudy` of the most recent education experience in a confident
     lookup. `lookUpSelfForUser` already reads experiences.
   - `AboutAnswers` gains `majors: string[]`, and `edited` gains `majors`. Same
     fill-only-empty rule.
   - The self-intro uses the raw strings: "{majors joined with ' and '} student at {school},
     aiming for …". It falls back to today's headline wording when there are no majors.
   - **Non-students** (aims full_time, switch_roles, grow): the row is labelled "What you do
     now" and keeps writing the headline exactly as today. *Confirmed by Jason, Nov 7.*
7. **Timeline relabel** applies everywhere `TIMELINE_LABELS` is used, drafts included (same
   meaning, new words). Re-record the draft-prompt goldens.
8. **Mark animation.** CSS only: rotate an inner group placed inside a squashed, tilted outer
   group, so the moon travels an ellipse. The global reduced-motion clamp then stops it, so no
   SMIL. The component is named `OnboardingMark`, since `OrbitMark` already exists in chat.
9. **OrbitLogo.** Replaced by `OnboardingMark` inside onboarding only (header, Welcome hero,
   Launch hero). The app logo elsewhere is unchanged.
10. **Welcome footer** "About a minute either way" is dropped. The cards carry the times.
11. **Viewport floor:** no scrolling at 1280×720 and 1366×768, measured with the shell header
    included.
12. **Time estimates:** Quick setup "About 2 minutes", Guided tour "About 5 minutes".
