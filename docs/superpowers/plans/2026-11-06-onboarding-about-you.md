# Onboarding "About you" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A skippable onboarding step that takes a LinkedIn URL and three goal taps, confirms what Orbit understood, and feeds the answers into goal-aware dashboard suggestions, purpose-led drafts, and a weekly "People to meet" card.

**Architecture:** No new tables. Answers land in stores the app already reads (`user_goals`, `career_profile`, `sender_bio`, `schools`, `target_companies`, `social_links`). Pure logic lives in `src/lib/about-you.ts` (smoke-tested with no DB). DB writes are in auth-free `src/lib/about-you-server.ts`, wrapped by server actions in `src/actions/about-you.ts`. Four PRs, in order: A step → B draft purpose → C goal-aligned card → D People to meet. B and C need nothing from A beyond data that Settings can already write, so they can run in parallel with A.

**Tech Stack:** Next.js App Router (read `node_modules/next/dist/docs/` before touching routing or server actions; see AGENTS.md), React, drizzle on neon-http / PGlite, smoke scripts run with `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-06-onboarding-about-you-design.md`

## Global Constraints

- No schema bump. If one becomes necessary, re-scan every branch for `export const SCHEMA_VERSION` first (main is 192; #518 claims 193).
- Onboarding fills only empty fields. It replaces a value only when the person edited it on the confirm screen.
- Save nothing from the self-lookup unless `match === "confident"`.
- The step never waits on the lookup: screen 2 is usable while it runs, and screen 3 works without it.
- Drafts: `intent` is a hint; `purpose` is a verbatim override, passed only when the person edited the line.
- `roleKeywords` are written only for aims `internship`, `full_time`, `switch_roles`.
- People to meet: every plan including Free; one discovery run per account per 7 days; show at most 2; render nothing until `page.find` is released (released means not coming-soon; this card does NOT check the plan).
- Every new smoke is registered in `MANIFEST` in `scripts/run-smoke.ts` with its tier (`pure` / `pglite`), or `run-smoke` exits 2.
- User-facing errors go through `UserFacingError` / `friendlyError`, never `err.message` (`smoke-toast-copy`).
- Before `npm run build` or the full suite, stop this worktree's `next dev`: PGlite is single-writer.

## Review Focus

1. **A LinkedIn URL that isn't a profile** (`linkedin.com/company/x`, `/in/` with query junk, `http://`, `www.` missing): only `/in/<slug>` URLs are accepted, saved normalized, and anything else gets a friendly inline error. Test in Task 2.
2. **A returning person with existing data** (an imported headline, a typed sender bio, schools, a target company at priority 3): confirm leaves every one of them unchanged unless edited. Test in Task 3.
3. **The lookup finishes after the person has already confirmed, or never finishes:** confirm saves what is on screen, and a late lookup result never writes. Test in Task 3 (`saveAboutYouForUser` never reads the lookup) and in Task 4's manual check.
4. **The model omits `purpose` or returns an over-long one:** the draft still returns its body, `purpose` is trimmed to one line of 140 characters or less, and an empty purpose hides the line. Test in Task 5.
5. **A discovery candidate who is already a contact, or the person themself:** neither is shown. Test in Task 9.

---

## PR A: the "About you" step

### Task 1: Step table gains `about`

**Files:**
- Modify: `src/lib/onboarding-steps.ts`
- Test: `scripts/smoke-onboarding-steps.ts`

**Interfaces:**
- Produces: `OnboardingStep` includes `"about"`; `PATH_STAGES.quick = ["welcome","about","people","connect","overview"]`, `PATH_STAGES.tour = ["welcome","about","connect","launch"]`; `STAGE_LABELS.about = "About you"`; `stageOf("about", p) === "about"`; `stepAllowedOnPath("about", p) === true` for both paths.

- [ ] **Step 1: Add the failing assertions** to `smoke-onboarding-steps.ts`:
  - `firstStep(path, facts) === "about"` for both paths and both `connectConfigured` values
  - `nextStep("about","quick",facts) === "people"`, `nextStep("about","tour",facts) === "connect"`
  - `prevStep("about", p, facts) === "welcome"`
  - `resumeStep("about", p, facts) === "about"`
  - `stageOf("about", p) === "about"`
  - `STAGE_LABELS.about === "About you"`
- [ ] **Step 2: Run** `npx tsx scripts/smoke-onboarding-steps.ts`. Expected: FAIL on `firstStep`.
- [ ] **Step 3: Implement.** Add `"about"` after `"welcome"` in `ONBOARDING_STEPS`, then to `STEP_IDS`, `PATH_STAGES` (both), `STAGE_LABELS`, the `stageOf` main-line case and `stepAllowedOnPath`'s always-true branch. Leave `RETIRED_STEPS` alone.
- [ ] **Step 4: Run** the smoke plus `npx tsc --noEmit`. Expected: PASS. tsc flags every exhaustive switch that needs the new case; fix each one.
- [ ] **Step 5: Commit** `feat(onboarding): add the About you step id to both paths`

### Task 2: Pure About-you logic

**Files:**
- Create: `src/lib/about-you.ts`
- Modify: `src/lib/career-profile.ts` (export `mergedSchools`), `src/db/schema.ts` (`CareerProfile.aim`)
- Test: `scripts/smoke-about-you.ts` (tier `pure`)

**Interfaces:**
- Produces (all in `src/lib/about-you.ts`):
  - `AIM_KINDS = ["internship","full_time","switch_roles","grow","grad_school","explore","build"] as const`; `type AimKind`
  - `TIMELINES = ["this_term","this_year","no_rush"] as const`; `type Timeline`
  - `FIELDS = ["product","software","finance","consulting","design","research"] as const`; `type Field`
  - `AIM_LABELS`, `TIMELINE_LABELS`, `FIELD_LABELS: Record<…, string>`. Copy: Internship · Full-time job · Switch roles · Grow where I am · Grad school or research · Explore a field · Build something / This term · This year · No rush / Product · Software · Finance · Consulting · Design · Research
  - `FIELD_ROLE_TITLE: Record<Field, string>` = product→"Product Manager", software→"Software Engineer", finance→"Financial Analyst", consulting→"Consultant", design→"Product Designer", research→"Research Scientist"
  - `isJobHuntingAim(kind: AimKind): boolean` (true for internship, full_time, switch_roles)
  - `parseOwnLinkedInUrl(raw: string): { ok: true; url: string; slug: string } | { ok: false; message: string }`. Reuse `linkedinSlug` (`src/lib/duplicates.ts:95`) and `canonicalLinkedInUrl` (`src/lib/linkedin-paste.ts:75`). Only `/in/` URLs.
  - `type AboutAnswers = { aim: AimKind | null; timeline: Timeline | null; field: Field | null; companies: string[]; schools: string[]; headline: string | null }`
  - `composeGoalSentence(a: AboutAnswers): string | null` (null when `aim` is null)
  - `composeSelfIntro(a: AboutAnswers): string | null` (null when nothing to say)
- `CareerProfile` gains `aim?: { kind: AimKind; timeline: Timeline | null; field: Field | null; setAt: string }`. Import the types from `about-you.ts`, or inline the string unions in schema.ts if importing would create a cycle.

- [ ] **Step 1: Write `smoke-about-you.ts`** with these assertions:
  - `parseOwnLinkedInUrl("linkedin.com/in/jane-doe-123?trk=x").ok === true`, with `slug === "jane-doe-123"`
  - `parseOwnLinkedInUrl("https://www.linkedin.com/company/stripe").ok === false`
  - `parseOwnLinkedInUrl("jane").ok === false`
  - `composeGoalSentence({aim:"internship",field:"product",companies:["Stripe","Figma"],timeline:"this_year",…}) === "Land a product internship at Stripe or Figma this year."`
  - `composeGoalSentence` with `aim:"explore"`, no field, no companies, `timeline:"no_rush"` returns a sentence with no dangling "at" and no "this …" clause
  - `composeGoalSentence({aim:null,…}) === null`
  - `composeSelfIntro({headline:"CS junior at UNC", aim:"internship", field:"product",…}) === "CS junior at UNC, aiming for product internships."`
  - `composeSelfIntro` with every field empty returns `null`
  - `isJobHuntingAim("grow") === false`, `isJobHuntingAim("switch_roles") === true`
- [ ] **Step 2: Register** the smoke as `pure` and run `npx tsx scripts/smoke-about-you.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/lib/about-you.ts`. The sentence templates are lookup tables keyed by `AimKind`. Build them from interpolations with template literals, not JSX (SWC can eat a JSX space). Export `mergedSchools` from `career-profile.ts` unchanged.
- [ ] **Step 4: Run** the smoke and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(onboarding): pure About-you answers, goal sentence and self-intro`

### Task 3: Lookup + save on the server

**Files:**
- Create: `src/lib/about-you-server.ts`, `src/actions/about-you.ts`
- Modify:
  - `src/lib/career-profile-server.ts` (`clearCareerProfile` keeps `aim`)
  - `src/lib/events/target-companies.ts` (`addTargetCompany` gets `{ ifAbsent?: boolean }`)
  - `src/lib/web-research.ts` (`listRecentResearch` drops the person's own brief)
  - `src/db/schema.ts` (the `career_profile` doc comment now names onboarding as the writer of `aim`)
- Test: `scripts/smoke-about-you-save.ts` (tier `pglite`)

**Interfaces:**
- Consumes: Task 2's `AboutAnswers`, `parseOwnLinkedInUrl`, `composeGoalSentence`, `composeSelfIntro`, `FIELD_ROLE_TITLE`, `isJobHuntingAim`, `mergedSchools`.
- Produces:
  - `type AboutPrefill = { headline: string | null; role: { title: string; company: string } | null; location: string | null; summary: string | null; schools: string[] }`
  - `type AboutLookup = { status: "confident"; prefill: AboutPrefill } | { status: "unsure" | "none" | "unavailable" }`
  - `lookUpSelfForUser(userId: string, linkedinUrl: string, opts?: { researcher?: PersonResearcher }): Promise<AboutLookup>`. Saves `social_links.linkedin`, then calls `researchPerson(userId, { fullName, linkedinUrl }, { researcher })`. `fullName` comes from `user_settings.first_name`/`last_name`; with no name the status is `"unavailable"`. A thrown error or no AI also maps to `"unavailable"`.
  - `type AboutConfirm = AboutAnswers & { goalSentence: string | null; selfIntro: string | null; edited: { headline: boolean; selfIntro: boolean }; prefill: AboutPrefill | null }`
  - `saveAboutYouForUser(userId: string, input: AboutConfirm): Promise<void>`. Writes in this order, each idempotent:
    1. `career_profile`: `profile.headline/location/summary` and `role`, by read-modify-write; empty keys only unless `edited.headline`
    2. `aim` with `setAt`
    3. `roleKeywords` append `FIELD_ROLE_TITLE[field]` only if `isJobHuntingAim`
    4. `addGoalForUser`, unless an identical active goal text exists
    5. `addTargetCompany(…, { priority: 1, ifAbsent: true })` for each company
    6. `setSchools(userId, mergedSchools(current, input.schools))`
    7. `sender_bio` = `selfIntro` only if the current bio is null or `edited.selfIntro`
  - Server actions `lookUpMyself(linkedinUrl: string): Promise<AboutLookup | { status: "invalid"; message: string }>` and `saveAboutYou(input: AboutConfirm): Promise<{ ok: true } | { ok: false; error: string }>`. Both use `requireUserId()`. Input is validated at this boundary: enums checked against Task 2's tuples, strings length-capped, companies ≤ 5, schools capped at `MAX_SCHOOLS`.

- [ ] **Step 1: Write `smoke-about-you-save.ts`**, with a fake `researcher` and seeded `user_settings`:
  - A confident fake prefills the headline and saves `social_links.linkedin` normalized.
  - An `unsure` fake returns `{status:"unsure"}` and writes nothing to `career_profile`.
  - **Returning person:** seed `career_profile.profile.headline="Imported"`, `sender_bio="Mine"`, `schools=["Duke"]`, target Stripe at priority 3. Then `saveAboutYouForUser` with headline "New" (`edited.headline=false`), selfIntro "X" (`edited.selfIntro=false`), schools ["UNC"], companies ["Stripe","Figma"]. Expect: headline "Imported", bio "Mine", schools `["Duke","UNC"]`, Stripe still priority 3, Figma priority 1.
  - Same input with `edited.headline=true` makes the headline "New".
  - Saving twice leaves exactly one goal row.
  - `aim.kind="grow"` with `field="product"` leaves `roleKeywords` unchanged; `"internship"` appends "Product Manager" once.
  - `clearCareerProfile` after a save keeps `aim` and drops `profile`.
  - After a confident lookup, `listRecentResearch(userId)` does not include the person's own brief.
- [ ] **Step 2: Register** the smoke (`pglite`) and run `npx tsx scripts/smoke-about-you-save.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`clearCareerProfile`:** `SET career_profile = CASE WHEN career_profile ? 'aim' THEN jsonb_build_object('aim', career_profile->'aim') ELSE NULL END`.
  - **`addTargetCompany` with `ifAbsent`:** `ON CONFLICT (user_id, company_id) DO NOTHING`.
  - **`listRecentResearch`:** read the user's `social_links.linkedin` slug once and drop person briefs whose `subject.linkedinUrl` slug matches it.
- [ ] **Step 4: Run** this smoke and `smoke-web-research`, `smoke-focus-fit`, `smoke-behavior-golden` (the `getSettings` golden may need re-recording only if the settings shape changed), then `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(onboarding): look up and save About-you answers`

### Task 4: The step UI and the checklist item

**Files:**
- Create: `src/components/onboarding/steps/about-step.tsx`
- Modify: `src/components/onboarding/onboarding-flow.tsx` (render on `step === "about"`), `src/components/dashboard/dashboard-sections.tsx` (setup checklist item `id: "about"`), and `e2e/helpers.ts` plus any spec that clicks through Welcome (`ensureOnboarded`, `06-guided-tour`)
- Test: `scripts/smoke-onboarding-copy.ts` (extend), `e2e/06-guided-tour.spec.ts`

**Interfaces:**
- Consumes: Task 3's `lookUpMyself`, `saveAboutYou`, `AboutLookup`, `AboutPrefill`; Task 2's label maps, `composeGoalSentence` and `composeSelfIntro` (run client-side to fill screen 3).
- Produces: `<AboutStep onNext={() => void} onSkip={() => void} pending={boolean} />`, the same props shape the sibling steps take. Read `welcome-step.tsx` / `people-step.tsx` and match them.

- [ ] **Step 1: Extend `smoke-onboarding-copy.ts`** so it covers `about-step.tsx` the same way it covers the other steps. Run it. Expected: FAIL (file missing).
- [ ] **Step 2: Build the three screens.** They live in local state inside one component, with no extra stored step ids.
  - **Screen 1:** the URL field, prefilled from settings. Submitting calls `parseOwnLinkedInUrl` (an inline error if invalid), then fires `lookUpMyself(url)` without awaiting and moves to screen 2. "I don't use LinkedIn" moves on without a lookup.
  - **Screen 2:** three chip groups. Aim and timeline are single-select; field is single-select; companies use the existing company typeahead used in Settings' target companies.
  - **Screen 3:** editable rows for headline, schools, goal sentence and self-intro. They prefill from the lookup promise when it resolves `confident`, unless that row has already been edited. `unsure`/`none` shows "We couldn't confirm this is you" above empty rows. Confirm calls `saveAboutYou`, then `onNext`. "Skip for now" on every screen calls `onSkip` without saving.
- [ ] **Step 3: Add the checklist item.** `id: "about"`, label "Tell Orbit what you're going for", href `/onboarding`, shown when the account has no active goal and no `career_profile.aim`.
- [ ] **Step 4: Update the e2e helpers** so `ensureOnboarded` passes the new step with "Skip for now". Run `E2E_PORT=3105 E2E_AI_STUB_PORT=3995 npx playwright test e2e/06-guided-tour.spec.ts`. Expected: PASS.
- [ ] **Step 5: Check it in the browser** in demo mode (`orbit-visual-preview-setup`): walk quick and tour paths at desktop and 375px, plus reduced motion. Check no control sits off-screen (`getBoundingClientRect().right > innerWidth`). Check refresh on screen 3 resumes at `about`.
- [ ] **Step 6: Run** `npx tsx scripts/smoke-onboarding-copy.ts`, `npx tsc --noEmit`, `npx eslint src/components/onboarding src/components/dashboard`. Expected: PASS, 0 errors.
- [ ] **Step 7: Commit** `feat(onboarding): About you step with LinkedIn lookup and goal taps`. Open PR A.

## PR B: drafts carry a purpose Orbit picks

### Task 5: Purpose in the draft generator

**Files:**
- Modify: `src/lib/follow-up-drafts.ts`, `src/lib/career-profile-server.ts` (export `loadUserAim(userId): Promise<CareerProfile["aim"] | null>`)
- Test: `scripts/smoke-draft-prompts.ts`, `scripts/smoke-draft-follow-up-result.ts`

**Interfaces:**
- Produces:
  - `FollowUpDraft = { body: string; purpose: string; contactId: string; contactName: string }`
  - `generateContactFollowUpDraft(userId, contactId, goals, options?: { …existing; purpose?: string | null })`
  - `generateFollowUpDraft(userId, reminderId, goals, options?: { writingInstructions?; purpose?: string | null })`
  - `normalizePurpose(raw: unknown): string`: first line only, trimmed, ≤ 140 chars, `""` when not a string.

- [ ] **Step 1: Write the failing tests.**
  - In `smoke-draft-prompts`: the system prompt asks for `{ "purpose": string, "body": string }`. The prompt contains "Going for: internship, this year" when `aim` is set. With `purpose: "Ask about the APM program"` the prompt says to use that purpose verbatim, and the result's `purpose` equals it exactly. With only `intent`, the prompt treats intent as a hint and `purpose` comes from the model.
  - In `smoke-draft-follow-up-result`: a model reply with no `purpose` key still returns the body with `purpose === ""`. `normalizePurpose("a\nb")==="a"`. `normalizePurpose("x".repeat(300)).length <= 140`.
- [ ] **Step 2: Run both smokes.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Purpose rule** (system prompt): "Pick ONE purpose: something to learn from them or one thing to ask them for, grounded in the user's goals and who this person is. State it in under 15 words."
  - **Override:** when `purpose` is given, add "The purpose of this message is: <purpose>. Use it as given." and return it verbatim.
  - **Goals block:** gains the aim line from `loadUserAim`.
  - **`generateFollowUpDraft`:** passes `purpose` through.
- [ ] **Step 4: Run** both smokes plus `smoke-follow-up-actions`, and `npx tsc --noEmit`. Expected: PASS; tsc lists every caller that must pass `purpose` through.
- [ ] **Step 5: Commit** `feat(drafts): every follow-up draft returns a purpose Orbit picks`

### Task 6: Purpose line in the draft UI

**Files:**
- Modify:
  - `src/actions/contacts.ts` (`draftContactFollowUp` accepts and forwards `purpose`; returns it)
  - `src/actions/email-compose.ts` (returns `purpose`)
  - `src/components/contacts/contact-follow-up-section.tsx` (purpose line replaces the free-text intent box)
  - the reminder-draft and compose surfaces that render a draft body: find them with `grep -rn "draftContactFollowUp\|generateFollowUpDraft\|composeEmailDraft" src/components`
- Test: `scripts/smoke-follow-up-actions.ts` (extend)

**Interfaces:**
- Consumes: Task 5's `FollowUpDraft.purpose` and `purpose` option.

- [ ] **Step 1: Extend `smoke-follow-up-actions`.** `draftContactFollowUp(id, { purpose: "Ask for intro" })` returns `purpose === "Ask for intro"`. A call without it returns a non-empty purpose from the stubbed model. Run it. Expected: FAIL.
- [ ] **Step 2: Thread `purpose`** through the two actions.
- [ ] **Step 3: Build the UI.** A one-line editable "Purpose" row above the body. It's hidden when `purpose === ""`. Editing it enables Regenerate, which calls the action with `{ purpose: edited }`. Chat's `intent: question` call (`chat-panel.tsx:2292`) stays an intent.
- [ ] **Step 4: Run** the smoke, `npx tsc --noEmit` and eslint, then check a contact's draft in the browser: the line shows, an edit regenerates, and a narrow width doesn't overflow.
- [ ] **Step 5: Commit** `feat(drafts): show and edit the purpose line`. Open PR B.

## PR C: the goal-aligned list widens

### Task 7: Target-company contacts join the "aligned with your goals" list

**Files:**
- Modify: `src/lib/dashboard-aggregates.ts` (`getGoalAlignedContactIds`), `src/lib/reminders.ts` (row mapping ~1136), `src/components/dashboard/goals-summary.tsx`
- Test: `scripts/smoke-dashboard-aggregates.ts`

**Interfaces:**
- Produces: `getGoalAlignedContactIds(userId, limit): Promise<Array<{ id: string; goalRelevance: number; reason: "target_company" | "goal"; companyName: string | null }>>`. `GoalAlignedContact` gains `reason` and `companyName`.

- [ ] **Step 1: Extend `smoke-dashboard-aggregates`.** Seed contact A at a target company (goal relevance 0), contact B with goal relevance 0.8 and no target, and contact C with neither. Expect order `[A, B]` with `reason` `"target_company"` then `"goal"`, C absent, and the limit respected. A contact that matches both appears once, as `"target_company"`. Run it. Expected: FAIL.
- [ ] **Step 2: Implement in SQL.** One ranked read: `LEFT JOIN target_companies tc ON tc.user_id = c.user_id AND tc.company_id = c.company_id`. Keep rows where `tc.id IS NOT NULL OR goalRelevance > <existing threshold>`. Order by `(tc.id IS NOT NULL) DESC, tc.priority ASC NULLS LAST, goalRelevance DESC`. Qualify every column inside `sql\`\`` (see `orbit-drizzle-unqualified-column-trap`).
  - **`ponytail:`** focus-fit stays out of this card because it's computed in JS from titles. Radar already uses it; add it here only if the card looks thin in practice.
- [ ] **Step 3: Show the reason.** Each row in `goals-summary.tsx` gets its reason, "Works at {companyName}, one of your targets" or "Matches your goals", and links to `/contacts/{id}#follow-up`. Add `id="follow-up"` to the follow-up section if it's missing.
- [ ] **Step 4: Run** the smoke plus `smoke-dashboard-parity` and `smoke-page-budgets` (the statement count must not grow), and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): goal-aligned list includes people at target companies`. Open PR C.

## PR D: People to meet (dark until Find is released)

### Task 8: Discovery query + weekly allowance

**Files:**
- Modify: `src/lib/about-you.ts`, `src/lib/rate-limit.ts`, `src/lib/surface-visibility.ts`
- Test: `scripts/smoke-about-you.ts`, `scripts/smoke-consume-bucket-args.ts`

**Interfaces:**
- Produces:
  - `buildDiscoveryQuery(input: { aim: CareerProfile["aim"] | null; companies: string[]; schools: string[] }): string | null`
  - `RATE_LIMITS.peopleToMeet = { limit: 1, windowSec: 7 * 86_400 }`, with scope label `"people-to-meet": "weekly people suggestion"`
  - `isSurfaceReleased(userId: string, surfaceKey: string): Promise<boolean>`: `!hidden.has && !comingSoon.has` from `resolveSurfaceVisibility`, with NO plan or feature check

- [ ] **Step 1: Add the failing assertions.**
  - `buildDiscoveryQuery({aim:{kind:"internship",field:"product",…}, companies:["Stripe","Figma"], schools:["UNC"]}) === "UNC alumni working in product at Stripe or Figma"`
  - With no school: `"People working in product at Stripe or Figma"`
  - No aim, no companies, no schools: `null`
  - The new scope passes `smoke-consume-bucket-args`
- [ ] **Step 2: Run** both smokes. Expected: FAIL.
- [ ] **Step 3: Implement** the three pieces. Cap companies at 3 in the query.
- [ ] **Step 4: Run** both smokes and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(people-to-meet): discovery query, weekly allowance, release-only gate`

### Task 9: Load People to meet

**Files:**
- Create: `src/lib/people-to-meet.ts`
- Modify: `src/actions/` (add `getPeopleToMeet` next to the dashboard actions; follow the file the Suggested outreach card already calls)
- Test: `scripts/smoke-people-to-meet.ts` (tier `pglite`)

**Interfaces:**
- Consumes: Task 8's three exports; `discoverPeople(userId, query, { fresh, researcher, now })`; `userCanUseAi`; `webSearchPaused`; `consumeBucket`.
- Produces:
  - `type PersonToMeet = { name: string; headline: string | null; whyMatches: string; url: string }`
  - `loadPeopleToMeet(userId: string, opts?: { now?: () => Date; researcher?: DiscoveryResearcher }): Promise<PersonToMeet[]>`. Returns `[]` on any gate failure; never throws for expected outcomes.
  - Action `getPeopleToMeet(): Promise<PersonToMeet[]>`.

- [ ] **Step 1: Write `smoke-people-to-meet.ts`**, with a fake researcher returning 4 candidates (one matches an existing contact by name+company, one is the user themself by LinkedIn slug):
  - With `page.find` coming-soon: `[]`, and the researcher is never called.
  - Released, on a Free account: 2 results, with the existing contact and the user excluded.
  - A second call within 7 days doesn't call the researcher (cache hit).
  - A call 8 days later with the bucket empty calls it once with `fresh: true`.
  - With the bucket exhausted and a stale cache: the cached results, and no call.
  - With `webSearchPaused`: `[]`.
  - `buildDiscoveryQuery` returns null: `[]`.
- [ ] **Step 2: Register the smoke** (`pglite`) and run it. Expected: FAIL.
- [ ] **Step 3: Implement.** Gate order: released → AI → not paused → query. Then read the cached run. Stale (older than 7 days) and `consumeBucket("people-to-meet", …)` succeeds → `fresh: true`. Otherwise use the cache. Filter, then take 2.
- [ ] **Step 4: Run** the smoke and `smoke-web-research`, then `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(people-to-meet): weekly new-people suggestions behind the Find release`

### Task 10: People to meet in the Suggested outreach card

**Files:**
- Modify: `src/components/dashboard/suggested-outreach-card.tsx`

**Interfaces:**
- Consumes: Task 9's `getPeopleToMeet`, `PersonToMeet`; the existing save path `saveResearchedPersonForUser` (through its existing action) and the existing person-brief action used by /find.

- [ ] **Step 1: Add the section.** "People to meet" loads on mount with `getPeopleToMeet()`, client-side, never in the server render. It renders nothing when the result is empty. Each row shows name, headline, `whyMatches` and a link, plus **Save** and **Brief** buttons that use the existing /find actions.
- [ ] **Step 2: Run** `npx tsc --noEmit` and eslint. Then, in the browser, use an admin preview cookie with `page.find` previewed and the fake-AI stub. Check: the dashboard paints before the section, empty hides it, Save creates a contact, and 375px fits.
- [ ] **Step 3: Commit** `feat(dashboard): People to meet section`. Open PR D, and say in the PR body that it stays dark until Jason releases Find people (privacy update + TERMS bump).

### Task 11: Whole-branch check

- [ ] Stop `next dev`, then run `npm run typecheck`, `npm run lint` and `npm test`. Expected: 0 tsc errors, 0 eslint errors; smoke failures limited to the known main baseline (`smoke-growth-trends`, `smoke-shared-avatar-upkeep`). Re-run any other failure alone before calling it a flake.
- [ ] `npm run build`. Expected: success.
- [ ] Record in each PR body what was NOT verified live: a real-AI self-lookup on a real LinkedIn URL, and People to meet on a real released `page.find`.
