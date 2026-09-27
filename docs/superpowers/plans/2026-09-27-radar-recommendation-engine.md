# Radar Recommendation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `/radar` page that computes, every night and without being asked, a short ranked list of people to reach out to, follow up with or reconnect with — each with plain-English reasons, evidence and one-click actions — and delivers it to the bell and a weekly email.

**Architecture:** A pure, deterministic scorer (`src/lib/radar/score.ts`, modeled on `scoreAttendee` in `src/lib/events/relevance.ts`) ranks per-contact signals into one recommendation per person. Internal signals are read live from the tables that already hold them; external signals (job changes, company news, posts) are dated `contact_signals` rows. A nightly claim-loop route writes `recommendations`; the page, dashboard, bell and chat read them. AI only writes a one-line "why" about an already-chosen row, cached by an inputs hash, and is skipped entirely without a key.

**Tech Stack:** TypeScript, Next.js 16 App Router, Drizzle ORM, PostgreSQL (Neon in prod, PGlite locally), `tsx` smoke-script harnesses, GitHub Actions scheduler, Resend.

**Spec:** `docs/superpowers/specs/2026-09-27-radar-recommendation-engine-design.md`

## Global Constraints

- **Never run `npm run db:push`.** DDL goes in `src/db/index.ts`: new tables in the `DDL` template; new `user_settings` columns ALSO in the `alters` list and the PGlite `ensureColumn` calls (`CREATE TABLE IF NOT EXISTS` is a no-op on existing databases); FK-leading indexes in `SCALE_DDL`. Bump `SCHEMA_VERSION` once per phase with a changelog line, then `npx tsx scripts/smoke-schema-ddl.ts --update`. Main is at 120; the phases plan for 121 / 122 / 123 — re-scan `origin/main` and every open branch before claiming a number, because a reused number silently skips one branch's DDL.
- **`src/lib/radar/score.ts` is pure.** No `@/db`, no AI, no `Date.now()` — `now` is an input. The model writes prose about a chosen row and never chooses or orders.
- **Every `src/lib/radar/*` function takes `userId` explicitly** and works without a request scope, so the cron route, the page and the smoke scripts drive the same code.
- **Never select `notes` or `profile_image_url` in a scan.** Avatars come from `clientAvatarUrlSql` (`src/lib/contact-avatar-sql.ts`). No per-item statements: batch with `inArray`, write with one multi-row statement or `runAtomicWrite`.
- **Third-party text** (feed titles, post excerpts) is sanitized on ingest (`cleanSingleLine`, caps, `safeHttpUrl` or dropped), fenced with `fenceUntrusted` in prompts, and never written to `contacts.notes`, `interactions.raw_notes`, `contacts.ai_summary` or any embedding input.
- **No send path** is imported by `src/lib/radar/**` except `digest.ts`. Autopilot stops at a ready draft.
- **Statement budgets move only on purpose**, with a comment: dashboard 16 → 17 and notification panel 8 → 9 in P0 (`scripts/smoke-page-budgets.ts`), dashboard back to 16 in P1.
- **Every numeric constant is a starting value.** Export named constants; the harness asserts orderings, never literals.
- Run `npx tsc --noEmit`, `npm run lint`, `npm run db:check` and the phase's smoke scripts before each commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/radar/types.ts` | **New.** Pure, client-importable vocabulary: kinds (priority order), statuses, buckets, signal kinds, `RadarSignal`, `RadarReason`, `RadarEvidence`, `KIND_LABELS`. |
| `src/lib/radar/score.ts` | **New.** Pure scorer: `RADAR_WEIGHTS`, `RADAR_BUCKETS`, `ScoreContext`, `scoreContactKinds`, `pickWinner`, `decayed`, `expiryFor`, `dedupeSameFact`. |
| `src/lib/radar/signals/internal.ts` | **New.** `loadCandidates`, `produceInternalSignals`, `loadScoreContextInputs`. |
| `src/lib/radar/signals/existing-suggestions.ts` | **New.** Bridge from pending `ai_suggestions` rows during the P0 overlap. |
| `src/lib/radar/store.ts` | **New.** Caps, `loadLiveRecommendations`, `loadSuppressions`, `writeRunResult`, `listRecommendationsForPage`, `listTopRecommendations`, feedback writes. |
| `src/lib/radar/run.ts` | **New.** `runRadarForUser`, `ensureRadarRun`, `maybeRefreshRadar`, `claimRadarUsers`, `releaseRadarLease`, `runRadarPass`. |
| `src/lib/radar/explain.ts` | **New.** `radarInputsHash`, `explainRecommendation`, `explainTopForRun` (operation `radar.why`). |
| `src/lib/radar/page-data.ts` | **New.** `loadRadarPage` (≤ 6 statements). |
| `src/actions/radar.ts` | **New.** Server actions, all behind `requireUserForSurface("page.radar")`. |
| `src/app/api/radar/run/route.ts` | **New.** Nightly internal route. |
| `src/app/(clerk)/(app)/(main)/radar/{page,loading}.tsx` | **New.** The page. |
| `src/components/radar/*` | **New.** `radar-header`, `radar-today`, `radar-kind-section`, `recommendation-card`, `radar-preview-card`, `network-health-strip`, `radar-settings-panel`, `radar-empty`. |
| `src/lib/radar/feeds/*` | **P1.** `sources`, `fetch`, `parse-rss`, `parse-hn`, `parse-edgar`, `parse-gdelt`, `company-extract`, `store`, `sweep` — modeled file-for-file on `src/lib/jobs/`. |
| `src/lib/radar/signals/{news,job-change,apollo-recheck}.ts` | **P1.** External signal producers. |
| `src/lib/radar/digest.ts` | **P1.** Weekly email. |
| `src/lib/radar/signals/social.ts`, `src/lib/radar/{autopilot,feedback}.ts` | **P2.** |
| `scripts/smoke-radar-*.ts` | **New.** Harnesses, each registered in `scripts/run-smoke.ts` MANIFEST with its tier. |

The split matters: `score.ts` and `types.ts` are pure so the ranking can be pinned without a database and imported by client components; everything that touches the database lives beside it but never inside it.

---

# Phase P0 — Radar core

Ships alone: tables, scorer, internal signals, nightly run, the page, and the dashboard / bell / chat readers in overlap mode with the legacy suggestion builder.

### Task 1: Schema for P0

**Files:**
- Modify: `src/db/schema.ts` (new tables beside `aiSuggestions` ~line 1958; `userSettings` columns)
- Modify: `src/db/index.ts` (`DDL` template next to `ai_suggestions` ~line 376; `alters` ~line 3404; PGlite `ensureColumn`; `SCALE_DDL` ~line 2180; `SCHEMA_VERSION` ~line 2130)
- Modify: `scripts/schema-ddl.lock.json` (via `--update`)

**Interfaces:**
- Produces: Drizzle tables `recommendations`, `contactSignals`, `radarRuns`, `recommendationFeedback`; types `Recommendation`, `ContactSignal`, `RadarRun`, `RecommendationFeedback`; `userSettings.radarNextAt`, `radarLeaseUntil`, `radarLastRunAt`, `radarPaused`, `radarAutopilot`, `radarCaptureLinkedinActivity`.

- [ ] **Step 1: Add the DDL**

```sql
CREATE TABLE IF NOT EXISTS recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  score integer NOT NULL,
  bucket text NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]',
  evidence jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending',
  snoozed_until timestamptz,
  expires_at timestamptz NOT NULL,
  run_id uuid,
  inputs_hash text NOT NULL,
  ai_note jsonb,
  draft jsonb,
  actions jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS recommendations_live_uidx
  ON recommendations(user_id, contact_id, kind) WHERE status IN ('pending','snoozed','auto_applied');
CREATE INDEX IF NOT EXISTS recommendations_user_status_score_idx ON recommendations(user_id, status, score DESC);
CREATE INDEX IF NOT EXISTS recommendations_expires_idx ON recommendations(expires_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS contact_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  source text NOT NULL,
  external_item_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contact_signals_dedupe_uidx ON contact_signals(user_id, dedupe_hash);
CREATE INDEX IF NOT EXISTS contact_signals_user_occurred_idx ON contact_signals(user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS radar_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  trigger text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  stats jsonb NOT NULL DEFAULT '{}',
  error text
);
CREATE INDEX IF NOT EXISTS radar_runs_user_started_idx ON radar_runs(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS recommendation_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  recommendation_id uuid,
  kind text,
  action text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recommendation_feedback_user_contact_idx
  ON recommendation_feedback(user_id, contact_id, created_at DESC);
```

In `SCALE_DDL`, the FK-leading indexes (`docs/performance.md`: a `(user_id, contact_id)` index does not serve an ON DELETE CASCADE probe):

```sql
CREATE INDEX IF NOT EXISTS recommendations_contact_idx ON recommendations(contact_id);
CREATE INDEX IF NOT EXISTS contact_signals_contact_idx ON contact_signals(contact_id);
CREATE INDEX IF NOT EXISTS recommendation_feedback_contact_idx ON recommendation_feedback(contact_id);
```

In `alters` (and matching `ensureColumn` calls in `migratePglite`):

```sql
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS radar_next_at timestamptz;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS radar_lease_until timestamptz;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS radar_last_run_at timestamptz;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS radar_paused boolean NOT NULL DEFAULT false;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS radar_autopilot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS radar_capture_linkedin_activity boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS user_settings_radar_due_idx ON user_settings(radar_next_at) WHERE radar_paused = false;
```

- [ ] **Step 2: Add the Drizzle definitions** matching the DDL column for column, including the partial unique index `recommendations_live_uidx` (the guard checks unique-index parity).
- [ ] **Step 3: Bump `SCHEMA_VERSION`** to the next free number with a changelog entry in the existing style ("scanned every remote ref on <date>; <n> is the highest claimed").
- [ ] **Step 4: Refresh the lock and bootstrap**

Run: `npx tsx scripts/smoke-schema-ddl.ts --update && npm run db:check && ORBIT_PGLITE_DIR=$(mktemp -d) npm run db:setup`
Expected: guard green; the four tables and six columns exist on a fresh PGlite.

- [ ] **Step 5: Commit** — `git commit -m "Add Radar tables and user_settings columns"`

### Task 2: Vocabulary and the pure scorer

**Files:**
- Create: `src/lib/radar/types.ts`, `src/lib/radar/score.ts`
- Create: `scripts/smoke-radar-score.ts` (tier `pure`); register in `scripts/run-smoke.ts`

**Interfaces:**

```ts
// types.ts
export const RECOMMENDATION_KINDS = ["prep", "heads_up", "follow_up", "opportunity", "reach_out", "reconnect"] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];
export const KIND_PRIORITY: Record<RecommendationKind, number>; // prep 6 … reconnect 1
export type RecommendationStatus = "pending" | "snoozed" | "accepted" | "dismissed" | "expired" | "auto_applied";
export type RecommendationBucket = "today" | "soon" | "later" | "skip";
export const SIGNAL_KINDS = [
  "job_change", "company_news", "social_post", "linkedin_activity",          // stored
  "dormant", "recent_intro", "linkedin_thread_quiet", "inbound_unanswered",  // transient
  "post_event", "upcoming_meeting", "event_upcoming", "action_item_open",
  "opportunity_due", "brief_next_step", "existing_suggestion",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];
export type RadarSignal = { kind: SignalKind; contactId: string; occurredAt: Date | null; source: string; payload: Record<string, unknown>; signalId?: string };
export type RadarReason = { code: string; label: string; points: number };
export type RadarEvidence = { signalKind: SignalKind; label: string; source: string; occurredAt: string | null; url?: string | null; signalId?: string | null };
export const KIND_LABELS: Record<RecommendationKind, string>;

// score.ts
export const RADAR_WEIGHTS = { /* spec "Scoring model" tables */ } as const;
export const RADAR_BUCKETS = { today: 50, soon: 32, later: 18 } as const;
export type ScoreContext = {
  now: Date;
  tier: "inner" | "mid" | "outer" | null;
  priorityLevel: number; relationshipScore: number; statedCloseness: number | null;
  lastInteractionAt: Date | null; nextFollowUpAt: Date | null;
  constellationPin: "in" | "out" | null; cadenceDays: number | null;
  targetPriority: 1 | 2 | 3 | null; goalFit: number;
  suppression: { neverKinds: Set<RecommendationKind> | "all"; recentDismissals: Partial<Record<RecommendationKind, number>> };
  kindMultiplier?: Partial<Record<RecommendationKind, number>>;
};
export type KindScore = { kind: RecommendationKind; score: number; bucket: RecommendationBucket; reasons: RadarReason[]; evidence: RadarEvidence[] };
export function scoreContactKinds(signals: RadarSignal[], ctx: ScoreContext): KindScore[];
export function pickWinner(kinds: KindScore[]): KindScore | null;
export function decayed(points: number, ageDays: number, halfLifeDays: number): number;
export function expiryFor(kind: RecommendationKind, evidence: RadarEvidence[], now: Date): Date;
```

- [ ] **Step 1: Write the harness first** — assertions: unanswered inbound outranks dormancy at equal context; the recent-touch penalty removes reach_out; `never` drops the kind and `"all"` drops everything; decay is monotone and drops reasons below 4; bucket thresholds; `KIND_PRIORITY` breaks ties; losing kinds' top reason is appended to the winner; the same input scores deep-equal twice; `constellationPin = "out"` produces nothing; `nextFollowUpAt` removes reach_out/reconnect but keeps prep.
- [ ] **Step 2: Implement `types.ts` and `score.ts`** against the spec tables.
- [ ] **Step 3: Run** `npx tsx scripts/smoke-radar-score.ts && npx tsx scripts/run-smoke.ts --check` — expected green.
- [ ] **Step 4: Commit** — `git commit -m "Add Radar's pure scorer and its harness"`

### Task 3: Internal signal producers and the suggestion bridge

**Files:**
- Create: `src/lib/radar/signals/internal.ts`, `src/lib/radar/signals/existing-suggestions.ts`

**Interfaces:**

```ts
export const RADAR_CANDIDATE_CAP = 1500;
export type CandidateContact = { id; fullName; preferredName; title; company; industry; closenessTier; priorityLevel; relationshipScore; statedCloseness; lastInteractionAt; firstInteractionAt; nextFollowUpAt; followUpStatus; cadenceDays; cadencePhrase; constellationPin };
export async function loadCandidates(userId: string, now: Date): Promise<CandidateContact[]>;
export async function produceInternalSignals(userId: string, candidates: CandidateContact[], now: Date): Promise<RadarSignal[]>;
export async function produceSuggestionSignals(userId: string, candidateIds: string[]): Promise<RadarSignal[]>;
export async function loadScoreContextInputs(userId: string): Promise<{ targetKeys: Map<string, number>; goals: string[]; suppressions: Map<string, ScoreContext["suppression"]> }>;
```

- [ ] **Step 1: `loadCandidates`** — one projected statement: `WHERE user_id = $1 AND constellation_pin IS DISTINCT FROM 'out' AND (closeness_tier IN ('inner','mid') OR priority_level >= 2 OR relationship_score >= 4 OR next_follow_up_at IS NOT NULL OR first_interaction_at > now() - interval '21 days') ORDER BY closeness DESC NULLS LAST LIMIT 1500`. Same predicates as the legacy rules (`src/lib/reminders.ts` 242–313).
- [ ] **Step 2: `produceInternalSignals`** — at most seven grouped statements, each `IN (candidate ids)`:
  1. LinkedIn message aggregates extending `reminders.ts` 192–210 with `max(interaction_date) FILTER (WHERE direction = 'in')` and `… = 'out'`; honour `countsAsTouch` (`src/lib/interaction-provenance.ts`). Emits `linkedin_thread_quiet` (14–90 d, ≥ 2 messages, cadence-aware lower bound via `idleThresholdFor`) and `inbound_unanswered` (last inbound ≥ 5 d ago and newer than last outbound).
  2. Future `meeting` interactions between now and now + 7 d → `upcoming_meeting`.
  3. `events` joined to `event_attendees` on candidate ids with `attendedEventFilter()` (`src/lib/events/store.ts`), `starts_at` between now − 14 d and now + 7 d → `event_upcoming` / `post_event`.
  4. Open `action_items` → `action_item_open` (text via `cleanSingleLine(…, 120)`, age).
  5. `contact_opportunities` with status in `OPEN_OPPORTUNITY_STATUSES` and `due_date <= now + 7 d` → `opportunity_due`.
  6. `contact_briefs.next_step IS NOT NULL` and `last_interaction_at <= generated_at` → `brief_next_step`.
  7. In JS from candidates: `dormant` (idle ≥ `idleThresholdFor(cadenceDays, 30)`), `recent_intro` (7–21 d since first touch, single touch).
- [ ] **Step 3: `produceSuggestionSignals`** — pending `ai_suggestions` of every type → `existing_suggestion` with `{suggestionType, suggestionId, description}`; the scorer maps `job_posting_signal` to opportunity, ignores `score_bump`, and collapses the three legacy auto types into their Radar equivalents via `dedupeSameFact`.
- [ ] **Step 4: `loadScoreContextInputs`** — `loadTargetKeys` (`src/lib/events/companies.ts`), `listActiveGoalTextsForUser(userId, {limit: 8})`, suppressions from `recommendation_feedback` (last 90 d plus every `never`). Goal fit via `goalRelevanceComponent` over company, title and industry only.
- [ ] **Step 5: Commit** — `git commit -m "Produce Radar's internal signals in batched reads"`

### Task 4: Store and the per-user run

**Files:**
- Create: `src/lib/radar/store.ts`, `src/lib/radar/run.ts`
- Create: `scripts/smoke-radar-run.ts` (tier `pglite`, first import `./smoke/_env`); register in MANIFEST

**Interfaces:**

```ts
// store.ts
export const PENDING_CAP = 12; export const TODAY_CAP = 5; export const PER_KIND_CAP = 4; export const NEWS_PER_RUN_CAP = 3;
export async function loadLiveRecommendations(userId: string): Promise<LiveRecommendation[]>;
export async function loadSuppressions(userId: string): Promise<Map<string, Suppression>>;
export async function writeRunResult(userId: string, runId: string, next: NewRecommendation[], opts: { now: Date }): Promise<{ inserted: number; updated: number; expired: number }>;
export async function listRecommendationsForPage(userId: string, now: Date): Promise<{ today: RecRow[]; byKind: Record<RecommendationKind, RecRow[]>; total: number }>;
export async function listTopRecommendations(userId: string, now: Date, limit: number): Promise<RecRow[]>;

// run.ts
export type RadarRunOptions = { now?: Date; ai?: boolean; external?: boolean; trigger: "schedule" | "page" | "manual" | "first_visit"; budgetMs?: number };
export type RadarRunStats = { candidates: number; signals: number; recommendations: number; inserted: number; updated: number; expired: number; aiNotes: number; skippedNoKey: boolean; durationMs: number };
export async function runRadarForUser(userId: string, opts: RadarRunOptions): Promise<RadarRunStats>; // never throws
export async function ensureRadarRun(userId: string): Promise<boolean>;
export async function maybeRefreshRadar(userId: string): Promise<void>;
```

- [ ] **Step 1: Write the harness first.** Seed one user with: a dormant inner-tier contact; a recent intro; an unanswered inbound LinkedIn message; a future meeting; an open action item; a pinned-out contact; a contact with `next_follow_up_at` set; a pending `job_posting_signal` row; a `never` feedback row. Assert: one recommendation per contact; pinned-out and `never` excluded; the follow-up-set contact excluded from reach_out/reconnect but eligible for prep; caps honoured; a second run inserts 0 and keeps ids; a snoozed row survives; ≤ 14 statements (`startQueryCount`, `src/lib/query-counter.ts`); no statement selects `notes`; `radar_runs` start and finish rows exist.
- [ ] **Step 2: `writeRunResult`** as one `runAtomicWrite`: (a) expire pendings not in the new set; (b) `INSERT … ON CONFLICT (user_id, contact_id, kind) WHERE status IN ('pending','snoozed','auto_applied') DO UPDATE SET score, bucket, reasons, evidence, inputs_hash, run_id, expires_at, updated_at, ai_note = CASE WHEN recommendations.inputs_hash = excluded.inputs_hash THEN recommendations.ai_note ELSE NULL END` (Drizzle `onConflictDoUpdate({ target, targetWhere })`), leaving `status` and `snoozed_until` alone; (c) wake snoozes whose `snoozed_until <= now`.
- [ ] **Step 3: `runRadarForUser`** in `traced("radar.run")`: insert the `radar_runs` row → candidates → internal signals → suggestion bridge → score context → score each candidate → `pickWinner` → drop `skip` → per-kind cap → top 12 → `expiryFor` and inputs hash → `writeRunResult` → (Task 6) AI notes → finish row, `radar_last_run_at = now`, `radar_next_at = now + 24 h` (+ 6 h after a failure), lease cleared. Every step is skip-on-failure and counted.
- [ ] **Step 4: `ensureRadarRun`** (no completed run → claim this user's lease and run inline with `{ai: false, external: false, budgetMs: 15_000}`) and **`maybeRefreshRadar`** (last run older than 24 h and lease free → run with `{ai: false, external: false, budgetMs: 20_000}`; callers wrap it in `after()`).
- [ ] **Step 5: Run** `npx tsx scripts/smoke-radar-run.ts` — expected green.
- [ ] **Step 6: Commit** — `git commit -m "Write Radar recommendations per user, idempotently"`

### Task 5: Nightly route, claim loop and ops wiring

**Files:**
- Create: `src/app/api/radar/run/route.ts`
- Modify: `src/lib/radar/run.ts` (`claimRadarUsers`, `releaseRadarLease`, `runRadarPass`)
- Modify: `src/lib/cron-runs.ts`, `src/lib/public-routes.ts`, `scripts/smoke-public-routes.ts`, `.github/workflows/ops.yml`, `src/lib/ops-sweep.ts`, `src/lib/ops-alerts.ts`, `scripts/smoke-ops-sweep.ts`, `docs/RUNBOOK.md`

- [ ] **Step 1: The claim** (single statement, 10-minute lease):

```sql
UPDATE user_settings SET radar_lease_until = now() + interval '10 minutes'
 WHERE id IN (SELECT id FROM user_settings
               WHERE radar_paused = false
                 AND (radar_next_at IS NULL OR radar_next_at <= now())
                 AND (radar_lease_until IS NULL OR radar_lease_until < now())
                 AND last_active_at > now() - interval '60 days'
               ORDER BY radar_next_at NULLS FIRST
               LIMIT 25)
RETURNING user_id;
```

`last_active_at` is null for accounts that predate the column (`src/db/schema.ts`, `userSettings.lastActiveAt`), so the claim treats them as inactive. That is deliberate: their next visit runs the first-visit inline build (`ensureRadarRun`), which also refreshes `last_active_at` through the normal request path.

- [ ] **Step 2: `runRadarPass`** — `RADAR_PASS_BUDGET_MS = 270_000`, `USERS_PER_PASS = 25`, `RADAR_CONCURRENCY = 4` through `runSettledPool` (`src/lib/sync-scheduler.ts`), `PER_USER_BUDGET_MS = 30_000`; `deadlineReached(deadline − PER_USER_BUDGET_MS)` checked before each user; an unstarted user is released with `radar_next_at = now` so the continuation takes it; per-user failures are recorded (`reportError`, `where: "job.radar.user"`) and never rethrown.
- [ ] **Step 3: The route** — copy the shape of `src/app/api/sync/run/route.ts`: `export const maxDuration = 300`; `isInternalRequest` before any write; `startCronRun("radar.run")`; `finishCronRun` with `{claimed, ran, failed, recommendations, aiNotes, budgetExhausted, claimFull}` and `partial` when any user failed; `after(() => internalFetch("/api/radar/run", {method: "POST"}))` when `claimFull || budgetExhausted`.
- [ ] **Step 4: Registries** — `"radar.run"` in `CronJobName`; `/api/radar/run` in `PUBLIC_ROUTES` (internal block) and in `internalRoutes` of `scripts/smoke-public-routes.ts`; `ops-sweep.ts` snapshot `cron.radarRun` (like `jobFeed`); `ops-alerts.ts` `radar.schedule_missed` (silence > 30 h) and `radar.run_failed`, both `warning`, modeled on the job-feed conditions; `scripts/smoke-ops-sweep.ts` reset and healthy-seed lists gain `radar.run`; a RUNBOOK row with the manual `curl`.
- [ ] **Step 5: `ops.yml`** — new cron line `- cron: "17 4 * * *"` and a step gated on exactly that schedule:

```yaml
      - name: Run the Radar nightly pass (daily)
        if: github.event.schedule == '17 4 * * *' && steps.health.outcome == 'success'
        run: |
          curl -sS --fail-with-body --max-time 300 -X POST \
            -H "Authorization: Bearer $CRON_SECRET" \
            "$APP_URL/api/radar/run"
        env:
          APP_URL: ${{ secrets.APP_URL }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
```

- [ ] **Step 6: Run** `npx tsx scripts/smoke-public-routes.ts && npx tsx scripts/smoke-internal-auth.ts && npx tsx scripts/smoke-ops-sweep.ts && npx tsx scripts/smoke-schedules.ts`, then `curl -X POST localhost:3000/api/radar/run` under `npm run dev` — expected green and a `cron_runs` row.
- [ ] **Step 7: Commit** — `git commit -m "Schedule Radar's nightly pass"`

### Task 6: The AI why-line

**Files:**
- Create: `src/lib/radar/explain.ts`
- Modify: `src/lib/ai-operations.ts`, `scripts/smoke-ai-operations.ts` (the hard-coded background list), `scripts/fixtures/draft-prompt-goldens.json` (via `smoke-draft-prompts --update`)

**Interfaces:**

```ts
export type RadarAiNote = { why: string; opener: string; inputsHash: string; generatedAt: string };
export function radarInputsHash(rec: { contactName: string; title: string | null; company: string | null; kind: RecommendationKind; reasons: string[]; evidenceLabels: string[] }): string;
export async function explainRecommendation(userId: string, recommendationId: string, opts?: { signal?: AbortSignal }): Promise<{ ok: true; note: RadarAiNote } | { ok: false; reason: "no_key" | "no_reasons" | "ai_error" | "not_found" }>;
export async function explainTopForRun(userId: string, recIds: string[], opts: { budgetMs: number }): Promise<number>;
```

- [ ] **Step 1: Register the operation** — `"radar.why": { label: "Radar: why this person", tier: "fast", thinking: "minimal", background: true }`, and add `"radar.why"` to the pinned background list in `scripts/smoke-ai-operations.ts`.
- [ ] **Step 2: Implement** modeled on `src/lib/events/explain.ts`: system prompt adapted ("You help someone decide who in their network to contact today… write from the reasons only; never invent…"); user turn = JSON of `cleanSingleLine(name, 80)`, `cleanSingleLine(title, 120)`, `cleanSingleLine(company, 120)`, the kind label, reason labels, and evidence labels with any third-party text inside `fenceUntrusted("EVIDENCE", text)`; `completeJson(userId, {system, user, operation: "radar.why", maxOutputTokens: 300})`; zod `{why: z.string().max(200), opener: z.string().max(300)}`; `guardModelOutput`; stored on `recommendations.ai_note`. Skip, never throw, when `!(await userCanUseAi(userId))`.
- [ ] **Step 3: Call `explainTopForRun`** from `runRadarForUser` for `today` rows missing a current note, at most 5, under `min(15_000, remaining)` with one shared `AbortSignal.timeout`.
- [ ] **Step 4: Run** `npx tsx scripts/smoke-ai-operations.ts && npx tsx scripts/smoke-draft-prompts.ts --update && npx tsx scripts/smoke-radar-run.ts` — expected green; with no key, `skippedNoKey: true` and every row still has reasons.
- [ ] **Step 5: Commit** — `git commit -m "Write Radar's one-line why on the user's own key"`

### Task 7: The page, its actions and the registry

**Files:**
- Create: `src/lib/radar/page-data.ts`, `src/actions/radar.ts`
- Create: `src/app/(clerk)/(app)/(main)/radar/page.tsx`, `src/app/(clerk)/(app)/(main)/radar/loading.tsx`
- Create: `src/components/radar/{radar-header,radar-today,radar-kind-section,recommendation-card,network-health-strip,radar-settings-panel,radar-empty}.tsx`
- Modify: `src/components/loading/page-skeletons.tsx`, `src/lib/surfaces.ts`, `src/components/layout/app-nav.ts`, `src/lib/analytics-routes.ts`, `src/lib/feedback-report.ts`, `src/components/coming-soon/coming-soon.tsx`, `src/lib/rate-limit.ts`, `README.md`, `scripts/smoke-page-budgets.ts`

- [ ] **Step 1: `loadRadarPage(userId, now)`** → `{recs: {today, byKind, total}, lastRunAt, nextRunAt, settings, aiAvailable}` in at most 6 statements (recommendations joined to contacts with `clientAvatarUrlSql`; settings via `ensureUserSettings`; last `radar_runs` row; `getAiCapability`). Add a `radar` section to `scripts/smoke-page-budgets.ts`: ≤ 6 statements at 3,000 contacts, flat from 750 to 3,000, no `notes` or `profile_image_url`.
- [ ] **Step 2: Actions** in `src/actions/radar.ts`, each starting `const userId = await requireUserForSurface("page.radar")`:
  - `fetchRadar()` — starts `loadRadarPage` and `getNetworkStats`; blocking `ensureRadarRun` on a first visit; `after(() => maybeRefreshRadar(userId))`.
  - `scheduleFromRecommendation(id, days: 3 | 7 | 14)` → `scheduleContactFollowUpForUser` (`src/lib/reminder-writes.ts`), status `accepted`, feedback `accepted`, revalidate `/radar` and `/dashboard`.
  - `snoozeRecommendation(id, "1w" | "1m")`; `dismissRecommendation(id, reason?)` returning an undo snapshot; `restoreRecommendation(id)`; `suppressRecommendationForContact(id)` (feedback `never`).
  - `refreshRadarNow()` behind a new `RATE_LIMITS.radarRefresh = { limit: 3, windowSec: 600 }`, running inline with `{trigger: "manual", ai: true, budgetMs: 20_000}`.
  - `explainRecommendationAction(id)`; `updateRadarSettings({paused?, autopilot?})`.
- [ ] **Step 3: The page** — first line `const gate = await pageVisibilityGate("page.radar"); if (gate) return gate;`; start the `fetchRadar()` promise before awaiting anything else; `<RenderStamp />`; `RadarHeader`, `RadarToday`, `NetworkHealthStrip`, `RadarKindSections` and `RadarSettingsPanel` each in their own `<Suspense>`. `loading.tsx` renders the real header plus `RadarPageSkeleton`.
- [ ] **Step 4: `RecommendationCard`** (client) — avatar, `IntentLink` name, `ClosenessTierBadge dotOnly`, kind chip, reason chips (labels only), evidence line with any external link through `safeHttpUrl` and `rel="noopener noreferrer"`, why-line or the "Add an AI key" affordance, and actions: Schedule popover; Draft via `FollowUpDraftSheetLazy` with `preloadFollowUpDraftSheet()` on hover; Snooze menu; Dismiss with `runToastAction` undo (pattern: `src/components/dashboard/suggestion-row.tsx`); overflow "Not for this person" / "Open contact". Every icon button gets an accessible name (`smoke-icon-button-names`) and a 44 px target where listed in `smoke-tap-targets`.
- [ ] **Step 5: Registry** — `PAGES` entry `{ key: "page.radar", kind: "page", label: "Radar", description: "Who to reach out to this week, and why.", href: "/radar", comingSoon: true }`; nav item `RADAR` (lucide `Radar`) in `APP_NAV_EXTRAS` and `MOBILE_MORE_NAV` while coming-soon; `"/radar"` in `ROUTE_PATTERNS` (required); `["/radar", "radar"]` in `ROUTE_AREAS` plus `FeedbackArea` and `AREA_LABELS`; `FEATURES["page.radar"]` copy; README route table row.
- [ ] **Step 6: Run** `npx tsx scripts/smoke-render-stamp-pages.ts && npx tsx scripts/smoke-admin-analytics.ts && npx tsx scripts/smoke-surface-visibility.ts && npx tsx scripts/smoke-command-palette.ts && npx tsx scripts/smoke-icon-button-names.ts && npx tsx scripts/smoke-tap-targets.ts && npx tsx scripts/smoke-action-user-scope.ts && npm run perf:pages` — expected green. Open `/radar` under `npm run dev` with the `orbit_preview_unreleased` cookie, with and without an AI key.
- [ ] **Step 7: Commit** — `git commit -m "Add the Radar page"`

### Task 8: Dashboard, bell and chat in overlap mode

**Files:**
- Modify: `src/lib/reminders.ts` (`getDashboardData`), `src/actions/reminders.ts` (`fetchDashboard`), `src/components/dashboard/dashboard-sections.tsx`, `src/components/radar/radar-preview-card.tsx` (new), `src/lib/notification-panel.ts`, `src/lib/chat-attention.ts`, `scripts/smoke-page-budgets.ts`

- [ ] **Step 1: Dashboard** — `getDashboardData` adds `radar: listTopRecommendations(userId, now, 5)` only when the viewer's surface visibility allows `page.radar` and `radar_last_run_at IS NOT NULL`; add those contact ids to the existing single hydration. Raise the dashboard budget 16 → 17 with a comment. `SuggestedOutreachSection` renders `RadarPreviewCard` (top five, "Open Radar →") when `data.radar` is present, else the legacy `SuggestedOutreachCard`. `fetchDashboard` adds `ensureRadarRun` beside `ensureOutreachSuggestions` and `after(() => maybeRefreshRadar(userId))`.
- [ ] **Step 2: Bell** — `PanelItem.kind` gains `"recommendation"`; read `listTopRecommendations(userId, now, 10)` in the existing `Promise.all`; map at `urgency: "info"`, `url: /contacts/{contactId}`, body = first reason label; drop legacy `suggestion` items whose contact has a Radar item. Panel budget 8 → 9 with a comment.
- [ ] **Step 3: Chat** — `getAttentionBrief` unions Radar top rows into `suggestions` (reason = reason labels joined), deduped by contact against `overdue` and legacy suggestions.
- [ ] **Step 4: Run** `npm run perf:pages && npx tsx scripts/smoke-bounded-reads.ts && npx tsx scripts/smoke-batched-writes.ts && npx tsx scripts/smoke-behavior-golden.ts` — expected green **without** re-recording anything; the legacy path is untouched.
- [ ] **Step 5: Commit** — `git commit -m "Show Radar on the dashboard, in the bell and to chat"`

### Task 9: Export, purge and merge

**Files:**
- Modify: `src/lib/user-data.ts` (`STEPS.insights`, `preferences`), `src/lib/data-categories.ts`, `src/lib/contact-merge.ts`, `scripts/smoke-purge.ts`, `scripts/smoke-data-export.ts`, `scripts/smoke-contact-merge.ts`

- [ ] **Step 1:** `insights` exports and counts `recommendations`, `contact_signals`, `recommendation_feedback`, `radar_runs` and deletes all four; `preferences` nulls `radar_last_run_at` and `radar_next_at`; the `insights` description mentions Radar.
- [ ] **Step 2:** `contact-merge.ts` — `contact_signals` joins `REPOINTED_TABLES`; `recommendation_feedback` is repointed where the winner has no `(kind, 'never')` row and deleted with `recordDeleted` otherwise (the `contact_profiles` pattern); the loser's live `recommendations` are deleted with `recordDeleted` (the next run regenerates them) and terminal-status rows are repointed.
- [ ] **Step 3:** Seed one row per new table in `smoke-purge.ts`; assert `insights.recommendations` in `smoke-data-export.ts`; add a loser-with-signal-and-live-rec case to `smoke-contact-merge.ts`.
- [ ] **Step 4: Run** the three smokes — expected green.
- [ ] **Step 5: Commit** — `git commit -m "Export, purge and merge Radar data"`

### Task 10: P0 release

- [ ] **Step 1:** `npm run typecheck && npm run lint && npm test && npm run perf:pages`.
- [ ] **Step 2:** Merge; confirm a `radar.run` `cron_runs` row after the next 04:17 UTC schedule.
- [ ] **Step 3:** Delete `comingSoon: true` from the `page.radar` entry and move `RADAR` into `APP_NAV_CORE` after Dashboard.

---

# Phase P1 — The world outside

### Task 11: Feed tables and sources

**Files:** `src/db/schema.ts`, `src/db/index.ts`, `src/lib/radar/feeds/sources.ts`, `src/lib/user-data.ts` (header note for global tables), `.env.example`

- [ ] **Step 1: DDL** (global, no `user_id`):

```sql
CREATE TABLE IF NOT EXISTS external_sources (
  id text PRIMARY KEY, label text NOT NULL, url text NOT NULL, kind text NOT NULL,
  enabled boolean NOT NULL DEFAULT true, etag text, last_modified text,
  last_fetched_at timestamptz, last_changed_at timestamptz, last_status text, last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0, bytes_last_fetched integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS external_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
  external_id text NOT NULL, title text NOT NULL, summary text, url text NOT NULL,
  published_at timestamptz NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS external_items_source_external_uidx ON external_items(source_id, external_id);
CREATE INDEX IF NOT EXISTS external_items_published_idx ON external_items(published_at);
CREATE TABLE IF NOT EXISTS external_item_companies (
  item_id uuid NOT NULL REFERENCES external_items(id) ON DELETE CASCADE,
  company_key text NOT NULL, company_name text NOT NULL, published_at timestamptz NOT NULL,
  PRIMARY KEY (item_id, company_key)
);
CREATE INDEX IF NOT EXISTS external_item_companies_key_published_idx
  ON external_item_companies(company_key, published_at DESC);
```

plus the P1 `user_settings` columns in `alters` / `ensureColumn`: `radar_digest_enabled boolean NOT NULL DEFAULT true`, `radar_digest_tz text`, `radar_digest_last_week text`, `radar_digest_unsub_token_hash text`, `radar_apollo_cursor uuid`. Bump `SCHEMA_VERSION`, `--update` the lock.

- [ ] **Step 2: `sources.ts`** (pure, like `src/lib/jobs/feed-sources.ts`) — `DEFAULT_EXTERNAL_SOURCES` seeded with `onConflictDoNothing`: `hn.newest` (`https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=200`), `edgar.8k` and `edgar.s1` (`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=100&output=atom`, same for `S-1`), `rss.techcrunch`, `rss.theverge`, `rss.arstechnica`, and `gdelt.gkg` with `enabled: false`. Constants `MAX_ITEM_AGE_DAYS = 14`, `ITEM_TTL_DAYS = 21`, per-source `maxBytes`, `FEED_TIMEOUT_MS = 60_000`. `.env.example` documents `SEC_EDGAR_CONTACT_EMAIL` (EDGAR sources skipped when unset).
- [ ] **Step 3: Commit.**

### Task 12: Fetch and parse

**Files:** `src/lib/events/guarded-fetch.ts` (new `userAgent?` option), `src/lib/radar/feeds/{fetch,parse-rss,parse-hn,parse-edgar,parse-gdelt,company-extract}.ts`, `scripts/smoke-radar-feeds-parse.ts` (pure), `scripts/fixtures/radar/*`

- [ ] **Step 1:** `fetchSourceDocument` wraps `guardedFetchText` exactly like `src/lib/jobs/feed-fetch.ts` (returns `ok | not_modified | failed`, never throws, `onOverflow: "error"`, per-kind content-type allowlist). Add the `userAgent` option to `guardedFetchText`, because caller headers merge under the module's own today; EDGAR sends `OrbitBot/1.0 (contact: $SEC_EDGAR_CONTACT_EMAIL)`.
- [ ] **Step 2:** Parsers return `NormalisedExternalItem { externalId, title, summary, url, publishedAt, organizations: string[], sourceKind }`: RSS 2.0 and Atom via `fast-xml-parser` with HTML stripped and `cleanSingleLine(title, 200)`, summary ≤ 300; HN JSON; EDGAR company from the `" - NAME ("` title segment; GDELT via `jszip`, `V2Organizations` and `PAGE_TITLE`. URLs through `safeHttpUrl` or the item is dropped; `detectInjectionSignals(title)` → `recordAiSecurityEvent` with ids only.
- [ ] **Step 3:** `companyKeysForItem` — explicit organisations (EDGAR, GDELT) → `jobCompanyKeys` → `jobCompanyBucketKey`; title-only sources → capitalised 1–3-token candidates minus a stoplist, never a sentence-initial single word.
- [ ] **Step 4:** Harness on fixtures: sanitisation, dropped `javascript:` URLs, EDGAR extraction, "Stripe acquires Bridge" yields `stripe` and `bridge`, "The Verge reviews…" yields nothing generic. Commit.

### Task 13: Store, sweep, route and cron

**Files:** `src/lib/radar/feeds/{store,sweep}.ts`, `src/app/api/radar/feeds/sweep/route.ts`, `src/lib/cron-runs.ts`, `src/lib/public-routes.ts`, `scripts/smoke-public-routes.ts`, `.github/workflows/ops.yml` (`"37 * * * *"`), `src/lib/ops-sweep.ts`, `src/lib/ops-alerts.ts` (`radarfeeds.schedule_missed`, 6 h), `scripts/smoke-ops-sweep.ts`, `scripts/smoke-radar-feeds-sweep.ts` (pglite)

- [ ] **Step 1:** `store.ts` — chunked upserts (400 per chunk) on `(source_id, external_id)`, company rows `ON CONFLICT DO NOTHING`, `recordSourceOutcome` storing validators only after a complete, untruncated ingest (the rule in `src/lib/jobs/feed-store.ts`), `pruneExternalItems(now − ITEM_TTL_DAYS)`.
- [ ] **Step 2:** `sweep.ts` — **ingest only**: sequential sources under a 210 s shared deadline; `not_modified` → outcome only; `failed` → outcome plus `recordErrorEvent`; parser drift (≥ 20% rejected) → `schema_drift` without storing validators; items older than 14 days dropped; prune at the end.
- [ ] **Step 3:** Route with `maxDuration = 300`, `isInternalRequest`, ledger `radar.feeds`; registry, ops and alert wiring as in Task 5.
- [ ] **Step 4:** Harness with a scripted fetch (pattern `scripts/smoke-job-feed-sweep.ts`): 304, oversize → `too_large` with no validators stored, an idempotent second sweep, pruning. Commit.

### Task 14: News signals in the nightly run

**Files:** `src/lib/radar/signals/news.ts`, `src/lib/ai-operations.ts` (`radar.news_match`, decision tier, background), `src/lib/decisions/catalog.ts`, `scripts/smoke-ai-operations.ts`, `scripts/smoke-radar-run.ts`

- [ ] **Step 1:** `produceNewsSignals(userId, candidates, now)` — candidate companies → `jobCompanyKeys` → bucket keys → one statement: `SELECT i.*, c.company_key FROM external_item_companies c JOIN external_items i ON i.id = c.item_id WHERE c.company_key IN (…) AND c.published_at >= now() - interval '14 days' ORDER BY c.published_at DESC LIMIT 400` → confirm with `companiesMatch`.
- [ ] **Step 2:** Optional decision check — a `noul` question in `catalog.ts` ("Does this headline concern the company named in `company`?"), policy `{engines: ["jev"], budgetMs: 3_000, cacheDays: 30}` via `decide`; rules fallback keeps explicit-organisation sources and requires the capitalised-token check otherwise; `canAct` stays `null`.
- [ ] **Step 3:** Insert `contact_signals` with `dedupe_hash = sha256(userId | contactId | "company_news" | itemId)`, `ON CONFLICT DO NOTHING`, newest first, `NEWS_PER_RUN_CAP = 3`.
- [ ] **Step 4:** Harness: a seeded item for a candidate's company yields a `heads_up` with a source label; a generic-word company yields nothing. Commit.

### Task 15: Job changes

**Files:** `src/lib/radar/signals/job-change.ts`, `src/lib/radar/signals/apollo-recheck.ts`, `src/lib/contact-writes.ts`, `src/actions/contacts.ts`, `src/lib/extension/resolve.ts`, `scripts/smoke-radar-run.ts`

```ts
export type FieldChangeInput = { field: "title" | "company"; from: string | null; to: string };
export function detectJobChange(before: { title: string | null; company: string | null }, after: { title?: string | null; company?: string | null }): FieldChangeInput[];
export async function recordJobChangeSignals(userId: string, contactId: string, changes: FieldChangeInput[], source: "manual" | "apollo" | "extension" | "import", occurredAt?: Date): Promise<number>;
```

- [ ] **Step 1:** `recordJobChangeSignals` cleans values with `cleanSingleLine(…, 200)` and dedupes on `sha256(userId | contactId | field | from | to)`.
- [ ] **Step 2: Hooks** — `updateContactForUser`: a projected pre-read of `{title, company}` only when either is in the input, then fire-and-forget; `refreshContactsFromLinkedIn`: the rows are already loaded, call before the update with source `apollo`; `resolveContactFromPage`: fire-and-forget right after `diffPageAgainstContact`, excluding `location`. No extension contract change.
- [ ] **Step 3: Apollo re-check** — only when `resolveApolloKey` reports a key that is **not hosted**; ≤ 10 inner/mid contacts with a `linkedin_url` per run, keyset cursor `radar_apollo_cursor`, 30-day spacing, `enrichPeopleFromLinkedIn`, diff, signal, never overwrite. The card's "Update record" calls `updateContactForUser`.
- [ ] **Step 4:** Harness: a manual company change yields "Now at Acme"; recording it twice yields one signal; a hosted-key account never calls Apollo. Commit.

### Task 16: Weekly digest

**Files:** `src/lib/radar/digest.ts`, `src/app/api/radar/digest/route.ts`, `src/app/api/radar/digest/unsubscribe/route.ts`, `src/lib/public-routes.ts`, `scripts/smoke-public-routes.ts`, `.github/workflows/ops.yml` (`"13 * * * 1"`), `src/lib/cron-runs.ts` (`radar.digest`), `src/lib/error-events.ts` (`ERROR_SOURCES.radarDigest`), `src/components/radar/radar-settings-panel.tsx`, `src/components/settings/notification-settings.tsx`, `scripts/smoke-radar-digest.ts` (pglite)

- [ ] **Step 1: Selection and week claim** — `radar_digest_enabled AND email IS NOT NULL AND last_active_at > now − 30 d AND` local weekday Monday `AND` local hour 6–9 (`radar_digest_tz`, UTC default) `AND radar_digest_last_week IS DISTINCT FROM $isoWeek`, claimed with one `UPDATE … SET radar_digest_last_week = $isoWeek … RETURNING` so overlapping runs cannot double-send; users with no `today` / `soon` rows are released without mail.
- [ ] **Step 2: Render and send** — top five with reasons, deep links `${getAppBaseUrl()}/radar?focus=<id>`, palette and `escapeHtml` from `src/lib/interest-list-email.ts`, no external URL in the body; lazy `import("resend")` as in `src/lib/broadcasts.ts`, with `List-Unsubscribe` and `List-Unsubscribe-Post` headers; failure → `recordErrorEvent` and un-claim the week.
- [ ] **Step 3: Timezone capture** — `fetchRadar` and `updateRadarSettings` store `resolveTimeZone(orbit-tz cookie)` (`src/lib/reminder-due-bucket.ts`) into `radar_digest_tz` when it differs.
- [ ] **Step 4: Unsubscribe** — GET and POST, opaque token compared by hash (pattern `/api/interest-list/unsubscribe`), sets `radar_digest_enabled = false`; genuinely public in `PUBLIC_ROUTES`.
- [ ] **Step 5: Route and cron** — `maxDuration = 60`, ledger `radar.digest`, the hourly-Monday line.
- [ ] **Step 6: Harness** — New York user at Monday 07:30 local selected; Sunday 11:00 UTC not; a second call the same week selects nobody; no Resend key → `skipped` and the claim released; the HTML contains no external URL. Commit.

### Task 17: Retire the legacy builder (after at least a week of production runs)

**Files:** `src/lib/reminders.ts`, `src/actions/reminders.ts`, `src/components/dashboard/dashboard-sections.tsx`, `src/lib/notification-panel.ts`, `src/lib/chat-attention.ts`, `scripts/smoke-bounded-reads.ts`, `scripts/smoke-batched-writes.ts`, `scripts/smoke-behavior-golden.ts`, `scripts/fixtures/behavior-golden.json`, `scripts/smoke-page-budgets.ts`

- [ ] **Step 1:** `buildOutreachSuggestions` becomes a one-release no-op that deletes pending `AUTO_SUGGESTION_TYPES` rows; remove `ensureOutreachSuggestions` / `maybeRefreshOutreachSuggestions` from `fetchDashboard`; the dashboard, bell and chat read Radar only. Keep the `job_posting_signal` and `score_bump` writers and their readers.
- [ ] **Step 2:** Update the three smokes to the Radar equivalents; re-record `behavior-golden.json` with `--update` from trusted code in a worktree at the commit before the change; dashboard budget back to 16.
- [ ] **Step 3:** Update `docs/performance.md` and `README.md`. Commit.

---

# Phase P2 — Social, autopilot, learning

### Task 18: Social handles and polling

**Files:** `src/lib/duplicates.ts`, `src/db/schema.ts` (`contactIdentities.kind` union), `src/lib/contact-writes.ts` (verify first), `src/actions/contacts.ts` (`setContactSocialHandle`), the contact page, `src/lib/radar/signals/social.ts`, `scripts/smoke-radar-social.ts`

- [ ] **Step 1: Verify** the identity sync in `contact-writes.ts` deletes only the kinds `identityKeysFor` derives. If it deletes every kind, restrict it first; if that is not safe, store the handles as two `contacts` columns instead.
- [ ] **Step 2:** `IDENTITY_KINDS` += `bluesky_handle`, `mastodon_acct`; normalisers (`@` stripped, lower-case, Bluesky must contain a dot, Mastodon as `user@instance`); `setContactSocialHandle` with `source: "user"`; a contact-page field.
- [ ] **Step 3:** `pollSocialForUser(userId, {max: 10})` — Bluesky `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=<handle>&limit=5&filter=posts_no_replies`; Mastodon `https://<instance>/api/v1/accounts/lookup?acct=<user>` then `/api/v1/accounts/<id>/statuses?limit=5&exclude_replies=true`; through `guardedFetchText` with a per-host bucket `consumeBucket("radar.social.host", host, {limit: 60, windowSec: 60})`; handles rotate by `updated_at`; excerpt ≤ 280 via `cleanSingleLine`; post URL via `safeHttpUrl`; `social_post` signals deduped on the post URI. Folded into the run under the per-user deadline.
- [ ] **Step 4:** Harness (parsers on fixtures, caps, HTML stripped, dedupe). Commit.

### Task 19: Extension activity (opt-in)

**Files:** `src/app/api/extension/signals/route.ts`, `src/lib/extension/contract.ts`, `src/lib/extension/contract.schema.ts`, the extension's known-contact panel, `src/components/radar/radar-settings-panel.tsx`

- [ ] **Step 1:** Additive `SignalRequest { contactId, kind: "linkedin_activity", occurredAt?, excerpt ≤ 280, url }` / `SignalResponse { signalId }`; `EXTENSION_CONTRACT_VERSION` stays 1; the route goes through `extensionRoute` and refuses unless `radar_capture_linkedin_activity` is on; slug re-checked against `contacts.linkedin_slug`.
- [ ] **Step 2:** A "Save as Radar activity" button on `post` pages whose author resolves to a known contact, sending the first 280 characters and the capture time ("seen on").
- [ ] **Step 3:** The settings toggle, worded plainly ("Only when you click Save in the extension"). Commit.

### Task 20: Autopilot

**Files:** `src/lib/radar/autopilot.ts`, `src/lib/radar/run.ts`, `src/components/radar/*`, `scripts/smoke-radar-autopilot.ts` (pglite)

- [ ] **Step 1:** `applyAutopilot(userId, todayRecs, {cap: 3})` — for kinds enabled in `radar_autopilot`: `scheduleContactFollowUpForUser(…, 3)` and, when a key exists, `generateContactFollowUpDraft(…, {reuse: true})` stored in `recommendations.draft`; status `auto_applied`; a bell item at `info`. Never for suppressed pairs or when `nextFollowUpAt` is already set. Undo = `clearContactFollowUp` and status back to `pending`.
- [ ] **Step 2:** Confirm `FollowUpDraftSheet` already shows the cached draft (it drafts with `reuse: true` on open) before adding any `initialDraft` prop.
- [ ] **Step 3:** Harness: cap, suppression, undo, and an import assertion that no file under `src/lib/radar/` other than `digest.ts` imports `outreach-send`, `gmail-send` or `resend`. Commit.

### Task 21: Feedback-tuned weights

**Files:** `src/lib/radar/feedback.ts`, `src/lib/radar/score.ts`, `scripts/smoke-radar-score.ts`

- [ ] **Step 1:** `kindMultipliers(userId)` from the last 50 feedback rows: per kind `rate = accepted / (accepted + dismissed)`, `multiplier = clamp(0.85, 1.15, 1 + 0.3 · (rate − 0.5))`, only with ≥ 5 samples; passed as `ScoreContext.kindMultiplier` and surfaced as a chip ("You usually act on these" / "You usually skip these").
- [ ] **Step 2:** Auto-`never` after three dismissals of the same (contact, kind) within 90 days.
- [ ] **Step 3:** Pure cases in the score harness. Commit.

### Task 22: Polish

- [ ] Keyboard triage via `useTriageKeys` (`src/components/reminders/use-triage-keys.ts`).
- [ ] `?focus=<id>` scroll-and-highlight for digest links.
- [ ] An admin health tile for `radar.run` stats; recommendation counts in `src/lib/admin-user-detail.ts`.
- [ ] `e2e/06-radar.spec.ts` in demo mode: seeded fixture → `/radar` shows a card → Schedule 7d creates a reminder.

---

## Verification

Per phase, before pushing:

```bash
npx tsc --noEmit && npm run lint && npm run db:check
npx tsx scripts/smoke-radar-score.ts          # P0, pure
npx tsx scripts/smoke-radar-run.ts            # P0, pglite
npx tsx scripts/smoke-radar-feeds-parse.ts    # P1
npx tsx scripts/smoke-radar-feeds-sweep.ts    # P1
npx tsx scripts/smoke-radar-digest.ts         # P1
npx tsx scripts/smoke-radar-social.ts         # P2
npx tsx scripts/smoke-radar-autopilot.ts      # P2
npm test                                      # whole manifest; CI runs three shards
npm run perf:pages                            # radar section and the raised budgets
```

End to end in demo mode (`npm run dev`, no Clerk keys, AI key optional):

1. `/dashboard` shows the legacy card until the first Radar run, then the Radar preview. `/radar` (with the preview cookie while coming-soon) runs the first inline build and shows cards with reason chips — no why-line without a key, one with a key.
2. Schedule 7d → a pending reminder on `/reminders`. Dismiss → Undo restores. Snooze 1w hides the card. "Not for this person" removes it, and a second `POST /api/radar/run` does not bring it back.
3. `curl -X POST localhost:3000/api/radar/run` (no secret needed in dev) → a `radar_runs` row and a `cron_runs` row `radar.run`; a second call leaves recommendation ids unchanged.
4. P1: `curl -X POST localhost:3000/api/radar/feeds/sweep` → `external_items` rows. A seeded contact at a company in a fixture headline gets a `company_news` signal on the next run and a `heads_up` card with a source label; the bell shows it at info urgency with an in-app link only.
5. P1: a manual company edit produces a `job_change` card. `curl -X POST localhost:3000/api/radar/digest` sends (or logs) one email per eligible user, and none on a second call the same week.
6. P2: with autopilot on for `follow_up`, a run leaves at most three `auto_applied` cards with cached drafts and an Undo that clears the follow-up.
