# Sprint C — audience features

**Date:** 2026-10-11 · **Source:** `docs/audits/2026-10-08-app-e2e-audit.md` §5, §6, §8 Sprint C · **Base:** `main` @ `0019603d` (Sprints A #412 and B #413 merged)

## Goal

A student or new grad can follow up within a day or two of meeting someone, in one tap, with the right kind of message. Anyone can say "keep in touch monthly" and have Orbit actually hold them to it. Alumni and target-company contacts are one filter away. Orbit knows what the person is looking for. Every relationship score in the app means one thing and has one name.

## Decisions (made with Jason, Oct 11)

1. **Scope:**
   - In: follow-up presets and intents, cadence and tier defaults, alumni/target filters, profile fields, and score vocabulary.
   - Out: the recruiter pipeline, and Sprint D integrations.
2. **Presets.** One shared set: **1 day, 2 days, Next business day 9 am, Next business week (Monday) 9 am, 2 weeks**, used by every follow-up/snooze quick choice.
3. **Cadence.** A contact with a cadence becomes **due when it lapses**, whatever their score.
4. **Tier defaults are fixed, not a setting:** Inner orbit monthly, Mid orbit quarterly, Outer orbit none. A contact's own cadence always wins.
5. **Profile fields** (target role, graduation year, search status) feed **Radar/Goals ranking** and **follow-up drafts**. They are not asked for in onboarding.
6. **Intent chips:** Thank you, Referral ask, Informational chat, Keep me in mind.
7. **Score vocabulary:** **Strength** is the 1–5 rating, **Closeness** the computed %, **Orbit** the Inner/Mid/Outer tier, and **Health** stays. Graph rings get their own names so "Inner orbit" means one thing.

## Scope

### C1 — One set of follow-up presets

- **New pure module** `src/lib/follow-up-presets.ts`:
  - `FOLLOW_UP_PRESETS`, in this order: `1d`, `2d`, `next-business-day`, `next-business-week`, `2w`.
  - Labels: "1 day", "2 days", "Next business day", "Next week", "2 weeks". Short labels for tight rows: "1d", "2d", "Next day", "Next wk", "2w".
  - `resolvePreset(id, now: Date, timeZone: string): Date`.
- **Rules**, with business days Mon–Fri and no holidays:
  - `1d` / `2d` / `2w`: `now` plus N calendar days, at the same local time of day (today's convention).
  - `next-business-day`: the next weekday after today, at 09:00 local. On Friday, Saturday or Sunday that is Monday.
  - `next-business-week`: the Monday of next week at 09:00 local. On a Sunday that is tomorrow's Monday, which counts as next week. On a Monday it is 7 days later.
- **Resolution happens client-side** in the browser's time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Server actions receive an absolute ISO date.
- **Server validation:** a shared `validateFollowUpDate(iso, now)` accepts a date strictly in the future and at most 366 days ahead, and refuses anything else with friendly copy.
- **Surfaces switched to it.** Each keeps its current place and styling:
  - Contact page "Remind" chips (`contact-follow-up-section.tsx` `REMIND_PRESETS`).
  - "Remind in" chips (`easy-follow-up.tsx` `PRESETS`: contacts list, graph inspect panel, dashboard due rows). Tight rows may show the first four.
  - Radar's schedule menu: `SCHEDULE_DAYS` in `lib/radar/actions-core.ts` and the `actions/radar.ts` validation. The schedule action now takes a date.
  - The bell's snooze (`notifications-panel.tsx`, today a fixed 7 days). It becomes a small menu of the presets.
- **Unchanged:** Radar's own snooze ("1 week / 1 month" of a recommendation) and the Reminders page's calendar snooze menu (tomorrow / weekend / next Monday). Both mean something different.

### C2 — Follow-up intents

- **The intent field always shows** in the contact page "Draft for" section and in the follow-up draft sheet. Today it renders only when an intent is already set.
- **Four one-tap chips above it:** Thank you, Referral ask, Informational chat, Keep me in mind. A chip fills the field with an editable instruction and starts a draft. The instruction copy:
  - Thank you: "Thank them for their time and mention one specific thing from our conversation"
  - Referral ask: "Ask if they’d be open to referring me for a role on their team, and offer to send my resume"
  - Informational chat: "Ask for 20 minutes to hear about their path and their team"
  - Keep me in mind: "A short, warm note to stay in touch and ask them to keep me in mind for future roles"
- **Unchanged:** Radar's automatic intents still prefill (`draftIntent(rec)`). The free-text field keeps working, and the draft call is unchanged (`intent` already flows through `draftContactFollowUp`).

### C3 — Cadence that works

- **Fix audit C5.** The contact page passes the saved `cadence_days` into the follow-up section, so the "Keep in touch" control shows it after a reload. A note-derived `cadence_phrase` displays as its phrase ("every two weeks").
- **Show the cadence.**
  - Contact page: next to Keep in touch, "Monthly", or "Monthly (Inner orbit default)" when the tier default applies.
  - Contacts list row: a small tag ("Monthly", "Quarterly", "Every 2 weeks"), with the device switch as `md:` classes. Phones show it on the contact page only.
- **Effective cadence.** One pure function `effectiveCadenceDays(contact)` in `src/lib/keep-in-touch.ts`:
  - It returns `cadence_days` when set, otherwise `TIER_DEFAULT_CADENCE[closeness_tier]`.
  - `TIER_DEFAULT_CADENCE = { inner: 30, mid: 90, outer: null }`.
  - A matching SQL expression for queries lives next to the existing contact query helpers. One definition is used everywhere.
  - Remove or replace the dead `keepInTouchDue` / `keepInTouchDescription` / `cadenceLabel` helpers rather than adding parallel ones.
- **A lapsed cadence counts as due.** A contact is cadence-due when its effective cadence is set, the last interaction (or `date_met` / creation when there is none) plus the cadence is now or earlier, and it has no pending follow-up reminder dated in the future. Cadence-due contacts appear in:
  - Dashboard "Due follow-ups" (count and rows), labelled "Keep in touch · monthly".
  - Contacts filter "Follow-up due" (`followUp=due`).
  - Radar's quiet/dormancy reason. The `isHighValue` gate in `lib/radar/score.ts` and `dormantHighValue` in `lib/reminders.ts` stop being required when an effective cadence exists. Contacts with no effective cadence keep today's behaviour.
- **One rule, not a double count.** Marking a cadence-due contact done, or logging an interaction, moves the last-touch date, so it stops being due. A cadence-due contact that also has a due follow-up reminder appears once. This is the same dedupe rule as Sprint A R2.

### C4 — Alumni and target filters

- **Two new Contacts filters**, as URL params on the existing filter bar (`contacts-filters.tsx`, `lib/contacts-page-query.ts`):
  - `alumni=1`: `contacts.school` matches one of `user_settings.schools`, through the existing normalizer in `src/lib/school-name.ts` (one normalizer; the events-only `schoolKeys` is left alone).
  - `targets=1`: the contact's company matches one of the user's `target_companies`.
  - The two combine with AND, which gives "alumni at my target companies".
  - When the user has no schools or no targets saved, each toggle is disabled with a hint linking to Settings → Goals and targets.
- **Radar reason** "Went to {school} too", a small weight, for alumni. Radar loads the user's schools once per run, the way it loads target companies.

### C5 — You: target role, graduation year, search status

- **Three `user_settings` columns:**
  - `target_role` text, up to 120 chars.
  - `graduation_year` int (nullable, 1950–2100).
  - `search_status` text: `not_looking` | `open` | `active`, nullable meaning not set.
- **Schema version 153.** Before bumping, scan every remote ref and every worktree for the highest claimed version. As of Oct 11, remotes top out at 151 and the unpushed calendar-events-p0 worktree holds 152. The column follows the three-place pattern:
  1. the CREATE TABLE template;
  2. the `alters` list;
  3. `ensureColumn` in `migratePglite`.

  Add the Drizzle columns and a changelog line.
- **Settings → Profile** adds "Target role", "Graduation year" and "Search status" under About you, saved like `saveSenderBio`. They are content, so the data export includes them and the "preferences" purge treats them like `sender_bio`; follow how `sender_bio` is classified.
- **Radar and Goals:**
  - `target_role` joins the focus signal (`loadUserFocus` → `focusFit`) as a role keyword.
  - When `search_status = active`, recruiters and alumni at target companies get a ranking boost, through the existing `targetPriority` and the new alumni reason.
- **Drafts.** `follow-up-drafts.ts` adds one "about the sender" line when any field is set, for example "Graduating in 2027; looking for new-grad software engineering roles; actively looking". The existing bio stays.

### C6 — One score vocabulary

- **Strength** is the 1–5 rating (`relationship_score`).
  - The Contacts filter labelled "Closeness" (`contacts-filters.tsx` `CLOSENESS_OPTIONS`) becomes "Strength", and its param stays `minScore`.
  - The capture control keeps its level names (Barely know … Mentor / advocate) under the heading "Strength".
- **Closeness** is the computed % (unchanged).
- **Orbit** is the Inner/Mid/Outer tier. The dashboard's "Relationship strength: Close / Warm / Cool" (`network-depth-chart.tsx`) becomes "Orbit: Inner / Mid / Outer".
- **Graph rings** (`lib/graph-layout.ts`, the `network-graph.tsx` filter) become **Core / Close / Middle / Far / Deep space**. No "orbit" wording, so it no longer collides with the tier.
- **Health** is unchanged.
- **Tooltips and explainers** that name these scores use the same words (`contacts-list.tsx` `TIER_TOOLTIP` and the closeness tooltip, `contact-stat-pills.tsx`, `health-sparkline.tsx`).
- **Copy only:** no scoring, storage or param changes.
- **A pure smoke pins the vocabulary.** It forbids "Close / Warm / Cool" as tier labels, "orbit" in ring labels, and "Closeness" as the 1–5 filter label.

## Constraints

- **Tests:**
  - Tests are `scripts/smoke-*.ts`, registered in `scripts/run-smoke.ts`, and DB smokes start with `import "./smoke/_env";`.
  - The shared suite PGlite means any smoke that changes shared state restores it in `cleanup()`.
  - `smoke-behavior-golden` must be re-recorded only where a change is intended and named in the commit.
- **Schema:** one schema change (C5) and one version bump, 153. No other migrations.
- **Copy:** no trailing period on short UI copy, curly apostrophes, at most one " — ".
- **Tailwind:** no Tailwind class names in code comments, and device switches are `md:` classes.
- **Server actions:** `"use server"` files export only async functions.
- **One source of truth for each rule:**
  - presets: `follow-up-presets.ts`;
  - effective cadence: `keep-in-touch.ts` plus its SQL twin;
  - the school normalizer: `school-name.ts`;
  - the score labels: one module that every label reads.
- **The line-keyed allowlist** in `smoke-provider-exhaustive` needs re-keying when listed files shift.

## Behaviour changes users will notice

- New quick choices everywhere a follow-up or snooze is scheduled: 1 day, 2 days, Next business day 9 am, Next week 9 am, 2 weeks.
- The bell's snooze becomes a menu.
- Draft boxes always show an intent field with four chips.
- A saved Keep-in-touch cadence finally shows, and lapsed cadences show up as due, including Inner orbit contacts monthly and Mid orbit quarterly by default. Due lists will grow for people with many close contacts.
- Contacts gets Alumni and Target companies filters.
- Settings → Profile gets target role, graduation year and search status.
- Score labels change:
  - the filter's "Closeness" becomes "Strength";
  - the dashboard's Close/Warm/Cool becomes Inner/Mid/Outer;
  - graph rings become Core/Close/Middle/Far/Deep space.

## Acceptance

- `resolvePreset` is pinned by table tests: each preset on each weekday, around 9 am, and across a DST change in America/New_York. Server validation refuses past dates and dates beyond 366 days.
- On localhost:
  - Picking "Next business day" on Friday afternoon books Monday 09:00 local, shown correctly on the contact, the dashboard and the bell.
  - A Radar "schedule" with "2 days" books two days out.
  - A saved Monthly cadence persists across a reload.
  - An Inner orbit contact with no touches in 31 days and no cadence of its own appears once in Due follow-ups, labelled with the default.
  - The Alumni + Targets filters return exactly the matching contacts.
  - Saving the profile fields changes the draft's sender line.
- `npm test`, `run-smoke --check`, `tsc --noEmit` and `eslint src scripts` all pass.
