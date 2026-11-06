# Sprint B — first run without a key

**Date:** 2026-10-08 · **Source:** `docs/audits/2026-10-08-app-e2e-audit.md` §1 item 8, §5, §8 Sprint B (on branch `claude/app-e2e-testing-audit-388719`, PR #412) · **Base:** `main` @ `32f4eea3`

## Goal

A new Free account — most likely a student or new grad with no AI key — can capture people, ask about their network and draft a follow-up in their first week without hitting a dead end, and onboarding gets them to their first people before anything slow or technical. Later-career users get the same first-run gains.

## Decisions (made with Jason, Oct 8)

1. **Managed AI on Free:** 10 credits every month through the existing allowance machinery, plus a one-time starter grant of 25 credits. Bring-your-own-key still wins and has no credit limit. No separate no-AI compose path in this sprint.
2. **Spend order:** monthly allowance → starter → admin adjustments → packs.
3. **Onboarding:** people first. LinkedIn export leaves onboarding and becomes a nudge; the AI-key step leaves onboarding.
4. **Persona:** rewrite the 6-person tour cast for early-career users; add a second localhost seed persona (`student`), founder stays default.
5. **Out of scope:** manual compose without AI, creating a contact from Structured Logging, onboarding goal question, recruiter pipeline stages, any Sprint C/D item.

## Scope

### B1 — Free plan allowance and starter grant

- `PLAN_CONFIG.free` (`src/lib/plans/plan-config.ts`): `monthlyCredits: 10`, `features.hostedAi: true`. `managedEligibility` then returns `"plan"` for Free with no code change in `managed-ai-policy.ts`.
- `creditGrants.plan` type widens to include `"free"` (plain text column; no migration). Allowance grants for Free use the calendar-month window `creditPeriodFor` already returns for accounts with no subscription.
- New grant kind `"starter"` (`creditGrants.kind` is plain text, no CHECK; type-only change). One row per account, `grantKey = starter:<userId>` (the unique index makes creation idempotent), `microsGranted = creditsToMicros(25)`, no period, never renews, `status: "active"`.
- Created lazily wherever the allowance is ensured (`ensureAllowance` in `src/lib/credits/ledger.ts`) for Free accounts only, so existing Free users receive it once on their next AI call or credits read. A Pro/Max account never receives a starter grant; an account that downgrades to Free keeps any starter balance it already had.
- Spendable set and order (`spendableSql` and the settle `ORDER BY` in `ledger.ts`): `allowance` (current period) → `starter` → `adjustment` → `pack`. `packsUsable` stays Pro/Max only.
- Constant next to the plan table: `FREE_STARTER_CREDITS = 25`.
- `getCreditBalance` reports starter credits so the credits card and notices can show "N starter credits left".
- Credit-notice emails (80%/100%) do not fire for Free accounts; the in-app notice covers it.
- Ops: no new alert. Existing managed-AI spend/runway alerts include Free usage automatically; expected ceiling is 10 credits per active Free account per month plus 25 once.
- Legal: the privacy page (`src/app/(site)/(docs)/privacy/page.tsx`, the "On Orbit Pro and Orbit Max, AI is included" passage and any summary line) and the terms say Free includes a small monthly AI allowance and a starter grant that run on Orbit's provider accounts, and that a saved key is used instead when present. `TERMS_VERSION` (`src/lib/legal.ts`, now `2026-10-04`) bumps to the ship date, which triggers re-consent.
- Pricing page and `/upgrade` Free card list "10 AI credits a month + 25 to start" in place of "on your own AI key".

### B2 — One AI-access state everywhere

- `AiKeyNotice` (`src/components/ai-key-notice.tsx`) is the single component for "AI can't run right now". Its state comes from `settings.ai.reason` plus the balance: `key_required` (on Free after B1 only when managed AI is paused or unconfigured), `managed_limit` (out of credits), `managed_unavailable` (paused). Copy per state, with a deep link to `/settings?integration=ai` and, for Free, "Compare plans":
  - out of credits on Free: "You’ve used this month’s AI credits — they refill on {date}. Add your own key for no limit"
  - out of credits on Pro/Max: existing pack copy
  - paused: existing copy
- Surfaces that use their own copy today switch to `AiKeyNotice` (compact where space is tight) or to the shared copy:
  - Radar card's "Add an AI key" line (`src/components/radar/recommendation-card.tsx` ~253) and `src/actions/radar.ts` ~150.
  - Dashboard "Add your AI key" CTA (`src/components/dashboard/dashboard-sections.tsx` ~131).
  - Floating ask bar: a compact notice in the panel header when `settings.ai` says AI can't run, instead of failing after send.
  - Follow-up draft sheet (Radar) and contact "Draft for": when AI can't run, the notice shows in the sheet instead of a generic failure toast.
  - Knowledge dossier refresh and Constellation refresh: a missing-AI failure shows the shared copy, not "Not found" or a false success.
- Copy no longer says "Add your AI API key" to a Free account with credits left; "AI API key" wording stays only in Settings → AI provider and the bring-your-own-key line.
- A low-credit line ("3 AI credits left this month") shows on the credits card and in the ask bar footer for Free when 3 or fewer remain.

### B3 — Onboarding: people first

- `PATH_STAGES` (`src/lib/onboarding-steps.ts`):
  - quick: `welcome → people → connect → overview`
  - tour: `welcome → connect → launch`
  - `linkedin` and `ai-key` leave both main lines; the step ids stay in `ONBOARDING_STEPS` so a persisted `onboarding_step` of `linkedin` or `ai-key` resumes at the next main-line step and never strands.
- People step (`src/components/onboarding/steps/people-step.tsx`): "Capture from notes" is the recommended card; "Upload your LinkedIn export" stays as the third card; "I’ll add people later" becomes a secondary button, not a text link.
- Highlights chapters replace the "Needs AI key" tag on capture and ask with "Uses AI credits".
- LinkedIn export nudge: a dismissible card on the dashboard and on /imports for accounts with no LinkedIn import, titled "Start your LinkedIn export", with the existing two-step instructions, a link to LinkedIn's export page, and "I’ve requested it", which records the time and turns the card into "Your export should be ready about {date} — drop the ZIP here when the email arrives". Dismissal and the requested-at time persist in an existing `user_settings` jsonb column (the plan names it; no schema change).
- Settings → AI provider gains a one-line explainer at the top: "Free includes 10 AI credits a month and 25 to start. Add your own key to use AI with no limit".
- The terms checkbox and gate are unchanged.

### B4 — Early-career persona

- Tour cast (`src/lib/onboarding-examples/cast.ts`): same 6 slots, shape and invariants (`smoke-onboarding-examples-cast` passes unchanged): an alum at a target company, a campus recruiter, a professor, a classmate, a manager from an internship, a founder met at a career fair. Companies stay fictional. `TOUR_EXAMPLE_NOTE` is rewritten as a career-fair note.
- Localhost seed persona: `ORBIT_DEMO_PERSONA=student` selects a student/new-grad workspace in `src/lib/demo-data/` (about 30 people: recruiters, alumni, professors, classmates, internship colleagues; a career fair event with attendees; reminder lists "Recruiters", "Alumni", "Referrals"; goals such as "Land a new-grad SWE offer" and "Get two referrals at target companies"; no outreach campaign, nothing about fundraising). `founder` (today's seed) stays the default and is unchanged. `ensureLocalDemoData` reads the env var; `scripts/seed-showcase.ts` gains `--persona`.

### B5 — Capture polish

- The Save button shows "Saving…" from the click, via a local pending flag cleared on the action's reply (the server is already idempotent).
- The summary says why each automatic follow-up exists, next to it: "You marked this a real conversation, so Orbit set a follow-up in {N} days" (closeness 3 or higher) or "Your notes asked for a follow-up" (model recommendation). The rule (`shouldCreateFollowUp`) is unchanged.

## Constraints

- Tests are `scripts/smoke-*.ts`, registered in `scripts/run-smoke.ts`; DB smokes start with `import "./smoke/_env";`, and any smoke that changes shared state (surface flags, plan rows, grants for a shared user) restores it in `cleanup()` because the suite shares one PGlite.
- `src/lib/ai-access.ts` stays the only path to a provider key (`smoke-ai-access` enforces it).
- Every managed model call stays priced in `ai-pricing.ts`.
- No schema change and no `SCHEMA_VERSION` bump: the new grant kind and plan value are type-level; UI flags use an existing jsonb column.
- Copy: no trailing period, curly apostrophes, at most one " — ".
- No Tailwind class names in code comments. Device switches are `md:` classes.
- `TERMS_VERSION` bumps exactly once, in the task that changes legal copy.

## Behaviour changes users will notice

- Every Free account can use AI straight away: 25 starter credits, then 10 a month.
- Everyone re-accepts the terms on their next visit.
- Onboarding asks for people first and no longer asks for a LinkedIn export or an AI key.
- The guided tour's example people are an early-career network.
- Running out of credits on Free shows one consistent message everywhere, with the refill date.

## Acceptance

- A fresh Free account on localhost with `ORBIT_DEMO_DATA=off` and `ORBIT_DEMO_MANAGED_AI=off` (so it behaves like production) and a managed key in the local env (`GEMINI_API_KEY`, honoured off Vercel as a managed key) can extract people from notes, ask a chat question and generate a draft without saving a key, and its balance shows 25 starter plus 10 monthly credits. Smokes never call a provider: they assert eligibility, grants, balances and spend order directly.
- After the allowance and starter are exhausted (forced in a smoke), every surface in B2 shows the shared out-of-credits state with the refill date.
- Quick onboarding walks welcome → people → connect → overview; a stored `linkedin` step resumes at the next main-line step.
- `npm test`, `run-smoke --check`, `tsc --noEmit` and `eslint src scripts` pass (`smoke-radar-run` is red on `main` and excluded from this bar).
