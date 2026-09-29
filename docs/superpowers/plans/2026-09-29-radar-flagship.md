# Radar flagship — implementation plan

Spec: `docs/superpowers/specs/2026-09-29-radar-flagship-design.md`. Everything lands on
`claude/inspiring-fermi-npcgb7` (PR #368), with one commit per task, in this order. The release
stays gated (`comingSoon` on `page.radar`) until Jason removes it.

Rules carried from P0:
- Hand-written DDL in `src/db/index.ts`. `user_settings` columns go in three places. Named
  Drizzle indexes must match the DDL.
- Re-scan remote schema versions before claiming one, then run
  `npx tsx scripts/smoke-schema-ddl.ts --update`.
- `runAtomicWrite` returns void. Use `rowsOf` for `db.execute`.
- Toast copy: curly ’, "Couldn’t", never "failed", no trailing period.
- Every new cron: `isInternalRequest`, the `cron_runs` ledger, `PUBLIC_ROUTES`, ops-sweep,
  ops-alerts, RUNBOOK, and `ops.yml`.
- Before each commit: `npx tsc --noEmit`, lint on touched files, and that task's smokes.

## Task 1 — Schema (one version, ≥ 134)

Everything in the spec's "Data model changes": the new `recommendations` columns and the renamed
live index (adding `auto_applied`), `contact_signals`, the three global feed tables, the
`user_settings` columns, and `contacts.bluesky_handle` / `mastodon_acct`.

Also: `EXPECTED_TABLES`, `SCALE_DDL` FK-leading indexes, and the lock file.

Proves: `db:check`, `smoke-schema-upgrade`, a fresh PGlite `db:setup`.

## Task 2 — Measurement

- `markRecommendationsSeen(userId, ids, now)` in `store.ts`: one batched update, called via
  `after()` from `loadRadarPage` and the briefing loader.
- `acted_at` is stamped by every action in `actions-core.ts`. `outcome_at` is detected in the
  run with one statement: an accepted row whose contact has a `countsAsTouch` interaction within
  14 days.
- `src/lib/radar/metrics.ts`: the aggregates. The page is
  `src/app/(clerk)/(admin)/admin/analytics/radar/page.tsx`, linked from the analytics nav.

Proves: new `smoke-radar-metrics`; `smoke-radar-run` (impressions batched, outcomes);
page-budgets.

## Task 3 — Learning

- `src/lib/radar/model.ts`, which is pure: `buildRadarModel(rows)` and `multiplierFor(model,
  kind, code)`, bounded to [0.7, 1.3] with a prior of 6.
- `scoreContactKinds` takes `model` as an input (default neutral). `base_score` is stored.
- The run recomputes and saves `radar_model` from 90 days of rows in one aggregate.

Proves: `smoke-radar-score` (bounds, determinism, a neutral model changes nothing);
`smoke-radar-run`.

## Task 4 — Hybrid rerank

- `"radar.rerank"` in `ai-operations.ts` (fast, minimal, background), and in
  `smoke-ai-operations`.
- `src/lib/radar/rerank-prompt.ts`, which is pure: the builder and the fenced facts.
  `src/lib/radar/rerank.ts`: shortlist of 20, the zod reply, clamping to ±15, dropping unknown
  ids, guarding the angle and checking its numbers, the prep-in-48 h exemption, an 8 s timeout,
  and a cache keyed on the shortlist hash.
- `RADAR_RERANK_ENABLED` in `run.ts`. `stats.rerank` is recorded.

Proves: `smoke-radar-score` (the pure prompt builder and applying adjustments);
`smoke-radar-run`, with the stub returning ok, invalid and timeout.

## Task 5 — Pre-drafts and autopilot

- In the run, after the rerank: drafts for up to 5 `today` cards through
  `generateContactFollowUpDraft`, cached by `inputs_hash`, all under a shared 25 s AI deadline
  (rerank, then drafts, then why-lines).
- `FollowUpDraftSheet` gets an optional `initialDraft` prop. The card shows "Draft ready".
- Autopilot: a settings action `setRadarAutopilot(kind, on)`. The run schedules through
  `scheduleContactFollowUpForUser` and sets `status = 'auto_applied'`. An Undo action clears the
  follow-up and dismisses the card.
- Bell copy: "N drafts ready · M people worth a message".

Proves: `smoke-radar-run` (draft reuse, autopilot and undo, nothing without a key or while
gated); toast-copy; icon-button-names.

## Task 6 — Job changes

- `src/lib/radar/signals/job-change.ts`: `recordJobChangeSignals`, deduped by hash. It is wired
  into three places:
  - `resolve.ts`, at the `diffPageAgainstContact` call sites;
  - `refreshContactsFromLinkedIn`;
  - `updateContactForUser`, reading the prior row only when title or company is in the input.
- The nightly Apollo re-check on the person's own key: 10 per run, `radar_apollo_cursor`, and
  it never writes the contact. The card gets an "Update record" action.

Proves: `smoke-radar-run` (signals from each source); `smoke-contact-writes` if present;
extension smokes stay unchanged.

## Task 7 — Company news

- `src/lib/radar/feeds/{sources,fetch,store,sweep}.ts`, mirroring `src/lib/jobs/feed-*`.
- `POST /api/radar/feeds/sweep` on `37 * * * *`, ledger `radar.feeds`, stands down while
  gated.
- The per-user probe in the run: one statement against `external_item_companies`, confirmed by
  `companiesMatch`, at most 3 per run.

Proves: new `smoke-radar-feeds` (fixtures, probe cost, dedupe, cap); the ops smokes.

## Task 8 — Social and extension activity

- Handle fields on the contact edit form and contact API. `contacts` columns only, with no
  identity sync.
- `src/lib/radar/signals/social.ts`: the Bluesky and Mastodon poll inside the run, deadline
  checked.
- `POST /api/extension/signals` (additive; the v1 contract is unchanged), gated on
  `radar_capture_linkedin_activity`.

Proves: `smoke-radar-run` (with a stubbed fetch); the extension contract smoke;
`smoke-public-routes`.

## Task 9 — Weekly digest

- `src/lib/radar/digest.ts` and `POST /api/radar/digest` on `13 * * * 1`: the local-Monday
  window from `radar_digest_tz` (captured from the `orbit-tz` cookie on Radar and Settings
  visits), a single-statement week claim, Resend through the `broadcasts.ts` pattern, and
  unsubscribe through the `interest-list` token pattern.
- A toggle in Radar settings and in Settings → Notifications.

Proves: new `smoke-radar-digest`; the ops smokes.

## Task 10 — Morning briefing and `/radar` polish

- `src/components/radar/morning-briefing.tsx` replaces `RadarPreviewCard` on the dashboard and
  moves up under `DashboardHeader`. It shows the top 3, drafts ready, and "What changed
  overnight". The legacy dashboard is unchanged for viewers who can't open Radar.
- `/radar`: focus mode (the mobile default) with `j`/`k`/`s`/`d`/`x`/`z`; the "What changed",
  "Autopilot did this" and network health strips; the settings sheet; collapse-on-resolve motion
  that honours reduced motion; the "All clear" state.

Proves: page-budgets (briefing ≤ 3 statements, `/radar` ≤ 6); render-stamp; tap-targets;
icon-button-names; command-palette. A browser check in demo mode, with the gate lifted
temporarily and never committed, at 1280 px and 390 px.

## Task 11 — Lifecycle, docs, release checklist

- Purge, export and merge for `contact_signals`. `radar_model` resets with insights. Seed every
  new table in `smoke-purge` and `smoke-data-export`.
- Update `docs/RUNBOOK.md`, `docs/performance.md` and `docs/DEVELOPMENT.md`, plus a
  "Reviewer's guide" in the PR body that maps commits to spec sections.
- Full suite: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run perf:pages`,
  `npm run db:check`. Re-scan schema versions, merge `main` if it moved, then push.

## Out of scope

- Auto-sending, which is never done.
- X/Twitter and server-side LinkedIn fetching.
- A paywall.
- Removing `comingSoon`. That is Jason's call once the admin metrics look right.
