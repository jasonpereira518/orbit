# Onboarding "About you": LinkedIn URL + goals that steer the app

Status: design, approved in conversation Nov 6 2026. Plan to follow in
`docs/superpowers/plans/2026-11-06-onboarding-about-you.md`.

## Why

Orbit's engine already knows how to use "who you are and what you're going for", but the product
never asks for it:

- `user_goals` (free text) already steers chat, contact briefs (`goal_fit`), closeness, Radar
  drafts, meeting talking points and follow-up drafts, but it can only be set in Settings.
- `user_settings.career_profile` (headline, role, skills, job-alert titles) feeds `focus-fit.ts`
  scoring in Radar and Events, but only the LinkedIn export fills it.
- `user_settings.sender_bio` already shapes every follow-up draft (`senderProfileBlock`), and
  almost nobody fills it.
- Onboarding (`welcome → people → connect → overview` / `welcome → connect → launch`) asks
  nothing about the person.

The student strategy doc (`docs/strategy/2026-11-05-orbit-for-students.md`, call #2) proposed a
goal step in onboarding. Jason's answer is yes, plus a LinkedIn URL that Orbit researches.

**What the person should notice right after the step (Jason's words, paraphrased):**
1. Orbit suggests people related to their goals, both people they already know and **new
   people** they don't know yet.
2. Outreach and follow-up drafts are written for a purpose: to *learn* from someone or to *ask*
   them for something, and that purpose is chosen by Orbit.

## Goals

- One short, skippable onboarding step on both paths that collects a LinkedIn URL and 3 taps
  about goals, then shows "here's what Orbit understood" for the person to confirm or edit.
- Confirmed answers land in the stores the app already reads (no parallel "profile" concept).
- Dashboard suggestions become goal-aware: known people who fit the goal, plus 1–2 new people a
  week.
- Every follow-up draft carries a purpose line Orbit picks; the person can change it and the
  draft rewrites around it.

## Non-goals

- No new profile page. Settings already edits goals, schools, social links and sender bio.
- No LinkedIn scraping or OAuth. The URL is an anchor for the existing web-search research.
- Releasing Radar, Find people, Outreach or Events. This work must be useful with all of them
  still coming-soon; the new-people half stays dark until `page.find` is released (Jason's call).
- Semester re-prompting, student pricing, `.edu` gating (separate strategy calls).

## Anti-goals (failure even if it "works")

- **A stranger's career written onto the user.** Namesake risk is the one real danger of the
  self-lookup. Anything short of a confident match saves nothing.
- **Onboarding waits on a 20-second web search.** The lookup runs while the person answers the
  taps; the confirm screen fills in when it lands, and works without it.
- **A form.** At most: one URL field, three tap groups, one confirm screen. No typing required
  except the optional URL.
- **Padded suggestions.** Two good cards beat seven weak ones (Radar's rule). A goal-fit
  suggestion needs a real reason (target company, matching role or field), not token overlap.
- **Overwriting what the person typed or imported.** Onboarding fills empty fields; it only
  replaces a value when the person edits it on the confirm screen.

## The step

**Placement.** New step id `about` (stage label "About you"), right after `welcome` on BOTH
paths:
- quick: `welcome → about → people → connect → overview`
- tour: `welcome → about → connect → launch`

Skippable ("Skip for now"). Skipping, or finishing without a goal, adds an item to the dashboard
"Finish setting up" checklist card. Resume rules follow the existing step table
(`src/lib/onboarding-steps.ts`): add `about` to `ONBOARDING_STEPS`, `STEP_IDS`, `PATH_STAGES`,
`STAGE_LABELS`, `stageOf`, `stepAllowedOnPath`.

**Screen 1: LinkedIn URL (optional).**
- Accept only `linkedin.com/in/<slug>` (reuse the existing slug parsing used for contacts'
  `linkedin_url`). Prefill from `user_settings.social_links.linkedin` when set.
- On submit, save the URL to `social_links.linkedin` and kick off the self-lookup in the
  background, then go straight to screen 2.
- No URL: skip the lookup; everything else still works.

**Self-lookup.** Reuse `researchPerson` (`src/lib/web-research.ts`) with the person's own name
(`user_settings.first_name` / `last_name`, mirrored from Clerk) and the URL as the anchor. Same
caching, rate limits and AI gate (`userCanUseAi`). Result `match`:
- `confident` → prefill screen 3 from `headline`, `current`, `location`, `summary`,
  `experiences` (schools among them, if the shape carries education).
- `unsure` / `none` / no AI / error → screen 3 says "We couldn't confirm this is you" and shows
  empty editable fields. Nothing from the lookup is saved.
- Side effects to handle: the self-brief is cached like any person brief, so it would show in
  /find's "Recent" list (`listRecentResearch`). Filter the user's own brief out of that list. It
  also spends one of the day's research lookups (`RATE_LIMITS`); that's acceptable.

**Screen 2: three tap groups.**
1. *What you're going for* (one): Internship · Full-time job · Switch roles · Grow where I am ·
   Grad school or research · Explore a field · Build something.
2. *Field or companies*: chips for a field (e.g. Product, Software, Finance, Consulting,
   Design, Research) plus a company typeahead (existing company lookup). Optional.
3. *When*: This term · This year · No rush.

**Screen 3: "Here's what Orbit understood."** One card, every line editable:
- Headline / what you do now (from the lookup or blank)
- School(s)
- One goal sentence Orbit composes from the taps (deterministic template, no model call), e.g.
  "Land a product internship at Stripe or Figma this year."
- A one-line self-intro for drafts, composed from the above (deterministic), e.g. "CS junior at
  UNC aiming for product internships."

Confirm writes (one server action; the writes run in sequence and each is idempotent, so a
retry after a partial failure is safe. Not `runAtomicWrite`: the existing helpers each run their
own queries):

| Answer | Store | Rule |
|---|---|---|
| LinkedIn URL | `user_settings.social_links.linkedin` | written on screen 1 |
| Headline, role, location, summary | `career_profile.profile` / `.role` | only when that key is empty (read-modify-write: `saveCareerPatch` merges top-level keys only, and `role` needs both title and company). A later LinkedIn export import overwrites them; the export is the better source |
| Field chip | `career_profile.roleKeywords` | **only for job-hunting aims** (Internship, Full-time, Switch roles), mapped to a real title ("Product" → "Product Manager"). `roleKeywords` turns on focus-fit's recruiter boost, which is only right for someone job-hunting |
| Aim + timeline + field | `career_profile.aim = { kind, timeline, field, setAt }` | new optional jsonb key, no DDL. Owned by onboarding: `saveCareerPatch` never writes it, and `clearCareerProfile` (the export's "remove") must keep it; update the column's doc comment in `schema.ts`, which today says imports are the only writer |
| Goal sentence | one `user_goals` row | via `addGoalForUser`; skip if an identical active goal exists |
| Companies | `target_companies` (priority 1) | insert only when missing. `addTargetCompany` upserts and would overwrite an existing row's priority, so it needs an insert-if-absent option |
| Schools | `user_settings.schools` | merged, never replaced. `setSchools` replaces the list, so export `mergedSchools` from `career-profile.ts` and merge before saving |
| Self-intro | `user_settings.sender_bio` | only if empty, or the person edited it |

**No schema bump expected.** Every store exists; `aim` is a new optional key on the
`career_profile` jsonb type. If the builder finds a DDL need, claim the next free
`SCHEMA_VERSION` after re-scanning branches (main is 192; #518 claims 193).

## What changes downstream

### 1. Draft purpose (Orbit picks)
`generateContactFollowUpDraft` / `src/lib/follow-up-drafts.ts`:
- The model returns `{ purpose, body }`. `purpose` is one short line: the specific *learn* or
  *ask* this message is for, chosen from the person's goals + aim, the contact's role/company,
  and whether the contact works at a target company. E.g. "Ask for a 15-minute chat about the
  APM program" or "Learn how they moved from consulting into product".
- Two inputs, kept apart (Claude's call):
  - `intent` stays a **hint**. Radar (`draftIntent(target)`), the related-reach-out prefill and
    chat already pass one, and the model still picks the purpose with it in mind.
  - A new `purpose` option is an **override**, passed only when the person edited the purpose
    line. It's used verbatim.
- Every draft path returns a purpose, including reminder drafts (`generateFollowUpDraft`, which
  takes no intent today). Radar's stored `RadarDraft` keeps the body only for now; storing the
  purpose waits until Radar is released.
- Draft UI (`src/components/contacts/contact-follow-up-section.tsx`, and the other draft
  surfaces that show a body) shows the purpose line above the draft in place of today's
  free-text intent box. Editing it and pressing Regenerate re-drafts with it as `purpose`.
- The goal block also gets `career_profile.aim` when set ("Going for: internship, this year").
- Existing draft caching keys on the prompt, so the purpose change is a cache miss by
  construction.

### 2. Known people who fit the goal (dashboard)
The dashboard already has an "aligned with your goals" list (`goalAlignedContacts` in
`src/lib/reminders.ts`, top 5 by the stored `goalRelevance` closeness component). **Claude's
call: widen that list instead of adding a second `goal_fit` suggestion type,** so the same person
never appears in two cards.
- Add contacts at a target company to its candidates. Keep the cap of 5, ranked target company
  first (by its priority), then goal relevance. Focus fit stays out: it's computed in JS from
  titles, so it can't join this SQL-ranked read cheaply. Radar already uses it. Add it here only
  if the card looks thin in practice.
- Each row names its reason ("Works at Stripe, one of your targets"; "Matches your goal: …").
- Clicking a row opens the contact's draft, where the purpose line takes over.
- Keep the read SQL-ranked like `getGoalAlignedContactIds` (no pass over every contact in JS).

### 3. New people (dashboard, dark until Find is released)
A "People to meet" section in the Suggested outreach card:
- Query built deterministically from aim + field + target companies + schools, e.g.
  "UNC alumni working in product at Stripe or Figma". No model call to build it.
- Calls `discoverPeople`. Show at most 2 candidates with their `whyMatches` line and a link;
  "Save" uses the existing `saveResearchedPersonForUser` path; "Brief" uses the existing person
  brief.
- Loaded client-side after the dashboard renders, never on the server render path (a web
  search can take 20s).
- Weekly freshness: reuse `discoverPeople`'s cache; ask `fresh` only when the cached result is
  older than 7 days and the weekly bucket has room. Candidates already in contacts are dropped
  by name+company.
- **Every plan, Free included (Jason, Nov 6), on a small allowance.** `page.find`'s plan
  feature `findPeople` is off on Free (`src/lib/plans/plan-config.ts:177`), so this card must
  NOT use `requireReleasedSurface`, which also checks the plan. Its gate:
  - `page.find` is released, meaning not coming-soon (the release check alone, without the plan
    check; Find's release carries the privacy update this needs), and
  - `userCanUseAi`, and Orbit's pool web search isn't paused (`webSearchPaused`).
- Allowance: a new bucket `peopleToMeet: { limit: 1, windowSec: 7 * 86_400 }` in `RATE_LIMITS`,
  so each account gets one discovery run a week. It also counts against `webResearch`. Register
  the scope label (`smoke-consume-bucket-args` checks them). One run returns up to 10
  candidates; the card shows the top 2 not already in contacts, and nothing more until next
  week. Paid plans get more through /find itself, not this card.
- Until Find people is released, this section never renders.

### 4. Free improvements, no new work
Chat, contact briefs, meeting talking points, Radar drafts and Events relevance already read
`user_goals` / `career_profile` / `sender_bio`, so they improve as soon as the step writes them.

## Calls that are Jason's (not decided here)

1. **Find people release** (`page.find`): needs the privacy-copy update + TERMS bump already owed
   for Outreach v3. The new-people half depends on it.
2. **Privacy copy for the self-lookup:** the person's own name + LinkedIn URL go to the AI
   provider's web search. Does `/privacy` already cover this under contact research, or does it
   need a line (which moves `legal-pages.lock.json` and possibly `TERMS_VERSION`)?
3. **Tap options**: the aim list and field chips above are Claude's guess; Jason may reword.

## Left to the builder

- Exact copy, layout and motion of the three screens (follow the existing onboarding step
  components and design language).
- Thresholds for `goal_fit` (focus-fit cutoff) and how the purpose line is rendered on each
  draft surface.
- Whether `IncomingExperience` carries schools, and if so mapping them to `schools`.
- How the Finish-setting-up item is worded.

## How we'll know it works

- A new account that finishes the step sees at least one goal-linked suggestion on its first
  dashboard visit whenever any contact works at a target company.
- Every follow-up draft shows a purpose line; most people never edit it.
- Step completion time under 60 seconds, with no wait on the lookup.
