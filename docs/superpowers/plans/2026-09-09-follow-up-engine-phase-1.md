# Follow-up Reminder Engine — Phase 1 (the spine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Orbit's three unconnected follow-up producers with one engine that detects signals through pure functions, scores them deterministically, and writes a capped daily list of suggestions to `/reminders`.

**Architecture:** Signal sources are pure functions over a `SignalContext` loaded once per user, so thirteen sources cost one set of queries and need no database to test. Scoring is pure and deterministic. A scheduled pass (`POST /api/follow-ups/run`, driven by GitHub Actions) writes rows to `follow_up_suggestions` — **never** to `reminders`, which is what keeps unconfirmed output away from desktop notifications. No LLM and no email in this phase.

**Tech Stack:** Next.js App Router (see `node_modules/next/dist/docs/` — this Next.js differs from training data), Drizzle ORM, Postgres (Neon in production, PGlite locally), TypeScript, `tsx` smoke scripts.

**Spec:** `docs/superpowers/specs/2026-09-09-follow-up-reminder-engine-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **BYOK is absolute in production.** `allowEnvProviderKeys()` returns `!process.env.VERCEL`. No LLM calls in this phase at all, so no task may import `completeJson`.
- **The engine writes `follow_up_suggestions`, never `reminders`.** A suggestion becomes a `reminders` row only on explicit user acceptance. This keeps unconfirmed output out of `listDueNotificationItems` and the ICS feed.
- **Signal sources must not query.** `detect(ctx)` is pure over a preloaded `SignalContext`. Query budgets are enforced by `query-counter.ts` and `smoke-page-budgets.ts`.
- **New tables need the DDL template in `src/db/index.ts` plus a `SCHEMA_VERSION` bump.** The `SCALE_DDL` `alters` list is for columns on existing tables only.
- **`SCHEMA_VERSION` is 32 at time of writing.** Confirm the current value before bumping — parallel branches bump it too, and the file's own comment documents four previous collisions. If 33 is taken, use the next free number and regenerate `scripts/schema-ddl.lock.json`.
- **`scripts/smoke-purge.ts` derives its table list from `schema.ts`.** A new user-scoped table that `purgeUserData` does not delete fails the suite. This has caught five tables already.
- **Every smoke script must be registered in `scripts/run-smoke.ts` with its tier** (`pure` / `pglite` / `manual`). An unregistered script on disk fails the whole suite.
- **PGlite is single-writer.** Stop this worktree's dev server before running any `pglite`-tier script, and never run two at once.
- **`.env` may set `DATABASE_URL` to the shared remote database.** `pglite`-tier scripts must import `./smoke/_env` as their first statement, which forces a temporary local PGlite.
- **Adding a cron line to `ops.yml` raises the cadence of every ungated step.** Any new `schedule` entry requires widening the existing `if:` gates in the same change.
- **`interactions.direction` is nullable and unrecoverable for legacy imports.** "Has messages, all directions NULL" is a third state, never "outbound".
- **Time is always injected, never read from the clock.** Every pure function takes `now: Date`. `daysAgo()` in `duplicates.ts` uses `Date.now()` internally and must not be used in this subsystem.

## Correction to the spec

The spec places the `ops.yml` cron in phase 3. That is wrong: phase 1 builds a scheduler that nothing would invoke, so the pass would never run. The cron moves to **Task 10** of this plan. Phase 3 then only adds the digest to a pass that is already running.

## File structure

**Created — `src/lib/follow-ups/`:**

| File | Responsibility |
|---|---|
| `types.ts` | Every type in the subsystem. No logic, no imports from `@/db`. |
| `time.ts` | `daysBetween(from, to)` and `sameMonthDay` — injected-time date helpers. |
| `registry.ts` | `SIGNAL_TRIGGER`, `BASE_PRIOR`, and the source list. Single source of truth for kinds. |
| `sources/dormant.ts` … `sources/work-anniversary.ts` | One pure source each. |
| `sources/index.ts` | Re-exports; the array the pass iterates. |
| `score.ts` | Weights, recency fit, fusion, the five hard filters. Pure. |
| `context.ts` | The only module here that queries. Loads one `SignalContext`. |
| `pass.ts` | One user's pass: context → detect → score → filter → cap → write. |
| `scheduler.ts` | Claims due users, time budget, run stats. |
| `feedback.ts` | Accept / snooze / dismiss / mute / mark-sent → suppressions + weights. |

**Created — routes, actions, components:**

- `src/app/api/follow-ups/run/route.ts`
- `src/actions/follow-ups.ts`
- `src/components/reminders/today-section.tsx`
- `src/components/reminders/suggestion-card.tsx`

**Created — smoke scripts:** `smoke-follow-up-signals.ts` (pure), `smoke-follow-up-scoring.ts` (pure), `smoke-follow-up-context.ts` (pglite), `smoke-follow-up-pass.ts` (pglite), `smoke-follow-up-feedback.ts` (pglite).

**Modified:** `src/db/schema.ts`, `src/db/index.ts`, `src/lib/user-data.ts`, `src/lib/public-routes.ts`, `src/lib/cron-runs.ts`, `src/lib/reminders.ts` (deletions), `src/actions/reminders.ts`, `src/app/(app)/(main)/reminders/page.tsx`, `src/components/dashboard/dashboard-sections.tsx`, `scripts/run-smoke.ts`, `.github/workflows/ops.yml`.

**Deleted:** `src/components/dashboard/suggested-outreach-card.tsx`, `src/components/dashboard/generate-follow-ups-button.tsx`.

---

### Task 1: Schema — four tables, four columns, purge coverage

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/index.ts` (the `DDL` template string, and `SCHEMA_VERSION`)
- Modify: `src/lib/user-data.ts` (`purgeUserData`)
- Test: `scripts/smoke-schema-ddl.ts` and `scripts/smoke-purge.ts` (both existing)

**Interfaces:**
- Consumes: nothing.
- Produces: Drizzle tables `contactDates`, `followUpSuggestions`, `followUpSuppressions`, `followUpWeights`; types `FollowUpSuggestion = typeof followUpSuggestions.$inferSelect` and `SuggestionStatus = "pending" | "accepted" | "snoozed" | "dismissed" | "expired"`; new `userSettings` columns `timezone`, `followUpDigest`, `followUpDailyCap`, `followUpNextPassAt`.

- [ ] **Step 1: Confirm the current schema version before touching anything**

```bash
grep -n "export const SCHEMA_VERSION" src/db/index.ts
git log --oneline -5 -- src/db/index.ts
```

Expected: prints `export const SCHEMA_VERSION = 32;`. If it prints a higher number, use *that value + 1* everywhere below instead of 33. The file's own comment documents four prior collisions from parallel branches.

- [ ] **Step 2: Add the four tables to `src/db/schema.ts`**

Append near the other reminder tables (after `suggestedReminders`):

```ts
/**
 * Personal dates a human or an import asserted.
 *
 * Deliberately excludes work and "met" anniversaries: both are derivable from
 * `contacts.date_met` / `first_interaction_at` and `contact_experiences.start_year`,
 * and a stored copy goes stale the moment either source changes. Those are computed
 * at detect time by their signal sources instead.
 */
export const contactDates = pgTable(
  "contact_dates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label"),
    labelNormalized: text("label_normalized").default("").notNull(),
    month: integer("month").notNull(),
    day: integer("day").notNull(),
    /** Nullable: Google People returns year-less birthdays constantly. */
    year: integer("year"),
    recurs: boolean("recurs").default(true).notNull(),
    source: text("source").notNull(),
    /** The sentence a note-extracted date came from, so it stays auditable. */
    sourceExcerpt: text("source_excerpt"),
    confidence: integer("confidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("contact_dates_uidx").on(t.userId, t.contactId, t.kind, t.labelNormalized),
    index("contact_dates_monthday_idx").on(t.userId, t.month, t.day),
  ]
);

export type SuggestionStatus =
  | "pending"
  | "accepted"
  | "snoozed"
  | "dismissed"
  | "expired";

/**
 * The engine's output.
 *
 * NEVER a `reminders` row. `listDueNotificationItems` fires desktop notifications off
 * `reminders`, and unconfirmed machine output must not reach it — the same rule
 * `suggested_reminders` exists to enforce. Accepting a suggestion is what creates the
 * `reminders` row, and `reminder_id` links the two.
 */
export const followUpSuggestions = pgTable(
  "follow_up_suggestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** The user-local calendar day this surfaces on. A date, not a timestamp. */
    dueOn: date("due_on").notNull(),
    primaryKind: text("primary_kind").notNull(),
    /** [{ kind, score, evidence }] — every contributing signal, for "why did this surface". */
    signals: jsonb("signals")
      .$type<{ kind: string; score: number; evidence: string }[]>()
      .default([])
      .notNull(),
    score: real("score").notNull(),
    reason: text("reason").notNull(),
    hook: text("hook"),
    /** False until the phase-2 LLM judge exists. */
    judged: boolean("judged").default(false).notNull(),
    status: text("status").$type<SuggestionStatus>().default("pending").notNull(),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    dismissedReason: text("dismissed_reason"),
    reminderId: uuid("reminder_id").references(() => reminders.id, {
      onDelete: "set null",
    }),
    digestSentAt: timestamp("digest_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    // Makes a re-run idempotent. `ops.yml` states its schedule is a floor, not a
    // promise, so a pass CAN fire twice for the same user on the same day.
    uniqueIndex("follow_up_suggestions_uidx").on(
      t.userId,
      t.contactId,
      t.primaryKind,
      t.dueOn
    ),
    index("follow_up_suggestions_user_status_idx").on(t.userId, t.status, t.dueOn),
  ]
);

/**
 * One table for both halves of adaptation: a dismissal writes `until = now + 60d`,
 * an explicit mute writes `until = null`. Implicit learning and explicit control end
 * up as the same mechanism.
 */
export const followUpSuppressions = pgTable(
  "follow_up_suppressions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    /** Null means "every contact". */
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    /** Null means "every kind". */
    kind: text("kind"),
    /** Null means permanent. */
    until: timestamp("until", { withTimezone: true }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("follow_up_suppressions_contact_idx").on(t.userId, t.contactId),
    index("follow_up_suppressions_kind_idx").on(t.userId, t.kind),
  ]
);

/** The learned per-kind multiplier, stored with the counters that justify it. */
export const followUpWeights = pgTable(
  "follow_up_weights",
  {
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    weight: real("weight").default(1).notNull(),
    shown: integer("shown").default(0).notNull(),
    accepted: integer("accepted").default(0).notNull(),
    dismissed: integer("dismissed").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })]
);

export type ContactDate = typeof contactDates.$inferSelect;
export type FollowUpSuggestion = typeof followUpSuggestions.$inferSelect;
export type FollowUpSuppression = typeof followUpSuppressions.$inferSelect;
export type FollowUpWeight = typeof followUpWeights.$inferSelect;
```

Add `date`, `primaryKey`, `real`, `boolean` to the `drizzle-orm/pg-core` import at the top of the file if any are missing.

- [ ] **Step 3: Add the four `user_settings` columns in `src/db/schema.ts`**

Inside the `userSettings` table definition, next to the other preference columns:

```ts
  /** IANA zone, captured from the browser. Null falls back to UTC in the scheduler. */
  timezone: text("timezone"),
  followUpDigest: text("follow_up_digest")
    .$type<"daily" | "weekly" | "off">()
    .default("daily")
    .notNull(),
  followUpDailyCap: integer("follow_up_daily_cap").default(3).notNull(),
  /** The scheduler's claim column, mirroring calendar sync's `next_sync_at`. */
  followUpNextPassAt: timestamp("follow_up_next_pass_at", { withTimezone: true }),
```

- [ ] **Step 4: Add the DDL**

In `src/db/index.ts`, append to the `DDL` template string (after the `events` tables):

```sql
CREATE TABLE IF NOT EXISTS contact_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  label text,
  label_normalized text NOT NULL DEFAULT '',
  month integer NOT NULL,
  day integer NOT NULL,
  year integer,
  recurs boolean NOT NULL DEFAULT true,
  source text NOT NULL,
  source_excerpt text,
  confidence integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contact_dates_uidx
  ON contact_dates (user_id, contact_id, kind, label_normalized);
CREATE INDEX IF NOT EXISTS contact_dates_monthday_idx
  ON contact_dates (user_id, month, day);

CREATE TABLE IF NOT EXISTS follow_up_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  due_on date NOT NULL,
  primary_kind text NOT NULL,
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  score real NOT NULL,
  reason text NOT NULL,
  hook text,
  judged boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  snoozed_until timestamptz,
  dismissed_reason text,
  reminder_id uuid REFERENCES reminders(id) ON DELETE SET NULL,
  digest_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS follow_up_suggestions_uidx
  ON follow_up_suggestions (user_id, contact_id, primary_kind, due_on);
CREATE INDEX IF NOT EXISTS follow_up_suggestions_user_status_idx
  ON follow_up_suggestions (user_id, status, due_on);

CREATE TABLE IF NOT EXISTS follow_up_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  kind text,
  until timestamptz,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS follow_up_suppressions_contact_idx
  ON follow_up_suppressions (user_id, contact_id);
CREATE INDEX IF NOT EXISTS follow_up_suppressions_kind_idx
  ON follow_up_suppressions (user_id, kind);

CREATE TABLE IF NOT EXISTS follow_up_weights (
  user_id text NOT NULL,
  kind text NOT NULL,
  weight real NOT NULL DEFAULT 1,
  shown integer NOT NULL DEFAULT 0,
  accepted integer NOT NULL DEFAULT 0,
  dismissed integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);
```

The four `user_settings` columns go in `SCALE_DDL`, not `DDL` — `CREATE TABLE IF NOT EXISTS` never adds a column to a table that already exists:

```ts
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS timezone text`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS follow_up_digest text NOT NULL DEFAULT 'daily'`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS follow_up_daily_cap integer NOT NULL DEFAULT 3`,
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS follow_up_next_pass_at timestamptz`,
```

- [ ] **Step 5: Bump `SCHEMA_VERSION` and note the feature**

```ts
/*
 * v33 = the follow-up engine: contact_dates, follow_up_suggestions,
 * follow_up_suppressions, follow_up_weights.
 */
export const SCHEMA_VERSION = 33;
```

- [ ] **Step 6: Run the DDL guard and watch it fail on the stale lock**

Run: `npm run db:check`
Expected: FAIL — the fingerprint in `scripts/schema-ddl.lock.json` no longer matches the DDL. This confirms the guard is actually watching.

Note the guard regex-slices source, so a *commented-out* migration still passes it. The only proof the DDL is correct is Step 8 actually running it.

- [ ] **Step 7: Regenerate the lock file, then re-run the guard**

```bash
npx tsx scripts/smoke-schema-ddl.ts --write
npm run db:check
```

Expected: PASS. If `--write` is not a supported flag, open `scripts/smoke-schema-ddl.ts` and follow the regeneration instructions in its header comment.

- [ ] **Step 8: Prove the DDL actually executes against a real database**

```bash
rm -rf /tmp/follow-up-ddl-check && DATABASE_URL= PGLITE_DATA_DIR=/tmp/follow-up-ddl-check npx tsx scripts/setup-db.ts
```

Expected: completes with no error. A syntax error or bad reference in Step 4 fails here and nowhere else.

- [ ] **Step 9: Add the four tables to `purgeUserData`**

In `src/lib/user-data.ts`, before the `reminders` delete (because `follow_up_suggestions.reminder_id` is `ON DELETE SET NULL` — deleting reminders first would rewrite rows on the way to deleting them):

```ts
  // The follow-up engine's four tables. `follow_up_suggestions` goes before `reminders`
  // and `contacts`: its `reminder_id` FK is `set null`, so deleting those first would
  // rewrite every row on the way to deleting it. Weights and suppressions carry no FK to
  // cascade from at all — `follow_up_weights` has no `id` column, only (user_id, kind).
  await db.delete(followUpSuggestions).where(eq(followUpSuggestions.userId, userId));
  await db.delete(followUpSuppressions).where(eq(followUpSuppressions.userId, userId));
  await db.delete(followUpWeights).where(eq(followUpWeights.userId, userId));
  await db.delete(contactDates).where(eq(contactDates.userId, userId));
```

Add the four names to the import block at the top of the file.

- [ ] **Step 10: Run the purge smoke test**

Stop this worktree's dev server first — PGlite is single-writer.

Run: `npx tsx scripts/smoke-purge.ts`
Expected: PASS. It derives its table list from `schema.ts`, so omitting any of the four fails here with the table named.

- [ ] **Step 11: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/db/schema.ts src/db/index.ts src/lib/user-data.ts scripts/schema-ddl.lock.json
git commit -m "feat(follow-ups): schema for the follow-up engine

Four tables (contact_dates, follow_up_suggestions, follow_up_suppressions,
follow_up_weights) plus four user_settings columns. SCHEMA_VERSION 32 -> 33.

follow_up_suggestions is deliberately separate from reminders: desktop
notifications fire off reminders, and unconfirmed machine output must not
reach them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Types, time helpers, registry, and the three ported staleness sources

**Files:**
- Create: `src/lib/follow-ups/types.ts`, `src/lib/follow-ups/time.ts`, `src/lib/follow-ups/registry.ts`
- Create: `src/lib/follow-ups/sources/dormant.ts`, `sources/thread-quiet.ts`, `sources/never-contacted.ts`, `sources/index.ts`
- Create: `scripts/smoke-follow-up-signals.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `ClosenessTier` from `@/db/schema`.
- Produces: `SignalKind`, `SignalTrigger`, `SignalCandidate`, `SignalContext`, `ContactSnapshot`, `InteractionSnapshot`, `SignalSource`; `daysBetween(from, to)`; `SIGNAL_TRIGGER`, `BASE_PRIOR`, `DORMANT_DAYS`; sources `dormantSource`, `threadQuietSource`, `neverContactedSource`.

- [ ] **Step 1: Write `src/lib/follow-ups/types.ts`**

```ts
import type { ClosenessTier } from "@/db/schema";

export type SignalKind =
  | "commitment_due"
  | "scheduled_follow_up"
  | "open_loop"
  | "dormant"
  | "thread_quiet"
  | "post_event"
  | "never_contacted"
  | "met_anniversary"
  | "work_anniversary"
  | "birthday"
  | "personal_date"
  | "job_change"
  | "job_opening";

/**
 * What the signal's evidence actually is.
 *
 * "staleness" means the evidence IS the absence of contact, so recent contact refutes
 * it outright. "date" means the evidence is a dated occurrence independent of contact
 * frequency — talking yesterday does not make it less their birthday. The 7-day hard
 * filter in `score.ts` runs entirely off this distinction.
 */
export type SignalTrigger = "date" | "staleness";

export type ContactSnapshot = {
  id: string;
  fullName: string;
  preferredName: string | null;
  title: string | null;
  company: string | null;
  closenessTier: ClosenessTier | null;
  priorityLevel: number;
  relationshipScore: number;
  constellationPin: "in" | "out" | null;
  dateMet: Date | null;
  firstInteractionAt: Date | null;
  lastInteractionAt: Date | null;
  nextFollowUpAt: Date | null;
};

export type InteractionSnapshot = {
  contactId: string;
  interactionType: string;
  interactionDate: Date;
  /** Null for legacy imports that never persisted the sender. Unrecoverable. */
  direction: "in" | "out" | null;
  /** rawNotes, falling back to aiSummary. */
  text: string;
  actionItems: string[];
};

export type ExperienceSnapshot = {
  contactId: string;
  organization: string;
  isCurrent: boolean;
  startYear: number | null;
  startMonth: number | null;
};

export type ContactDateSnapshot = {
  contactId: string;
  kind: string;
  label: string | null;
  month: number;
  day: number;
  year: number | null;
};

export type EventAttendanceSnapshot = {
  contactId: string;
  eventId: string;
  title: string;
  startsAt: Date;
};

export type DueCommitmentSnapshot = {
  contactId: string;
  title: string;
  dueDate: Date;
};

/**
 * Everything every source needs, loaded exactly once per user.
 *
 * Sources are pure functions over this. They do not query — thirteen sources each
 * running their own queries per contact is the query storm this type exists to prevent.
 */
export type SignalContext = {
  userId: string;
  now: Date;
  contacts: ContactSnapshot[];
  /** Newest first. */
  interactionsByContact: Map<string, InteractionSnapshot[]>;
  experiencesByContact: Map<string, ExperienceSnapshot[]>;
  datesByContact: Map<string, ContactDateSnapshot[]>;
  eventsByContact: Map<string, EventAttendanceSnapshot[]>;
  contactsWithPendingReminder: Set<string>;
  dueCommitments: DueCommitmentSnapshot[];
};

export type SignalCandidate = {
  kind: SignalKind;
  contactId: string;
  /** One short human-readable clause explaining what fired. */
  evidence: string;
  /** The calendar day this should surface on. May be in the future. */
  dueOn: Date;
};

export type SignalSource = {
  kind: SignalKind;
  cadence: "daily" | "opt-in";
  detect(ctx: SignalContext): SignalCandidate[];
};
```

- [ ] **Step 2: Write `src/lib/follow-ups/time.ts`**

```ts
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days between two instants, or null when `from` is missing.
 *
 * Time is injected rather than read from the clock: `daysAgo()` in `duplicates.ts`
 * calls `Date.now()` internally, which makes every source that used it untestable
 * without freezing global time.
 */
export function daysBetween(from: Date | null | undefined, to: Date): number | null {
  if (!from) return null;
  return Math.floor((to.getTime() - new Date(from).getTime()) / DAY_MS);
}

/** Whether two dates fall on the same month and day, ignoring year. */
export function sameMonthDay(a: Date, month: number, day: number): boolean {
  return a.getMonth() + 1 === month && a.getDate() === day;
}

/** Midnight-anchored copy, so `due_on` is a calendar day rather than an instant. */
export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}
```

- [ ] **Step 3: Write `src/lib/follow-ups/registry.ts`**

```ts
import type { SignalKind, SignalTrigger } from "./types";

/**
 * Which side of the 7-day hard filter each kind falls on. Every kind must appear —
 * `Record` makes a missing one a compile error, which is the point.
 */
export const SIGNAL_TRIGGER: Record<SignalKind, SignalTrigger> = {
  commitment_due: "date",
  scheduled_follow_up: "date",
  birthday: "date",
  personal_date: "date",
  met_anniversary: "date",
  work_anniversary: "date",
  job_change: "date",
  open_loop: "staleness",
  dormant: "staleness",
  thread_quiet: "staleness",
  post_event: "staleness",
  never_contacted: "staleness",
  job_opening: "staleness",
};

export const BASE_PRIOR: Record<SignalKind, number> = {
  commitment_due: 95,
  scheduled_follow_up: 90,
  birthday: 85,
  open_loop: 80,
  job_change: 80,
  post_event: 70,
  personal_date: 60,
  work_anniversary: 55,
  met_anniversary: 50,
  thread_quiet: 50,
  job_opening: 45,
  dormant: 45,
  never_contacted: 40,
};

/**
 * Idle days before `dormant` fires, by closeness tier.
 *
 * Replaces a single flat 30-day threshold, which is the main reason today's outreach
 * suggestions read as wrong: a yearly acquaintance and a weekly collaborator are not
 * both overdue on day 31.
 */
export const DORMANT_DAYS: Record<"inner" | "mid" | "outer" | "unknown", number> = {
  inner: 30,
  mid: 90,
  outer: 180,
  unknown: 90,
};
```

- [ ] **Step 4: Write the three sources**

`src/lib/follow-ups/sources/dormant.ts`:

```ts
import { DORMANT_DAYS } from "../registry";
import { daysBetween, startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

export const dormantSource: SignalSource = {
  kind: "dormant",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    for (const c of ctx.contacts) {
      const threshold = DORMANT_DAYS[c.closenessTier ?? "unknown"];
      const idle = daysBetween(c.lastInteractionAt, ctx.now);
      // Null idle means no interaction ever — that is `never_contacted`, not dormancy.
      if (idle === null || idle < threshold) continue;
      out.push({
        kind: "dormant",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `No contact in ${idle} days (${c.closenessTier ?? "unclassified"} tier fires at ${threshold})`,
      });
    }
    return out;
  },
};
```

`src/lib/follow-ups/sources/thread-quiet.ts`:

```ts
import { daysBetween, startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

/**
 * Generalizes the old `linkedin_thread_quiet` to every written channel.
 * Mirrors the `family: "written"` grouping in `src/lib/interaction-types.ts`.
 */
const WRITTEN_TYPES = new Set(["linkedin_message", "email", "message"]);

const MIN_MESSAGES = 2;
const QUIET_MIN_DAYS = 14;
const QUIET_MAX_DAYS = 90;

export const threadQuietSource: SignalSource = {
  kind: "thread_quiet",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    for (const c of ctx.contacts) {
      const written = (ctx.interactionsByContact.get(c.id) ?? []).filter((i) =>
        WRITTEN_TYPES.has(i.interactionType)
      );
      if (written.length < MIN_MESSAGES) continue;
      // Newest first, so [0] is the last message in the thread.
      const days = daysBetween(written[0].interactionDate, ctx.now);
      // Bounded on both ends: past 90 days it is dormancy, not a stalled thread,
      // and `dormant` says that better.
      if (days === null || days < QUIET_MIN_DAYS || days > QUIET_MAX_DAYS) continue;
      out.push({
        kind: "thread_quiet",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `A ${written.length}-message thread went quiet ${days} days ago`,
      });
    }
    return out;
  },
};
```

`src/lib/follow-ups/sources/never-contacted.ts`:

```ts
import { daysBetween, startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

/** Long enough that saving someone and messaging them the same week is not nagged. */
const GRACE_DAYS = 14;

export const neverContactedSource: SignalSource = {
  kind: "never_contacted",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    for (const c of ctx.contacts) {
      if (c.lastInteractionAt) continue;
      if ((ctx.interactionsByContact.get(c.id) ?? []).length > 0) continue;
      const age = daysBetween(c.dateMet, ctx.now);
      if (age === null || age < GRACE_DAYS) continue;
      out.push({
        kind: "never_contacted",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `Saved ${age} days ago, never contacted`,
      });
    }
    return out;
  },
};
```

`src/lib/follow-ups/sources/index.ts`:

```ts
import type { SignalSource } from "../types";
import { dormantSource } from "./dormant";
import { neverContactedSource } from "./never-contacted";
import { threadQuietSource } from "./thread-quiet";

/** Everything the daily pass runs. Tasks 3–5 append to this array. */
export const DAILY_SOURCES: SignalSource[] = [
  dormantSource,
  threadQuietSource,
  neverContactedSource,
];
```

- [ ] **Step 5: Write the failing smoke test**

Create `scripts/smoke-follow-up-signals.ts`:

```ts
/**
 * Every follow-up signal source, against fixture contexts. No DB, no network.
 *
 * Sources are pure functions over a preloaded SignalContext precisely so this file can
 * exist: thirteen detectors, zero database.
 *
 * Run: npx tsx scripts/smoke-follow-up-signals.ts
 */
import { DAILY_SOURCES } from "../src/lib/follow-ups/sources";
import { dormantSource } from "../src/lib/follow-ups/sources/dormant";
import { neverContactedSource } from "../src/lib/follow-ups/sources/never-contacted";
import { threadQuietSource } from "../src/lib/follow-ups/sources/thread-quiet";
import type {
  ContactSnapshot,
  InteractionSnapshot,
  SignalContext,
} from "../src/lib/follow-ups/types";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NOW = new Date("2026-09-09T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

function contact(over: Partial<ContactSnapshot> = {}): ContactSnapshot {
  return {
    id: over.id ?? "c1",
    fullName: "Priya Raman",
    preferredName: null,
    title: "Staff Engineer",
    company: "Acme",
    closenessTier: "mid",
    priorityLevel: 0,
    relationshipScore: 2,
    constellationPin: null,
    dateMet: ago(400),
    firstInteractionAt: ago(400),
    lastInteractionAt: ago(400),
    nextFollowUpAt: null,
    ...over,
  };
}

function ctx(over: Partial<SignalContext> = {}): SignalContext {
  return {
    userId: "u1",
    now: NOW,
    contacts: [],
    interactionsByContact: new Map(),
    experiencesByContact: new Map(),
    datesByContact: new Map(),
    eventsByContact: new Map(),
    contactsWithPendingReminder: new Set(),
    dueCommitments: [],
    ...over,
  };
}

function msg(over: Partial<InteractionSnapshot> = {}): InteractionSnapshot {
  return {
    contactId: "c1",
    interactionType: "linkedin_message",
    interactionDate: ago(30),
    direction: "out",
    text: "sounds good",
    actionItems: [],
    ...over,
  };
}

console.log("\ndormant");
{
  // Tier thresholds are the point of this source: 60 idle days is overdue for an
  // inner-orbit tie and unremarkable for an outer one.
  const inner = contact({ id: "inner", closenessTier: "inner", lastInteractionAt: ago(60) });
  const outer = contact({ id: "outer", closenessTier: "outer", lastInteractionAt: ago(60) });
  const found = dormantSource.detect(ctx({ contacts: [inner, outer] }));
  check("inner tier fires at 60 idle days", found.some((c) => c.contactId === "inner"));
  check("outer tier does not fire at 60 idle days", !found.some((c) => c.contactId === "outer"));

  const never = contact({ id: "never", lastInteractionAt: null });
  check(
    "a contact never interacted with is not dormant",
    dormantSource.detect(ctx({ contacts: [never] })).length === 0
  );

  const unknown = contact({ id: "unk", closenessTier: null, lastInteractionAt: ago(100) });
  check(
    "an unclassified tier falls back to the mid threshold",
    dormantSource.detect(ctx({ contacts: [unknown] })).length === 1
  );
}

console.log("\nthread_quiet");
{
  const c = contact({ id: "q" });
  const two = new Map([["q", [msg({ contactId: "q", interactionDate: ago(30) }), msg({ contactId: "q", interactionDate: ago(45) })]]]);
  check(
    "two written messages quiet for 30 days fires",
    threadQuietSource.detect(ctx({ contacts: [c], interactionsByContact: two })).length === 1
  );

  const one = new Map([["q", [msg({ contactId: "q", interactionDate: ago(30) })]]]);
  check(
    "a single message is not a thread",
    threadQuietSource.detect(ctx({ contacts: [c], interactionsByContact: one })).length === 0
  );

  // Past the upper bound this is dormancy, and `dormant` describes it better.
  const old = new Map([["q", [msg({ contactId: "q", interactionDate: ago(200) }), msg({ contactId: "q", interactionDate: ago(210) })]]]);
  check(
    "a thread quiet beyond 90 days does not fire",
    threadQuietSource.detect(ctx({ contacts: [c], interactionsByContact: old })).length === 0
  );

  const meetings = new Map([
    ["q", [msg({ contactId: "q", interactionType: "meeting", interactionDate: ago(30) }), msg({ contactId: "q", interactionType: "meeting", interactionDate: ago(45) })]],
  ]);
  check(
    "non-written interaction types are not a thread",
    threadQuietSource.detect(ctx({ contacts: [c], interactionsByContact: meetings })).length === 0
  );
}

console.log("\nnever_contacted");
{
  const fresh = contact({ id: "f", lastInteractionAt: null, dateMet: ago(3) });
  check(
    "someone saved 3 days ago is inside the grace window",
    neverContactedSource.detect(ctx({ contacts: [fresh] })).length === 0
  );

  const stale = contact({ id: "s", lastInteractionAt: null, dateMet: ago(30) });
  check(
    "someone saved 30 days ago and never contacted fires",
    neverContactedSource.detect(ctx({ contacts: [stale] })).length === 1
  );

  const contacted = contact({ id: "c", lastInteractionAt: ago(5), dateMet: ago(30) });
  check(
    "someone already contacted never fires",
    neverContactedSource.detect(ctx({ contacts: [contacted] })).length === 0
  );
}

console.log("\nregistry");
{
  const kinds = DAILY_SOURCES.map((s) => s.kind);
  check("no duplicate kinds in DAILY_SOURCES", new Set(kinds).size === kinds.length);
  check("every source is a pure detect function", DAILY_SOURCES.every((s) => typeof s.detect === "function"));
}

console.log("\nAll follow-up signal checks passed.\n");
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx tsx scripts/smoke-follow-up-signals.ts`
Expected: FAIL — `Cannot find module '../src/lib/follow-ups/sources'` if you have not yet created the files, or a specific assertion failure. Do not proceed until you have seen it fail for a reason you understand.

- [ ] **Step 7: Register the script**

In `scripts/run-smoke.ts`, add to the `pure` block (alphabetical):

```ts
  "smoke-follow-up-signals": "pure",
```

- [ ] **Step 8: Run it and watch it pass**

```bash
npx tsx scripts/smoke-follow-up-signals.ts
npx tsx scripts/run-smoke.ts --check
```

Expected: both PASS. `--check` verifies no script on disk is missing from the registry.

- [ ] **Step 9: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/follow-ups scripts/smoke-follow-up-signals.ts scripts/run-smoke.ts
git commit -m "feat(follow-ups): signal types, registry, and three ported staleness sources

dormant, thread_quiet and never_contacted, rewritten as pure functions over a
preloaded SignalContext. dormant's flat 30-day threshold becomes a function of
closeness tier; thread_quiet generalizes beyond LinkedIn to every written channel.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Date-anchored and event sources

**Files:**
- Create: `src/lib/follow-ups/sources/commitment-due.ts`, `sources/scheduled-follow-up.ts`, `sources/post-event.ts`
- Modify: `src/lib/follow-ups/sources/index.ts`
- Modify: `scripts/smoke-follow-up-signals.ts`

**Interfaces:**
- Consumes: `SignalContext`, `SignalCandidate`, `SignalSource`, `daysBetween`, `startOfDay` from Task 2.
- Produces: `commitmentDueSource`, `scheduledFollowUpSource`, `postEventSource`, all appended to `DAILY_SOURCES`.

- [ ] **Step 1: Write the three sources**

`src/lib/follow-ups/sources/commitment-due.ts`:

```ts
import { startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

/**
 * The highest-prior signal: the user said, in their own notes, that they would do this.
 *
 * Reads CONFIRMED commitments only — `ctx.dueCommitments` is loaded from `reminders`
 * rows whose date has arrived, never from `suggested_reminders`, which are unreviewed
 * extractions.
 */
export const commitmentDueSource: SignalSource = {
  kind: "commitment_due",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    const known = new Set(ctx.contacts.map((c) => c.id));
    for (const commitment of ctx.dueCommitments) {
      if (!known.has(commitment.contactId)) continue;
      if (commitment.dueDate > ctx.now) continue;
      out.push({
        kind: "commitment_due",
        contactId: commitment.contactId,
        dueOn: startOfDay(ctx.now),
        evidence: `You committed to this: "${commitment.title}"`,
      });
    }
    return out;
  },
};
```

`src/lib/follow-ups/sources/scheduled-follow-up.ts`:

```ts
import { startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

/**
 * A follow-up date the USER chose.
 *
 * This is now the only meaning `contacts.next_follow_up_at` carries. The old
 * `generateDueFollowUps` stamped it speculatively on eight contacts at a time, which
 * made a system guess and a deliberate choice indistinguishable in the column. The
 * engine reads it and never writes it.
 */
export const scheduledFollowUpSource: SignalSource = {
  kind: "scheduled_follow_up",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    for (const c of ctx.contacts) {
      if (!c.nextFollowUpAt || c.nextFollowUpAt > ctx.now) continue;
      out.push({
        kind: "scheduled_follow_up",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: "You scheduled a follow-up for today or earlier",
      });
    }
    return out;
  },
};
```

`src/lib/follow-ups/sources/post-event.ts`:

```ts
import { daysBetween, startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

/** The window where a new introduction is still warm but no longer same-week. */
const INTRO_MIN_DAYS = 7;
const INTRO_MAX_DAYS = 21;
const EVENT_MIN_DAYS = 2;
const EVENT_MAX_DAYS = 21;

export const postEventSource: SignalSource = {
  kind: "post_event",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    const seen = new Set<string>();

    // Trigger A — a recent first meeting with nothing since.
    for (const c of ctx.contacts) {
      if (!c.firstInteractionAt) continue;
      const days = daysBetween(c.firstInteractionAt, ctx.now);
      if (days === null || days < INTRO_MIN_DAYS || days > INTRO_MAX_DAYS) continue;
      // Anything after the first interaction means the follow-up already happened.
      if (
        c.lastInteractionAt &&
        c.lastInteractionAt.getTime() !== c.firstInteractionAt.getTime()
      ) {
        continue;
      }
      seen.add(c.id);
      out.push({
        kind: "post_event",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `You first met ${days} days ago and nothing has been logged since`,
      });
    }

    // Trigger B — shared event attendance. New in this design; the old heuristic
    // had no access to the events tables.
    for (const [contactId, attended] of ctx.eventsByContact) {
      if (seen.has(contactId)) continue;
      for (const event of attended) {
        const days = daysBetween(event.startsAt, ctx.now);
        if (days === null || days < EVENT_MIN_DAYS || days > EVENT_MAX_DAYS) continue;
        const last = daysBetween(
          ctx.contacts.find((c) => c.id === contactId)?.lastInteractionAt ?? null,
          ctx.now
        );
        // Already spoken since the event — nothing to prompt.
        if (last !== null && last < days) break;
        seen.add(contactId);
        out.push({
          kind: "post_event",
          contactId,
          dueOn: startOfDay(ctx.now),
          evidence: `You were both at ${event.title} ${days} days ago`,
        });
        break;
      }
    }

    return out;
  },
};
```

- [ ] **Step 2: Append them to `DAILY_SOURCES`**

In `src/lib/follow-ups/sources/index.ts`:

```ts
import type { SignalSource } from "../types";
import { commitmentDueSource } from "./commitment-due";
import { dormantSource } from "./dormant";
import { neverContactedSource } from "./never-contacted";
import { postEventSource } from "./post-event";
import { scheduledFollowUpSource } from "./scheduled-follow-up";
import { threadQuietSource } from "./thread-quiet";

export const DAILY_SOURCES: SignalSource[] = [
  commitmentDueSource,
  scheduledFollowUpSource,
  postEventSource,
  dormantSource,
  threadQuietSource,
  neverContactedSource,
];
```

- [ ] **Step 3: Add the failing assertions**

Append to `scripts/smoke-follow-up-signals.ts`, before the final `console.log`, and add the three imports at the top:

```ts
console.log("\ncommitment_due");
{
  const c = contact({ id: "cd" });
  const due = ctx({
    contacts: [c],
    dueCommitments: [{ contactId: "cd", title: "Send the deck", dueDate: ago(1) }],
  });
  const found = commitmentDueSource.detect(due);
  check("a commitment past its date fires", found.length === 1);
  check("the evidence quotes the commitment", found[0].evidence.includes("Send the deck"));

  const future = ctx({
    contacts: [c],
    dueCommitments: [{ contactId: "cd", title: "Send the deck", dueDate: new Date(NOW.getTime() + DAY) }],
  });
  check("a commitment due tomorrow does not fire today", commitmentDueSource.detect(future).length === 0);

  // A commitment whose contact was deleted must not produce an orphan suggestion.
  const orphan = ctx({
    contacts: [],
    dueCommitments: [{ contactId: "gone", title: "x", dueDate: ago(1) }],
  });
  check("a commitment for an unknown contact is skipped", commitmentDueSource.detect(orphan).length === 0);
}

console.log("\nscheduled_follow_up");
{
  const dueToday = contact({ id: "sf", nextFollowUpAt: ago(0) });
  check("a follow-up dated today fires", scheduledFollowUpSource.detect(ctx({ contacts: [dueToday] })).length === 1);

  const later = contact({ id: "sf2", nextFollowUpAt: new Date(NOW.getTime() + 5 * DAY) });
  check("a follow-up five days out does not fire", scheduledFollowUpSource.detect(ctx({ contacts: [later] })).length === 0);

  const none = contact({ id: "sf3", nextFollowUpAt: null });
  check("no scheduled date means no signal", scheduledFollowUpSource.detect(ctx({ contacts: [none] })).length === 0);
}

console.log("\npost_event");
{
  const intro = contact({ id: "pe", firstInteractionAt: ago(10), lastInteractionAt: ago(10), dateMet: ago(10) });
  check("a 10-day-old intro with nothing since fires", postEventSource.detect(ctx({ contacts: [intro] })).length === 1);

  const followed = contact({ id: "pe2", firstInteractionAt: ago(10), lastInteractionAt: ago(2), dateMet: ago(10) });
  check("an intro already followed up does not fire", postEventSource.detect(ctx({ contacts: [followed] })).length === 0);

  const tooFresh = contact({ id: "pe3", firstInteractionAt: ago(2), lastInteractionAt: ago(2), dateMet: ago(2) });
  check("a 2-day-old intro is still inside the window", postEventSource.detect(ctx({ contacts: [tooFresh] })).length === 0);

  // Trigger B: the events path the old heuristic had no access to.
  const attendee = contact({ id: "ev", firstInteractionAt: ago(300), lastInteractionAt: ago(300), dateMet: ago(300) });
  const events = new Map([
    ["ev", [{ contactId: "ev", eventId: "e1", title: "SaaS Summit", startsAt: ago(6) }]],
  ]);
  const found = postEventSource.detect(ctx({ contacts: [attendee], eventsByContact: events }));
  check("shared event attendance fires", found.length === 1);
  check("the evidence names the event", found[0].evidence.includes("SaaS Summit"));

  const spokenSince = contact({ id: "ev2", firstInteractionAt: ago(300), lastInteractionAt: ago(1), dateMet: ago(300) });
  const events2 = new Map([
    ["ev2", [{ contactId: "ev2", eventId: "e2", title: "SaaS Summit", startsAt: ago(6) }]],
  ]);
  check(
    "having spoken since the event suppresses it",
    postEventSource.detect(ctx({ contacts: [spokenSince], eventsByContact: events2 })).length === 0
  );
}
```

Add at the top of the file:

```ts
import { commitmentDueSource } from "../src/lib/follow-ups/sources/commitment-due";
import { postEventSource } from "../src/lib/follow-ups/sources/post-event";
import { scheduledFollowUpSource } from "../src/lib/follow-ups/sources/scheduled-follow-up";
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx tsx scripts/smoke-follow-up-signals.ts`
Expected: PASS, with the three new section headings printed.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/follow-ups scripts/smoke-follow-up-signals.ts
git commit -m "feat(follow-ups): commitment_due, scheduled_follow_up and post_event sources

post_event gains a second trigger from the events tables — shared conference
attendance, which the old heuristic had no access to. scheduled_follow_up reads
contacts.next_follow_up_at and never writes it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The `open_loop` source and its null-direction fallback

**Files:**
- Create: `src/lib/follow-ups/sources/open-loop.ts`
- Modify: `src/lib/follow-ups/sources/index.ts`, `scripts/smoke-follow-up-signals.ts`

**Interfaces:**
- Consumes: `SignalContext`, `InteractionSnapshot`, `daysBetween`, `startOfDay`.
- Produces: `openLoopSource`, plus the exported helper `looksLikeOpenAsk(text: string): boolean` for direct testing.

This is the source that most directly answers "understand the context of the conversation." Its correctness rests on `interactions.direction`, which is **null for every legacy import and unrecoverable** — so "has messages, all directions NULL" must behave as its own case, never as "outbound".

- [ ] **Step 1: Write the source**

`src/lib/follow-ups/sources/open-loop.ts`:

```ts
import { daysBetween, startOfDay } from "../time";
import type { InteractionSnapshot, SignalCandidate, SignalSource } from "../types";

const MIN_DAYS = 7;
const MAX_DAYS = 120;

/**
 * Whether a message plausibly contains an unanswered ask.
 *
 * Deliberately shallow. This is a cheap gate that decides which conversations are worth
 * the phase-2 judge's attention, not a judgement in itself — a false positive costs one
 * shortlist slot, and the judge drops it.
 */
export function looksLikeOpenAsk(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.includes("?")) return true;
  return /\b(let me know|could you|would you|can you|any chance|thoughts on|when you get a chance|waiting on|following up|circle back)\b/i.test(
    t
  );
}

/**
 * Whether the conversation has any usable direction data at all.
 *
 * `interactions.direction` is nullable and, per the schema comment, was never persisted
 * by earlier imports and cannot be reconstructed. A thread of all-NULL directions is a
 * THIRD state — not inbound, not outbound — and guessing either way is wrong.
 */
function hasDirectionData(rows: InteractionSnapshot[]): boolean {
  return rows.some((r) => r.direction !== null);
}

export const openLoopSource: SignalSource = {
  kind: "open_loop",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];

    for (const c of ctx.contacts) {
      const rows = ctx.interactionsByContact.get(c.id) ?? [];
      if (rows.length === 0) continue;

      const latest = rows[0];
      const days = daysBetween(latest.interactionDate, ctx.now);
      if (days === null || days < MIN_DAYS || days > MAX_DAYS) continue;

      if (hasDirectionData(rows)) {
        // The precise path: they spoke last, and it reads like an ask.
        if (latest.direction !== "in") continue;
        if (!looksLikeOpenAsk(latest.text)) continue;
        out.push({
          kind: "open_loop",
          contactId: c.id,
          dueOn: startOfDay(ctx.now),
          evidence: `They wrote last ${days} days ago and it reads like an open ask`,
        });
        continue;
      }

      // Fallback for legacy imports with no direction anywhere. Extracted action items
      // are the only evidence of an open loop that survives without a sender, and they
      // are a weaker signal — a question mark alone is not enough here, because we
      // cannot tell whose question it was.
      const openItems = rows.flatMap((r) => r.actionItems).filter(Boolean);
      if (openItems.length === 0) continue;
      out.push({
        kind: "open_loop",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `An unresolved item from ${days} days ago: "${openItems[0]}"`,
      });
    }

    return out;
  },
};
```

- [ ] **Step 2: Add it to `DAILY_SOURCES`**

In `src/lib/follow-ups/sources/index.ts`, import `openLoopSource` and insert it after `postEventSource` (its base prior of 80 sits between `post_event` at 70 and `scheduled_follow_up` at 90; array order is cosmetic but keeping it prior-descending makes the file readable).

- [ ] **Step 3: Add the failing assertions**

Append to `scripts/smoke-follow-up-signals.ts`:

```ts
console.log("\nopen_loop");
{
  const c = contact({ id: "ol" });

  const inboundQuestion = new Map([
    ["ol", [msg({ contactId: "ol", direction: "in", text: "Any chance you could intro me to Dana?", interactionDate: ago(12) })]],
  ]);
  const found = openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: inboundQuestion }));
  check("an inbound ask 12 days old fires", found.length === 1);

  const outbound = new Map([
    ["ol", [msg({ contactId: "ol", direction: "out", text: "Any chance you could intro me to Dana?", interactionDate: ago(12) })]],
  ]);
  check(
    "the same text sent BY the user is not an open loop",
    openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: outbound })).length === 0
  );

  const chitchat = new Map([
    ["ol", [msg({ contactId: "ol", direction: "in", text: "great seeing you", interactionDate: ago(12) })]],
  ]);
  check(
    "an inbound message with no ask does not fire",
    openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: chitchat })).length === 0
  );

  const tooRecent = new Map([
    ["ol", [msg({ contactId: "ol", direction: "in", text: "can you send that over?", interactionDate: ago(2) })]],
  ]);
  check(
    "an ask from 2 days ago is inside the grace window",
    openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: tooRecent })).length === 0
  );

  // The legacy-import case. This is the one that must not guess.
  const legacyNoItems = new Map([
    ["ol", [msg({ contactId: "ol", direction: null, text: "can you send that over?", interactionDate: ago(12) })]],
  ]);
  check(
    "all-null directions with no action items does NOT fire on a question mark alone",
    openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: legacyNoItems })).length === 0
  );

  const legacyWithItems = new Map([
    ["ol", [msg({ contactId: "ol", direction: null, text: "we talked", actionItems: ["Send Priya the deck"], interactionDate: ago(12) })]],
  ]);
  const legacyFound = openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: legacyWithItems }));
  check("all-null directions WITH an action item fires", legacyFound.length === 1);
  check("the fallback evidence quotes the item", legacyFound[0].evidence.includes("Send Priya the deck"));

  // A thread with SOME direction data uses the precise path, not the fallback.
  const mixed = new Map([
    ["ol", [
      msg({ contactId: "ol", direction: "out", text: "here you go", interactionDate: ago(12) }),
      msg({ contactId: "ol", direction: null, text: "?", actionItems: ["x"], interactionDate: ago(40) }),
    ]],
  ]);
  check(
    "a partially-directioned thread uses the precise path and stays silent",
    openLoopSource.detect(ctx({ contacts: [c], interactionsByContact: mixed })).length === 0
  );
}

console.log("\nlooksLikeOpenAsk");
{
  check("a question mark counts", looksLikeOpenAsk("thoughts?"));
  check("a soft ask phrase counts", looksLikeOpenAsk("let me know when you have a minute"));
  check("a statement does not", !looksLikeOpenAsk("Congrats on the launch"));
  check("empty text does not", !looksLikeOpenAsk("   "));
}
```

Add to the imports at the top:

```ts
import { looksLikeOpenAsk, openLoopSource } from "../src/lib/follow-ups/sources/open-loop";
```

- [ ] **Step 4: Run and verify**

Run: `npx tsx scripts/smoke-follow-up-signals.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/follow-ups scripts/smoke-follow-up-signals.ts
git commit -m "feat(follow-ups): open_loop source with a legacy null-direction fallback

interactions.direction was never persisted by earlier imports and cannot be
recovered, so an all-NULL thread is treated as its own case: it falls back to
extracted action items rather than guessing a sender from a question mark.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Derived anniversary sources

**Files:**
- Create: `src/lib/follow-ups/sources/met-anniversary.ts`, `sources/work-anniversary.ts`
- Modify: `src/lib/follow-ups/sources/index.ts`, `scripts/smoke-follow-up-signals.ts`

**Interfaces:**
- Consumes: `SignalContext`, `sameMonthDay`, `startOfDay`.
- Produces: `metAnniversarySource`, `workAnniversarySource`.

These cost nothing — no new data, no import, no external call. They are computed rather than stored precisely because a stored copy goes stale when `date_met` or an experience row changes.

- [ ] **Step 1: Write both sources**

`src/lib/follow-ups/sources/met-anniversary.ts`:

```ts
import { sameMonthDay, startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

export const metAnniversarySource: SignalSource = {
  kind: "met_anniversary",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    for (const c of ctx.contacts) {
      const anchor = c.dateMet ?? c.firstInteractionAt;
      if (!anchor) continue;
      if (!sameMonthDay(anchor, anchor.getMonth() + 1, anchor.getDate())) continue;
      if (!sameMonthDay(ctx.now, anchor.getMonth() + 1, anchor.getDate())) continue;
      const years = ctx.now.getFullYear() - anchor.getFullYear();
      // Same-year and negative are noise: "you met them 0 years ago today" is just today.
      if (years < 1) continue;
      out.push({
        kind: "met_anniversary",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `You met ${years} year${years === 1 ? "" : "s"} ago today`,
      });
    }
    return out;
  },
};
```

`src/lib/follow-ups/sources/work-anniversary.ts`:

```ts
import { startOfDay } from "../time";
import type { SignalCandidate, SignalSource } from "../types";

/**
 * Derived from `contact_experiences`, which stores start month and year but no day.
 * Fires on the first of the start month — the only day the data actually supports.
 */
export const workAnniversarySource: SignalSource = {
  kind: "work_anniversary",
  cadence: "daily",
  detect(ctx) {
    const out: SignalCandidate[] = [];
    for (const c of ctx.contacts) {
      const current = (ctx.experiencesByContact.get(c.id) ?? []).find((e) => e.isCurrent);
      if (!current?.startYear || !current.startMonth) continue;
      if (ctx.now.getMonth() + 1 !== current.startMonth) continue;
      if (ctx.now.getDate() !== 1) continue;
      const years = ctx.now.getFullYear() - current.startYear;
      if (years < 1) continue;
      out.push({
        kind: "work_anniversary",
        contactId: c.id,
        dueOn: startOfDay(ctx.now),
        evidence: `${years} year${years === 1 ? "" : "s"} at ${current.organization} this month`,
      });
    }
    return out;
  },
};
```

- [ ] **Step 2: Add both to `DAILY_SOURCES`**

Import and append them in `src/lib/follow-ups/sources/index.ts`.

- [ ] **Step 3: Add the assertions**

Append to `scripts/smoke-follow-up-signals.ts` (NOW is 2026-09-09, so the anniversary date is Sept 9 and the work-anniversary day-of-month check will fail — both are exercised deliberately):

```ts
console.log("\nmet_anniversary");
{
  const threeYears = contact({ id: "ma", dateMet: new Date("2023-09-09T12:00:00Z") });
  const found = metAnniversarySource.detect(ctx({ contacts: [threeYears] }));
  check("a three-year anniversary today fires", found.length === 1);
  check("the evidence says three years", found[0].evidence.includes("3 years"));

  const otherDay = contact({ id: "ma2", dateMet: new Date("2023-09-08T12:00:00Z") });
  check("the day before does not fire", metAnniversarySource.detect(ctx({ contacts: [otherDay] })).length === 0);

  const thisYear = contact({ id: "ma3", dateMet: new Date("2026-09-09T12:00:00Z") });
  check("a zero-year anniversary does not fire", metAnniversarySource.detect(ctx({ contacts: [thisYear] })).length === 0);

  const fallback = contact({ id: "ma4", dateMet: null, firstInteractionAt: new Date("2024-09-09T12:00:00Z") });
  check("first_interaction_at is used when date_met is null", metAnniversarySource.detect(ctx({ contacts: [fallback] })).length === 1);
}

console.log("\nwork_anniversary");
{
  const c = contact({ id: "wa" });
  const exp = new Map([
    ["wa", [{ contactId: "wa", organization: "Acme", isCurrent: true, startYear: 2021, startMonth: 9 }]],
  ]);
  // NOW is the 9th, and this source only fires on the 1st — the data has no day.
  check(
    "a matching month on the wrong day does not fire",
    workAnniversarySource.detect(ctx({ contacts: [c], experiencesByContact: exp })).length === 0
  );

  const firstOfMonth = ctx({
    contacts: [c],
    experiencesByContact: exp,
    now: new Date("2026-09-01T12:00:00Z"),
  });
  const found = workAnniversarySource.detect(firstOfMonth);
  check("the first of the start month fires", found.length === 1);
  check("the evidence names the employer", found[0].evidence.includes("Acme"));

  const past = new Map([
    ["wa", [{ contactId: "wa", organization: "Old Co", isCurrent: false, startYear: 2021, startMonth: 9 }]],
  ]);
  check(
    "a past role never fires",
    workAnniversarySource.detect({ ...firstOfMonth, experiencesByContact: past }).length === 0
  );
}
```

Add the two imports at the top of the file.

- [ ] **Step 4: Run, typecheck, commit**

```bash
npx tsx scripts/smoke-follow-up-signals.ts
npx tsc --noEmit
git add src/lib/follow-ups scripts/smoke-follow-up-signals.ts
git commit -m "feat(follow-ups): derived met- and work-anniversary sources

Computed from contacts.date_met and contact_experiences rather than stored, so
they cannot go stale when either source changes. work_anniversary fires on the
first of the start month because the experience data carries no day.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Scoring, the five hard filters, and fusion

**Files:**
- Create: `src/lib/follow-ups/score.ts`
- Create: `scripts/smoke-follow-up-scoring.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `SignalCandidate`, `ContactSnapshot`, `SignalKind` from `types.ts`; `SIGNAL_TRIGGER`, `BASE_PRIOR` from `registry.ts`.
- Produces:
  - `RECENT_CONTACT_DAYS = 7`, `WEIGHT_MIN = 0.25`, `WEIGHT_MAX = 2`, `WEIGHT_MIN_SHOWN = 5`, `SHORTLIST_SIZE = 12`, `RECENCY_REFERENCE_DAYS = 90`
  - `type WeightRow = { kind: string; weight: number; shown: number; accepted: number; dismissed: number }`
  - `type Suppression = { contactId: string | null; kind: string | null; until: Date | null }`
  - `type ScoredSuggestion = { contactId: string; primaryKind: SignalKind; score: number; signals: { kind: SignalKind; score: number; evidence: string }[]; dueOn: Date }`
  - `contactWeight(c)`, `recencyFit(kind, idleDays)`, `userWeight(row, mean)`, `isSuppressed(kind, contactId, suppressions, now)`, `refutedByRecentContact(kind, idleDays)`, `scoreCandidates(input)`

- [ ] **Step 1: Write `src/lib/follow-ups/score.ts`**

```ts
import { BASE_PRIOR, SIGNAL_TRIGGER } from "./registry";
import { daysBetween } from "./time";
import type {
  ContactSnapshot,
  SignalCandidate,
  SignalKind,
} from "./types";

/** Below this many days since the last interaction, staleness signals are refuted. */
export const RECENT_CONTACT_DAYS = 7;
export const WEIGHT_MIN = 0.25;
export const WEIGHT_MAX = 2;
/** A kind's learned weight stays pinned at 1.0 until it has been shown this often. */
export const WEIGHT_MIN_SHOWN = 5;
export const SHORTLIST_SIZE = 12;
export const RECENCY_REFERENCE_DAYS = 90;

export type WeightRow = {
  kind: string;
  weight: number;
  shown: number;
  accepted: number;
  dismissed: number;
};

export type Suppression = {
  /** Null means every contact. */
  contactId: string | null;
  /** Null means every kind. */
  kind: string | null;
  /** Null means permanent — an explicit mute. */
  until: Date | null;
};

export type ScoredSuggestion = {
  contactId: string;
  primaryKind: SignalKind;
  score: number;
  signals: { kind: SignalKind; score: number; evidence: string }[];
  dueOn: Date;
};

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

/** 0.8 – 1.4, from closeness tier and explicit priority. */
export function contactWeight(c: ContactSnapshot): number {
  const tier = c.closenessTier === "inner" ? 0.3 : c.closenessTier === "mid" ? 0.15 : 0;
  const priority = 0.1 * Math.min(Math.max(c.priorityLevel ?? 0, 0), 3);
  return 0.8 + tier + priority;
}

/**
 * Saturating: a contact idle 400 days is not meaningfully more urgent than one idle
 * 180. Date-triggered kinds ignore idleness entirely — a birthday is not more of a
 * birthday because you have not spoken.
 */
export function recencyFit(kind: SignalKind, idleDays: number | null): number {
  if (SIGNAL_TRIGGER[kind] === "date") return 1;
  if (idleDays === null) return 1;
  const saturate = Math.min(Math.max(idleDays, 0) / RECENCY_REFERENCE_DAYS, 2);
  return 0.7 + 0.25 * saturate;
}

/**
 * The learned multiplier.
 *
 * Pinned at 1.0 below WEIGHT_MIN_SHOWN observations: without the pin, one early
 * dismissal permanently kills a signal type for that user. Laplace smoothing keeps a
 * 0-for-5 kind from collapsing to zero.
 */
export function userWeight(
  row: WeightRow | undefined,
  userMeanAcceptRate: number
): number {
  if (!row || row.shown < WEIGHT_MIN_SHOWN) return 1;
  const rate = (row.accepted + 1) / (row.shown + 2);
  const mean = Math.max(0.01, userMeanAcceptRate);
  return clamp(rate / mean, WEIGHT_MIN, WEIGHT_MAX);
}

/** A suppression matches when both its contact and kind constraints match (null = wildcard). */
export function isSuppressed(
  kind: SignalKind,
  contactId: string,
  suppressions: Suppression[],
  now: Date
): boolean {
  return suppressions.some((s) => {
    if (s.until !== null && s.until <= now) return false;
    if (s.contactId !== null && s.contactId !== contactId) return false;
    if (s.kind !== null && s.kind !== kind) return false;
    return true;
  });
}

/**
 * THE most important rule in the engine.
 *
 * "Reach out to Priya, she has gone quiet" the morning after coffee with her is what
 * makes a user disable this feature permanently. Staleness-triggered signals treat the
 * ABSENCE of contact as their evidence, so recent contact refutes them outright.
 * Date-triggered signals are unaffected: talking yesterday does not make it any less
 * their birthday.
 */
export function refutedByRecentContact(
  kind: SignalKind,
  idleDays: number | null
): boolean {
  if (SIGNAL_TRIGGER[kind] === "date") return false;
  return idleDays !== null && idleDays < RECENT_CONTACT_DAYS;
}

export type ScoreInput = {
  now: Date;
  candidates: SignalCandidate[];
  contactsById: Map<string, ContactSnapshot>;
  suppressions: Suppression[];
  weightsByKind: Map<string, WeightRow>;
  contactsWithPendingReminder: Set<string>;
  contactsWithPendingSuggestion: Set<string>;
  shortlistSize?: number;
};

/**
 * Filter, score, fuse per contact, sort, and cut to the shortlist.
 *
 * Returns at most one row per contact: two reasons to message the same person is one
 * card with two reasons, never two cards.
 */
export function scoreCandidates(input: ScoreInput): ScoredSuggestion[] {
  const mean = meanAcceptRate(input.weightsByKind);
  const byContact = new Map<string, ScoredSuggestion>();

  for (const candidate of input.candidates) {
    const contact = input.contactsById.get(candidate.contactId);
    if (!contact) continue;

    // Filter 3 — someone pinned off their own constellation has been explicitly
    // removed from view. This is the one place that pin reaches beyond /graph.
    if (contact.constellationPin === "out") continue;
    // Filters 4 and 5 — never stack a suggestion on an existing one, or on a
    // reminder the user already has for this person.
    if (input.contactsWithPendingSuggestion.has(candidate.contactId)) continue;
    if (input.contactsWithPendingReminder.has(candidate.contactId)) continue;

    const idle = daysBetween(contact.lastInteractionAt, input.now);
    // Filter 1.
    if (refutedByRecentContact(candidate.kind, idle)) continue;
    // Filter 2.
    if (isSuppressed(candidate.kind, candidate.contactId, input.suppressions, input.now)) {
      continue;
    }

    const score =
      BASE_PRIOR[candidate.kind] *
      contactWeight(contact) *
      recencyFit(candidate.kind, idle) *
      userWeight(input.weightsByKind.get(candidate.kind), mean);

    const entry = byContact.get(candidate.contactId);
    if (!entry) {
      byContact.set(candidate.contactId, {
        contactId: candidate.contactId,
        primaryKind: candidate.kind,
        score,
        signals: [{ kind: candidate.kind, score, evidence: candidate.evidence }],
        dueOn: candidate.dueOn,
      });
      continue;
    }

    entry.signals.push({ kind: candidate.kind, score, evidence: candidate.evidence });
    if (score > entry.signals.find((s) => s.kind === entry.primaryKind)!.score) {
      entry.primaryKind = candidate.kind;
      // The winning signal owns the surfacing date: a birthday three days out must
      // not be dragged to today by a dormancy signal riding along with it.
      entry.dueOn = candidate.dueOn;
    }
  }

  // Fusion: three converging reasons should beat one, but must not run away.
  for (const entry of byContact.values()) {
    entry.score = fuse(entry.signals.map((s) => s.score));
    entry.signals.sort((a, b) => b.score - a.score);
  }

  return [...byContact.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, input.shortlistSize ?? SHORTLIST_SIZE);
}

/** max + 15% of everything else, capped at 1.5x max. */
export function fuse(scores: number[]): number {
  if (scores.length === 0) return 0;
  const sorted = [...scores].sort((a, b) => b - a);
  const max = sorted[0];
  const rest = sorted.slice(1).reduce((a, b) => a + b, 0);
  return Math.min(max + 0.15 * rest, max * 1.5);
}

function meanAcceptRate(weights: Map<string, WeightRow>): number {
  const rows = [...weights.values()].filter((r) => r.shown >= WEIGHT_MIN_SHOWN);
  if (rows.length === 0) return 0.2;
  const total = rows.reduce((acc, r) => acc + (r.accepted + 1) / (r.shown + 2), 0);
  return total / rows.length;
}
```

- [ ] **Step 2: Write the failing test**

Create `scripts/smoke-follow-up-scoring.ts`:

```ts
/**
 * Scoring, the five hard filters, fusion, and weight clamping. No DB, no network.
 *
 * Run: npx tsx scripts/smoke-follow-up-scoring.ts
 */
import {
  contactWeight,
  fuse,
  isSuppressed,
  recencyFit,
  refutedByRecentContact,
  scoreCandidates,
  userWeight,
  WEIGHT_MAX,
  WEIGHT_MIN,
  type Suppression,
  type WeightRow,
} from "../src/lib/follow-ups/score";
import type { ContactSnapshot, SignalCandidate } from "../src/lib/follow-ups/types";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const NOW = new Date("2026-09-09T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

function contact(over: Partial<ContactSnapshot> = {}): ContactSnapshot {
  return {
    id: "c1",
    fullName: "Priya Raman",
    preferredName: null,
    title: null,
    company: null,
    closenessTier: "mid",
    priorityLevel: 0,
    relationshipScore: 2,
    constellationPin: null,
    dateMet: ago(400),
    firstInteractionAt: ago(400),
    lastInteractionAt: ago(200),
    nextFollowUpAt: null,
    ...over,
  };
}

function candidate(over: Partial<SignalCandidate> = {}): SignalCandidate {
  return { kind: "dormant", contactId: "c1", evidence: "quiet", dueOn: NOW, ...over };
}

function input(over: Partial<Parameters<typeof scoreCandidates>[0]> = {}) {
  const c = contact();
  return {
    now: NOW,
    candidates: [candidate()],
    contactsById: new Map([[c.id, c]]),
    suppressions: [] as Suppression[],
    weightsByKind: new Map<string, WeightRow>(),
    contactsWithPendingReminder: new Set<string>(),
    contactsWithPendingSuggestion: new Set<string>(),
    ...over,
  };
}

console.log("\ncontactWeight");
{
  check("an outer, unprioritized contact sits at the floor", contactWeight(contact({ closenessTier: "outer" })) === 0.8);
  check("inner tier lifts it", contactWeight(contact({ closenessTier: "inner" })) === 1.1);
  check(
    "priority is capped at 3 so it cannot dominate",
    contactWeight(contact({ closenessTier: "inner", priorityLevel: 9 })) === 1.4
  );
}

console.log("\nrecencyFit");
{
  check("date-triggered kinds ignore idleness", recencyFit("birthday", 0) === 1);
  check("a fresh staleness signal is discounted", recencyFit("dormant", 0) === 0.7);
  check("it saturates rather than growing without bound", recencyFit("dormant", 10_000) === recencyFit("dormant", 180));
}

console.log("\nuserWeight");
{
  check("an unseen kind is neutral", userWeight(undefined, 0.2) === 1);
  const young: WeightRow = { kind: "dormant", weight: 1, shown: 4, accepted: 0, dismissed: 4 };
  check("a kind shown only 4 times stays pinned at 1.0", userWeight(young, 0.2) === 1);
  const hated: WeightRow = { kind: "dormant", weight: 1, shown: 40, accepted: 0, dismissed: 40 };
  check("a consistently dismissed kind is damped", userWeight(hated, 0.5) < 0.5);
  check("but never below the floor", userWeight(hated, 0.5) >= WEIGHT_MIN);
  const loved: WeightRow = { kind: "birthday", weight: 1, shown: 40, accepted: 40, dismissed: 0 };
  check("a consistently accepted kind is boosted but capped", userWeight(loved, 0.05) === WEIGHT_MAX);
}

console.log("\nfuse");
{
  check("one signal fuses to itself", fuse([80]) === 80);
  check("a second signal adds 15% of it", Math.abs(fuse([80, 40]) - 86) < 1e-9);
  check("fusion cannot exceed 1.5x the strongest", fuse([80, 80, 80, 80, 80, 80]) === 120);
  check("no signals is zero", fuse([]) === 0);
}

console.log("\nfilter 1 — recent contact refutes staleness");
{
  check("dormant is refuted 3 days after contact", refutedByRecentContact("dormant", 3));
  check("open_loop is refuted 3 days after contact", refutedByRecentContact("open_loop", 3));
  check("post_event is refuted 3 days after contact", refutedByRecentContact("post_event", 3));
  check("never_contacted is refuted 3 days after contact", refutedByRecentContact("never_contacted", 3));
  check("thread_quiet is refuted 3 days after contact", refutedByRecentContact("thread_quiet", 3));

  check("a birthday survives recent contact", !refutedByRecentContact("birthday", 1));
  check("a commitment survives recent contact", !refutedByRecentContact("commitment_due", 1));
  check("a scheduled follow-up survives recent contact", !refutedByRecentContact("scheduled_follow_up", 1));
  check("a work anniversary survives recent contact", !refutedByRecentContact("work_anniversary", 1));
  check("a met anniversary survives recent contact", !refutedByRecentContact("met_anniversary", 1));

  check("exactly 7 days is outside the window", !refutedByRecentContact("dormant", 7));
  check("never having spoken is not recent contact", !refutedByRecentContact("dormant", null));

  // End to end through scoreCandidates.
  const fresh = contact({ lastInteractionAt: ago(2) });
  const out = scoreCandidates(input({ contactsById: new Map([[fresh.id, fresh]]) }));
  check("scoreCandidates drops a refuted staleness signal", out.length === 0);

  const bday = scoreCandidates(
    input({
      contactsById: new Map([[fresh.id, fresh]]),
      candidates: [candidate({ kind: "birthday", evidence: "turns 40 Thursday" })],
    })
  );
  check("scoreCandidates keeps a date signal after recent contact", bday.length === 1);
}

console.log("\nfilter 2 — suppressions");
{
  const future = new Date(NOW.getTime() + 30 * DAY);
  check("a live contact+kind suppression matches", isSuppressed("dormant", "c1", [{ contactId: "c1", kind: "dormant", until: future }], NOW));
  check("an expired one does not", !isSuppressed("dormant", "c1", [{ contactId: "c1", kind: "dormant", until: ago(1) }], NOW));
  check("a null `until` is a permanent mute", isSuppressed("dormant", "c1", [{ contactId: "c1", kind: null, until: null }], NOW));
  check("a kind-wide mute matches any contact", isSuppressed("dormant", "whoever", [{ contactId: null, kind: "dormant", until: null }], NOW));
  check("it does not match a different kind", !isSuppressed("birthday", "c1", [{ contactId: null, kind: "dormant", until: null }], NOW));
  check("it does not match a different contact", !isSuppressed("dormant", "c2", [{ contactId: "c1", kind: "dormant", until: null }], NOW));
}

console.log("\nfilters 3-5");
{
  const pinnedOut = contact({ constellationPin: "out" });
  check(
    "a contact pinned off the constellation never surfaces",
    scoreCandidates(input({ contactsById: new Map([[pinnedOut.id, pinnedOut]]) })).length === 0
  );
  check(
    "an existing pending reminder blocks a suggestion",
    scoreCandidates(input({ contactsWithPendingReminder: new Set(["c1"]) })).length === 0
  );
  check(
    "an existing pending suggestion blocks a second",
    scoreCandidates(input({ contactsWithPendingSuggestion: new Set(["c1"]) })).length === 0
  );
  check(
    "a candidate for an unknown contact is skipped",
    scoreCandidates(input({ candidates: [candidate({ contactId: "ghost" })] })).length === 0
  );
}

console.log("\nfusion and ordering through scoreCandidates");
{
  const c = contact();
  const two = scoreCandidates(
    input({
      contactsById: new Map([[c.id, c]]),
      candidates: [
        candidate({ kind: "dormant", evidence: "quiet 200 days" }),
        candidate({ kind: "birthday", evidence: "turns 40 Thursday", dueOn: new Date(NOW.getTime() + 2 * DAY) }),
      ],
    })
  );
  check("two signals on one contact produce ONE row", two.length === 1);
  check("both signals are recorded", two[0].signals.length === 2);
  check("the stronger signal becomes primary", two[0].primaryKind === "birthday");
  check("the winning signal owns the surfacing date", two[0].dueOn.getTime() === NOW.getTime() + 2 * DAY);
  check("signals are stored strongest-first", two[0].signals[0].kind === "birthday");

  const a = contact({ id: "a", closenessTier: "inner", priorityLevel: 3 });
  const b = contact({ id: "b", closenessTier: "outer", priorityLevel: 0 });
  const ranked = scoreCandidates(
    input({
      contactsById: new Map([[a.id, a], [b.id, b]]),
      candidates: [candidate({ contactId: "a" }), candidate({ contactId: "b" })],
    })
  );
  check("the closer, higher-priority contact ranks first", ranked[0].contactId === "a");

  const many = Array.from({ length: 40 }, (_, i) => contact({ id: `m${i}` }));
  const capped = scoreCandidates(
    input({
      contactsById: new Map(many.map((m) => [m.id, m])),
      candidates: many.map((m) => candidate({ contactId: m.id })),
    })
  );
  check("the shortlist is cut to 12", capped.length === 12);
}

console.log("\nAll follow-up scoring checks passed.\n");
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx tsx scripts/smoke-follow-up-scoring.ts`
Expected: FAIL until `score.ts` exists and is correct.

- [ ] **Step 4: Register, run, verify**

Add `"smoke-follow-up-scoring": "pure",` to `scripts/run-smoke.ts`, then:

```bash
npx tsx scripts/smoke-follow-up-scoring.ts
npx tsx scripts/run-smoke.ts --check
```

Expected: both PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/follow-ups/score.ts scripts/smoke-follow-up-scoring.ts scripts/run-smoke.ts
git commit -m "feat(follow-ups): deterministic scoring, five hard filters, and fusion

The 7-day rule is the load-bearing one: staleness signals treat the absence of
contact as their evidence, so recent contact refutes them, while date-triggered
signals are unaffected. Learned weights stay pinned at 1.0 below 5 observations
so a single early dismissal cannot kill a signal type.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The context loader

**Files:**
- Create: `src/lib/follow-ups/context.ts`
- Create: `scripts/smoke-follow-up-context.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: every snapshot type from `types.ts`; `Suppression` and `WeightRow` from `score.ts`.
- Produces: `loadSignalContext(userId, now): Promise<SignalContext>` and `loadScoringInputs(userId, now): Promise<{ suppressions: Suppression[]; weightsByKind: Map<string, WeightRow>; contactsWithPendingSuggestion: Set<string>; dailyCap: number }>`.

This is the **only** module in `src/lib/follow-ups/` that queries. Everything else is pure.

- [ ] **Step 1: Write `src/lib/follow-ups/context.ts`**

```ts
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactDates,
  contactExperiences,
  contacts,
  eventAttendees,
  events,
  followUpSuggestions,
  followUpSuppressions,
  followUpWeights,
  interactions,
  reminders,
  userSettings,
} from "@/db/schema";
import type { Suppression, WeightRow } from "./score";
import type {
  ContactDateSnapshot,
  ContactSnapshot,
  EventAttendanceSnapshot,
  ExperienceSnapshot,
  InteractionSnapshot,
  SignalContext,
} from "./types";

/**
 * How far back interactions are read.
 *
 * `thread_quiet` caps at 90 days and `open_loop` at 120, so 400 covers every source
 * with room for the anniversary sources' anchors. Unbounded would mean loading a
 * decade of history to answer a question about the last four months.
 */
const INTERACTION_WINDOW_DAYS = 400;
const INTERACTION_ROW_CAP = 5000;

/**
 * Everything every signal source needs, in a fixed number of statements.
 *
 * This is the whole reason sources are pure functions over a context rather than
 * things that query: thirteen sources each asking about each contact is the query
 * storm `smoke-page-budgets.ts` exists to prevent.
 */
export async function loadSignalContext(
  userId: string,
  now: Date
): Promise<SignalContext> {
  const db = await getDb();
  const windowStart = new Date(now.getTime() - INTERACTION_WINDOW_DAYS * 86_400_000);

  const [
    contactRows,
    interactionRows,
    experienceRows,
    dateRows,
    attendanceRows,
    pendingReminderRows,
  ] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      // Projected to exactly what the snapshot carries. Unprojected, this loads inline
      // avatar data URLs and every note for the whole network.
      columns: {
        id: true,
        fullName: true,
        preferredName: true,
        title: true,
        company: true,
        closenessTier: true,
        priorityLevel: true,
        relationshipScore: true,
        constellationPin: true,
        dateMet: true,
        firstInteractionAt: true,
        lastInteractionAt: true,
        nextFollowUpAt: true,
      },
    }),
    db.query.interactions.findMany({
      where: and(
        eq(interactions.userId, userId),
        gte(interactions.interactionDate, windowStart)
      ),
      columns: {
        contactId: true,
        interactionType: true,
        interactionDate: true,
        direction: true,
        rawNotes: true,
        aiSummary: true,
        actionItems: true,
      },
      orderBy: [desc(interactions.interactionDate)],
      limit: INTERACTION_ROW_CAP,
    }),
    db.query.contactExperiences.findMany({
      where: and(
        eq(contactExperiences.userId, userId),
        eq(contactExperiences.isCurrent, true)
      ),
      columns: {
        contactId: true,
        organization: true,
        isCurrent: true,
        startYear: true,
        startMonth: true,
      },
    }),
    db.query.contactDates.findMany({
      where: eq(contactDates.userId, userId),
      columns: { contactId: true, kind: true, label: true, month: true, day: true, year: true },
    }),
    db
      .select({
        contactId: eventAttendees.contactId,
        eventId: events.id,
        title: events.title,
        startsAt: events.startsAt,
      })
      .from(eventAttendees)
      .innerJoin(events, eq(eventAttendees.eventId, events.id))
      .where(
        and(
          eq(eventAttendees.userId, userId),
          isNotNull(eventAttendees.contactId),
          isNotNull(events.startsAt),
          gte(events.startsAt, windowStart)
        )
      ),
    db.query.reminders.findMany({
      where: and(
        eq(reminders.userId, userId),
        eq(reminders.status, "pending"),
        isNotNull(reminders.contactId)
      ),
      columns: { contactId: true, title: true, dueDate: true },
    }),
  ]);

  const interactionsByContact = new Map<string, InteractionSnapshot[]>();
  for (const row of interactionRows) {
    const list = interactionsByContact.get(row.contactId) ?? [];
    list.push({
      contactId: row.contactId,
      interactionType: row.interactionType,
      interactionDate: row.interactionDate ?? now,
      direction: row.direction,
      text: (row.rawNotes || row.aiSummary || "").trim(),
      actionItems: row.actionItems ?? [],
    });
    interactionsByContact.set(row.contactId, list);
  }
  // The query ordered globally by date, which is per-contact ordering too — but only
  // because every contact's rows keep their relative order inside a stable sort. Sources
  // rely on [0] being the newest, so assert it rather than assume it.
  for (const list of interactionsByContact.values()) {
    list.sort((a, b) => b.interactionDate.getTime() - a.interactionDate.getTime());
  }

  const experiencesByContact = new Map<string, ExperienceSnapshot[]>();
  for (const row of experienceRows) {
    const list = experiencesByContact.get(row.contactId) ?? [];
    list.push(row as ExperienceSnapshot);
    experiencesByContact.set(row.contactId, list);
  }

  const datesByContact = new Map<string, ContactDateSnapshot[]>();
  for (const row of dateRows) {
    const list = datesByContact.get(row.contactId) ?? [];
    list.push(row);
    datesByContact.set(row.contactId, list);
  }

  const eventsByContact = new Map<string, EventAttendanceSnapshot[]>();
  for (const row of attendanceRows) {
    if (!row.contactId || !row.startsAt) continue;
    const list = eventsByContact.get(row.contactId) ?? [];
    list.push({
      contactId: row.contactId,
      eventId: row.eventId,
      title: row.title,
      startsAt: row.startsAt,
    });
    eventsByContact.set(row.contactId, list);
  }

  const contactsWithPendingReminder = new Set<string>();
  const dueCommitments: SignalContext["dueCommitments"] = [];
  for (const row of pendingReminderRows) {
    if (!row.contactId) continue;
    contactsWithPendingReminder.add(row.contactId);
    if (row.dueDate && row.dueDate <= now) {
      dueCommitments.push({ contactId: row.contactId, title: row.title, dueDate: row.dueDate });
    }
  }

  return {
    userId,
    now,
    contacts: contactRows as ContactSnapshot[],
    interactionsByContact,
    experiencesByContact,
    datesByContact,
    eventsByContact,
    contactsWithPendingReminder,
    dueCommitments,
  };
}

/** The scoring-side inputs: suppressions, learned weights, and the user's cap. */
export async function loadScoringInputs(userId: string, now: Date) {
  const db = await getDb();

  const [suppressionRows, weightRows, pendingSuggestionRows, settings] = await Promise.all([
    db.query.followUpSuppressions.findMany({
      where: and(
        eq(followUpSuppressions.userId, userId),
        or(
          sql`${followUpSuppressions.until} IS NULL`,
          gte(followUpSuppressions.until, now)
        )
      ),
      columns: { contactId: true, kind: true, until: true },
    }),
    db.query.followUpWeights.findMany({
      where: eq(followUpWeights.userId, userId),
    }),
    db.query.followUpSuggestions.findMany({
      where: and(
        eq(followUpSuggestions.userId, userId),
        inArray(followUpSuggestions.status, ["pending", "snoozed"])
      ),
      columns: { contactId: true },
    }),
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { followUpDailyCap: true },
    }),
  ]);

  return {
    suppressions: suppressionRows as Suppression[],
    weightsByKind: new Map(weightRows.map((r) => [r.kind, r as WeightRow])),
    contactsWithPendingSuggestion: new Set(pendingSuggestionRows.map((r) => r.contactId)),
    dailyCap: settings?.followUpDailyCap ?? 3,
  };
}
```

- [ ] **Step 2: Write the pglite smoke test**

Create `scripts/smoke-follow-up-context.ts`:

```ts
/**
 * The context loader: shape, grouping, and its statement budget.
 *
 * The budget assertion is the point. Sources are pure over a preloaded context
 * specifically so thirteen detectors cost a fixed number of statements rather than
 * one per contact per source — if this number starts climbing, something started
 * querying that should not have.
 *
 * Run: npx tsx scripts/smoke-follow-up-context.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, userSettings } from "../src/db/schema";
import { loadScoringInputs, loadSignalContext } from "../src/lib/follow-ups/context";
import { ensureUserSettings } from "../src/lib/user-settings";
import { startQueryCount, stopQueryCount } from "../src/lib/query-counter";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-follow-up-context-user";
const NOW = new Date("2026-09-09T12:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

async function main() {
  const db = await getDb();

  // Idempotent teardown first, so a failed previous run cannot poison this one.
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const [priya] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Priya Raman",
      closenessTier: "mid",
      lastInteractionAt: ago(30),
      firstInteractionAt: ago(300),
      dateMet: ago(300),
    })
    .returning({ id: contacts.id });

  await db.insert(interactions).values([
    {
      userId: USER,
      contactId: priya.id,
      interactionType: "linkedin_message",
      interactionDate: ago(30),
      direction: "in",
      rawNotes: "Any chance you could intro me to Dana?",
    },
    {
      userId: USER,
      contactId: priya.id,
      interactionType: "linkedin_message",
      interactionDate: ago(45),
      direction: "out",
      rawNotes: "good to meet you",
    },
    // Outside the 400-day window — must not be loaded.
    {
      userId: USER,
      contactId: priya.id,
      interactionType: "email",
      interactionDate: ago(500),
      direction: "out",
      rawNotes: "ancient history",
    },
  ]);

  console.log("\nshape");
  const ctx = await loadSignalContext(USER, NOW);
  check("the contact is loaded", ctx.contacts.length === 1);
  check("interactions are grouped by contact", ctx.interactionsByContact.get(priya.id)?.length === 2);
  check(
    "the 500-day-old interaction is outside the window",
    !ctx.interactionsByContact.get(priya.id)?.some((i) => i.text === "ancient history")
  );
  check(
    "interactions are newest-first — sources depend on [0]",
    ctx.interactionsByContact.get(priya.id)![0].text.startsWith("Any chance")
  );
  check("direction survives the round trip", ctx.interactionsByContact.get(priya.id)![0].direction === "in");
  check("empty maps are maps, not undefined", ctx.datesByContact instanceof Map && ctx.eventsByContact instanceof Map);
  check("`now` is carried on the context, not read from the clock", ctx.now.getTime() === NOW.getTime());

  console.log("\nstatement budget");
  startQueryCount();
  await loadSignalContext(USER, NOW);
  const contextCount = stopQueryCount();
  console.log(`  statements: ${contextCount}`);
  // Six parallel reads. Raise this deliberately and with a comment, never to make a
  // failing run pass.
  check("loadSignalContext issues <= 8 statements", contextCount <= 8, `got ${contextCount}`);

  startQueryCount();
  await loadScoringInputs(USER, NOW);
  const scoringCount = stopQueryCount();
  console.log(`  statements: ${scoringCount}`);
  check("loadScoringInputs issues <= 5 statements", scoringCount <= 5, `got ${scoringCount}`);

  console.log("\nscoring inputs");
  const inputs = await loadScoringInputs(USER, NOW);
  check("the default daily cap is 3", inputs.dailyCap === 3);
  check("no suppressions on a fresh user", inputs.suppressions.length === 0);
  check("no weights on a fresh user", inputs.weightsByKind.size === 0);

  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));

  console.log("\nAll follow-up context checks passed.\n");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
```

The explicit `process.exit(0)` is required — `tsx` scripts in this repo hang without it.

- [ ] **Step 3: Register and run**

Add `"smoke-follow-up-context": "pglite",` to `scripts/run-smoke.ts`. **Stop this worktree's dev server first** — PGlite is single-writer and an overlapping writer corrupts `.data/pglite` unrecoverably.

```bash
npx tsx scripts/smoke-follow-up-context.ts
```

Expected: PASS, printing both statement counts.

- [ ] **Step 4: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/follow-ups/context.ts scripts/smoke-follow-up-context.ts scripts/run-smoke.ts
git commit -m "feat(follow-ups): the single context loader, with a statement budget

The only querying module in the subsystem. Six parallel reads serve all thirteen
sources; the smoke test asserts the count so a source that starts querying is
caught immediately.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The pass

**Files:**
- Create: `src/lib/follow-ups/pass.ts`
- Create: `scripts/smoke-follow-up-pass.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `loadSignalContext`, `loadScoringInputs`, `DAILY_SOURCES`, `scoreCandidates`.
- Produces: `runFollowUpPass(userId, options?): Promise<PassResult>` where `PassResult = { detected: number; shortlisted: number; written: number }`, and `reasonFor(kind, evidence): string`.

- [ ] **Step 1: Write `src/lib/follow-ups/pass.ts`**

```ts
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { followUpSuggestions, followUpWeights } from "@/db/schema";
import { loadScoringInputs, loadSignalContext } from "./context";
import { scoreCandidates, type ScoredSuggestion } from "./score";
import { DAILY_SOURCES } from "./sources";
import type { SignalCandidate, SignalKind } from "./types";

export type PassResult = {
  /** Candidates emitted by all sources, before filtering. */
  detected: number;
  /** Survivors of the hard filters, capped at the shortlist size. */
  shortlisted: number;
  /** Rows actually written after the daily cap. */
  written: number;
};

/**
 * The rule-generated reason sentence.
 *
 * Phase 2's LLM judge replaces this with something better, but it must always exist:
 * on Vercel a user without their own API key can never run the judge at all, and they
 * still get a full daily list. `evidence` is already a human clause, so the templates
 * frame it rather than restate it.
 */
export function reasonFor(kind: SignalKind, evidence: string): string {
  switch (kind) {
    case "commitment_due":
      return evidence;
    case "scheduled_follow_up":
      return "You set a follow-up for today.";
    case "birthday":
    case "personal_date":
    case "met_anniversary":
    case "work_anniversary":
      return `${evidence}.`;
    case "open_loop":
      return `${evidence} — worth closing the loop.`;
    case "post_event":
      return `${evidence}.`;
    case "thread_quiet":
      return `${evidence}.`;
    case "dormant":
      return `${evidence}.`;
    case "never_contacted":
      return `${evidence} — a first message costs little.`;
    case "job_change":
    case "job_opening":
      return `${evidence}.`;
  }
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * One user's daily pass: load, detect, score, cap, write.
 *
 * Writes ONLY to `follow_up_suggestions`. Never to `reminders` — desktop notifications
 * fire off `reminders`, and machine output the user has not accepted must not reach
 * them. Accepting a suggestion is what creates the reminder.
 */
export async function runFollowUpPass(
  userId: string,
  options: { now?: Date } = {}
): Promise<PassResult> {
  const now = options.now ?? new Date();

  const [ctx, scoringInputs] = await Promise.all([
    loadSignalContext(userId, now),
    loadScoringInputs(userId, now),
  ]);

  const candidates: SignalCandidate[] = [];
  for (const source of DAILY_SOURCES) {
    // A single broken source must not cost the user their whole day.
    try {
      candidates.push(...source.detect(ctx));
    } catch (err) {
      console.error(`follow-ups: source ${source.kind} threw`, err);
    }
  }

  const contactsById = new Map(ctx.contacts.map((c) => [c.id, c]));
  const shortlist = scoreCandidates({
    now,
    candidates,
    contactsById,
    suppressions: scoringInputs.suppressions,
    weightsByKind: scoringInputs.weightsByKind,
    contactsWithPendingReminder: ctx.contactsWithPendingReminder,
    contactsWithPendingSuggestion: scoringInputs.contactsWithPendingSuggestion,
  });

  // Phase 2 inserts the LLM judge here, between the shortlist and the cap.
  const selected = shortlist.slice(0, scoringInputs.dailyCap);

  await writeSuggestions(userId, selected);
  await recordShown(userId, selected);

  return {
    detected: candidates.length,
    shortlisted: shortlist.length,
    written: selected.length,
  };
}

async function writeSuggestions(userId: string, selected: ScoredSuggestion[]) {
  if (selected.length === 0) return;
  const db = await getDb();

  await db
    .insert(followUpSuggestions)
    .values(
      selected.map((s) => ({
        userId,
        contactId: s.contactId,
        dueOn: isoDay(s.dueOn),
        primaryKind: s.primaryKind,
        signals: s.signals,
        score: s.score,
        reason: reasonFor(
          s.primaryKind,
          s.signals.find((x) => x.kind === s.primaryKind)?.evidence ?? ""
        ),
        hook: null,
        judged: false,
        status: "pending" as const,
      }))
    )
    // Idempotency. `ops.yml` states its schedule is a floor, not a promise, so the
    // same pass CAN run twice for one user on one day. Re-running refreshes the score
    // and evidence rather than duplicating the card — and deliberately does NOT touch
    // `status`, so a suggestion the user already dismissed stays dismissed.
    .onConflictDoUpdate({
      target: [
        followUpSuggestions.userId,
        followUpSuggestions.contactId,
        followUpSuggestions.primaryKind,
        followUpSuggestions.dueOn,
      ],
      set: {
        signals: sql`excluded.signals`,
        score: sql`excluded.score`,
        reason: sql`excluded.reason`,
      },
    });
}

/** Every surfaced suggestion increments `shown` for its kind — the denominator of the weight. */
async function recordShown(userId: string, selected: ScoredSuggestion[]) {
  if (selected.length === 0) return;
  const db = await getDb();
  const counts = new Map<string, number>();
  for (const s of selected) {
    counts.set(s.primaryKind, (counts.get(s.primaryKind) ?? 0) + 1);
  }
  for (const [kind, n] of counts) {
    await db
      .insert(followUpWeights)
      .values({ userId, kind, shown: n })
      .onConflictDoUpdate({
        target: [followUpWeights.userId, followUpWeights.kind],
        set: {
          shown: sql`${followUpWeights.shown} + ${n}`,
          updatedAt: new Date(),
        },
      });
  }
}
```

- [ ] **Step 2: Write the pglite smoke test**

Create `scripts/smoke-follow-up-pass.ts`:

```ts
/**
 * The daily pass end to end: detect, score, cap, write, and re-run.
 *
 * The idempotency assertion is the important one. `.github/workflows/ops.yml` states
 * outright that its schedule is a floor rather than a promise, so a pass can fire twice
 * for the same user on the same day, and a duplicated card is the visible symptom.
 *
 * Run: npx tsx scripts/smoke-follow-up-pass.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  followUpSuggestions,
  followUpWeights,
  interactions,
  reminders,
  userSettings,
} from "../src/db/schema";
import { runFollowUpPass } from "../src/lib/follow-ups/pass";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-follow-up-pass-user";
const NOW = new Date("2026-09-09T12:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

async function reset() {
  const db = await getDb();
  await db.delete(followUpSuggestions).where(eq(followUpSuggestions.userId, USER));
  await db.delete(followUpWeights).where(eq(followUpWeights.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function main() {
  const db = await getDb();
  await reset();
  await ensureUserSettings(USER);

  // Six dormant contacts — more than the daily cap of 3, so the cap is exercised.
  const inserted = await db
    .insert(contacts)
    .values(
      Array.from({ length: 6 }, (_, i) => ({
        userId: USER,
        fullName: `Dormant Person ${i}`,
        closenessTier: "inner" as const,
        priorityLevel: i,
        lastInteractionAt: ago(120),
        firstInteractionAt: ago(400),
        dateMet: ago(400),
      }))
    )
    .returning({ id: contacts.id });

  // One contact spoken to two days ago. Filter 1 must drop them.
  const [fresh] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: "Spoke Yesterday",
      closenessTier: "inner",
      lastInteractionAt: ago(2),
      firstInteractionAt: ago(400),
      dateMet: ago(400),
    })
    .returning({ id: contacts.id });

  console.log("\nfirst pass");
  const first = await runFollowUpPass(USER, { now: NOW });
  check("candidates were detected", first.detected > 0);
  check("the daily cap of 3 bounds what is written", first.written === 3, `wrote ${first.written}`);
  check("the shortlist is larger than what was written", first.shortlisted > first.written);

  const rows = await db.query.followUpSuggestions.findMany({
    where: eq(followUpSuggestions.userId, USER),
  });
  check("three rows exist", rows.length === 3);
  check("every row is pending", rows.every((r) => r.status === "pending"));
  check("every row has a human reason", rows.every((r) => r.reason.trim().length > 0));
  check("no row is marked judged in phase 1", rows.every((r) => r.judged === false));
  check("every row records its contributing signals", rows.every((r) => r.signals.length > 0));
  check(
    "the recently-contacted person was filtered out",
    !rows.some((r) => r.contactId === fresh.id)
  );
  check(
    "the highest-priority contacts won the cap",
    rows.every((r) => inserted.slice(3).some((c) => c.id === r.contactId))
  );

  console.log("\nno reminders were written");
  const reminderRows = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check(
    "the engine wrote ZERO reminders rows — desktop notifications stay clean",
    reminderRows.length === 0
  );

  console.log("\nweights");
  const weights = await db.query.followUpWeights.findMany({
    where: eq(followUpWeights.userId, USER),
  });
  check("a weight row was created for the surfaced kind", weights.length === 1);
  check("shown counts the three surfaced cards", weights[0].shown === 3);
  check("nothing was accepted yet", weights[0].accepted === 0);

  console.log("\nsecond pass — idempotency");
  const second = await runFollowUpPass(USER, { now: NOW });
  const afterRows = await db.query.followUpSuggestions.findMany({
    where: eq(followUpSuggestions.userId, USER),
  });
  check("re-running the same day does not duplicate rows", afterRows.length === 3, `got ${afterRows.length}`);
  check("the second pass wrote no NEW contacts", second.written === 0 || afterRows.length === 3);

  console.log("\ndismissed rows survive a re-run");
  await db
    .update(followUpSuggestions)
    .set({ status: "dismissed", resolvedAt: NOW })
    .where(and(eq(followUpSuggestions.userId, USER), eq(followUpSuggestions.id, rows[0].id)));
  await runFollowUpPass(USER, { now: NOW });
  const afterDismiss = await db.query.followUpSuggestions.findFirst({
    where: eq(followUpSuggestions.id, rows[0].id),
  });
  check(
    "a re-run does NOT resurrect a dismissed suggestion",
    afterDismiss?.status === "dismissed"
  );

  await reset();
  console.log("\nAll follow-up pass checks passed.\n");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
```

- [ ] **Step 3: Register and run**

Add `"smoke-follow-up-pass": "pglite",` to `scripts/run-smoke.ts`. Dev server stopped.

```bash
npx tsx scripts/smoke-follow-up-pass.ts
```

Expected: PASS.

- [ ] **Step 4: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/follow-ups/pass.ts scripts/smoke-follow-up-pass.ts scripts/run-smoke.ts
git commit -m "feat(follow-ups): the daily pass

Load, detect, score, cap, write. Writes only to follow_up_suggestions — the smoke
test asserts zero reminders rows, which is what keeps unconfirmed output out of
desktop notifications. An ON CONFLICT update makes a repeat run idempotent
without resurrecting dismissed cards.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Feedback — suppressions, weights, and the six actions

**Files:**
- Create: `src/lib/follow-ups/feedback.ts`
- Create: `scripts/smoke-follow-up-feedback.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Consumes: `followUpSuggestions`, `followUpSuppressions`, `followUpWeights`, `reminders`, `contacts`, `interactions` from `@/db/schema`.
- Produces: `acceptSuggestion(userId, id)`, `snoozeSuggestion(userId, id, days)`, `dismissSuggestion(userId, id, reason)`, `muteContact(userId, contactId)`, `muteKind(userId, kind)`, `markSuggestionSent(userId, id)`, `recomputeWeight(userId, kind)`, and the constants `ACCEPT_SUPPRESSION_DAYS = 30`, `DISMISS_SUPPRESSION_DAYS = 60`.

- [ ] **Step 1: Write `src/lib/follow-ups/feedback.ts`**

```ts
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contacts,
  followUpSuggestions,
  followUpSuppressions,
  followUpWeights,
  interactions,
  reminders,
} from "@/db/schema";
import { WEIGHT_MAX, WEIGHT_MIN, WEIGHT_MIN_SHOWN } from "./score";

/** Acting on a suggestion means this person was just contacted. */
export const ACCEPT_SUPPRESSION_DAYS = 30;
/** Long enough that a rejected reason does not come back next week. */
export const DISMISS_SUPPRESSION_DAYS = 60;

function daysFromNow(days: number, now: Date) {
  return new Date(now.getTime() + days * 86_400_000);
}

async function loadOwned(userId: string, suggestionId: string) {
  const db = await getDb();
  const row = await db.query.followUpSuggestions.findFirst({
    where: and(
      eq(followUpSuggestions.id, suggestionId),
      eq(followUpSuggestions.userId, userId)
    ),
  });
  if (!row) throw new Error("Suggestion not found");
  return row;
}

/**
 * Accept: this is the ONLY path that turns a suggestion into a `reminders` row.
 *
 * Until this runs, the suggestion is invisible to `listDueNotificationItems` and the
 * ICS feed. That boundary is the whole reason `follow_up_suggestions` is a separate
 * table, and it must not be crossed anywhere else.
 */
export async function acceptSuggestion(
  userId: string,
  suggestionId: string,
  options: { now?: Date } = {}
) {
  const now = options.now ?? new Date();
  const db = await getDb();
  const suggestion = await loadOwned(userId, suggestionId);

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, suggestion.contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, preferredName: true },
  });
  if (!contact) throw new Error("Contact not found");

  const name = contact.preferredName?.trim() || contact.fullName;
  const [reminder] = await db
    .insert(reminders)
    .values({
      userId,
      contactId: suggestion.contactId,
      title: `Follow up with ${name}`,
      description: suggestion.reason,
      dueDate: now,
      status: "pending",
      reminderType: "generated",
      actionKind: "follow_up",
      createdBy: "system",
    })
    .returning({ id: reminders.id });

  await db
    .update(followUpSuggestions)
    .set({ status: "accepted", reminderId: reminder.id, resolvedAt: now })
    .where(eq(followUpSuggestions.id, suggestionId));

  // Only now does the engine touch `next_follow_up_at`, and only because the user
  // asked. The old `generateDueFollowUps` wrote it speculatively, which made a system
  // guess indistinguishable from a date the user chose.
  await db
    .update(contacts)
    .set({ nextFollowUpAt: now, followUpStatus: "pending", updatedAt: now })
    .where(and(eq(contacts.id, suggestion.contactId), eq(contacts.userId, userId)));

  await bumpWeight(userId, suggestion.primaryKind, { accepted: 1 });
  await suppress(userId, {
    contactId: suggestion.contactId,
    kind: null,
    until: daysFromNow(ACCEPT_SUPPRESSION_DAYS, now),
    reason: "acted",
  });

  return { reminderId: reminder.id };
}

export async function snoozeSuggestion(
  userId: string,
  suggestionId: string,
  days: number,
  options: { now?: Date } = {}
) {
  const now = options.now ?? new Date();
  const db = await getDb();
  await loadOwned(userId, suggestionId);
  // Same 1..90 clamp as `snoozeReminder` in `src/lib/reminders.ts`. Two paths that
  // both defer a follow-up must not disagree about what a day count means.
  const clamped = Math.max(1, Math.min(90, days));
  await db
    .update(followUpSuggestions)
    .set({ status: "snoozed", snoozedUntil: daysFromNow(clamped, now) })
    .where(eq(followUpSuggestions.id, suggestionId));
}

export async function dismissSuggestion(
  userId: string,
  suggestionId: string,
  reason: "not_now" | "wrong_reason" | "stop_this_kind",
  options: { now?: Date } = {}
) {
  const now = options.now ?? new Date();
  const db = await getDb();
  const suggestion = await loadOwned(userId, suggestionId);

  await db
    .update(followUpSuggestions)
    .set({ status: "dismissed", dismissedReason: reason, resolvedAt: now })
    .where(eq(followUpSuggestions.id, suggestionId));

  await bumpWeight(userId, suggestion.primaryKind, { dismissed: 1 });

  if (reason === "stop_this_kind") {
    // An explicit "never again" is a permanent kind-wide mute, not a timed suppression.
    await muteKind(userId, suggestion.primaryKind);
    return;
  }

  await suppress(userId, {
    contactId: suggestion.contactId,
    // "not_now" is about timing, so it silences this person entirely for a while.
    // "wrong_reason" is about the reason, so it silences only this kind for them.
    kind: reason === "wrong_reason" ? suggestion.primaryKind : null,
    until: daysFromNow(DISMISS_SUPPRESSION_DAYS, now),
    reason: "dismissed",
  });
}

/** Permanent, contact-wide. `until = null` is what makes it a mute rather than a snooze. */
export async function muteContact(userId: string, contactId: string) {
  await suppress(userId, { contactId, kind: null, until: null, reason: "muted_contact" });
}

/** Permanent, kind-wide across every contact. */
export async function muteKind(userId: string, kind: string) {
  await suppress(userId, { contactId: null, kind, until: null, reason: "muted_kind" });
}

/**
 * "I already messaged them, outside Orbit."
 *
 * Logs the interaction rather than only closing the card. Without the interaction the
 * engine still believes nothing happened and re-fires next week — the failure that
 * teaches users to stop trusting it. Logging it also feeds the 7-day hard filter, so
 * the noise filter and the feedback loop end up being the same mechanism.
 */
export async function markSuggestionSent(
  userId: string,
  suggestionId: string,
  options: { now?: Date } = {}
) {
  const now = options.now ?? new Date();
  const db = await getDb();
  const suggestion = await loadOwned(userId, suggestionId);

  await db.insert(interactions).values({
    userId,
    contactId: suggestion.contactId,
    interactionType: "reach_out",
    interactionDate: now,
    direction: "out",
    rawNotes: "Marked as sent from a follow-up suggestion",
  });

  await db
    .update(contacts)
    .set({ lastInteractionAt: now, updatedAt: now })
    .where(and(eq(contacts.id, suggestion.contactId), eq(contacts.userId, userId)));

  await db
    .update(followUpSuggestions)
    .set({ status: "accepted", resolvedAt: now })
    .where(eq(followUpSuggestions.id, suggestionId));

  await bumpWeight(userId, suggestion.primaryKind, { accepted: 1 });
}

async function suppress(
  userId: string,
  row: { contactId: string | null; kind: string | null; until: Date | null; reason: string }
) {
  const db = await getDb();
  await db.insert(followUpSuppressions).values({ userId, ...row });
}

async function bumpWeight(
  userId: string,
  kind: string,
  delta: { accepted?: number; dismissed?: number }
) {
  const db = await getDb();
  const accepted = delta.accepted ?? 0;
  const dismissed = delta.dismissed ?? 0;
  await db
    .insert(followUpWeights)
    .values({ userId, kind, accepted, dismissed })
    .onConflictDoUpdate({
      target: [followUpWeights.userId, followUpWeights.kind],
      set: {
        accepted: sql`${followUpWeights.accepted} + ${accepted}`,
        dismissed: sql`${followUpWeights.dismissed} + ${dismissed}`,
        updatedAt: new Date(),
      },
    });
  await recomputeWeight(userId, kind);
}

/**
 * Recompute one kind's stored multiplier.
 *
 * Mirrors `userWeight` in `score.ts` exactly, including the `WEIGHT_MIN_SHOWN` pin.
 * The stored value is what the admin surface and any future explanation read; scoring
 * itself recomputes from the counters, so the two can never silently drift into
 * disagreement about what the number means.
 */
export async function recomputeWeight(userId: string, kind: string) {
  const db = await getDb();
  const rows = await db.query.followUpWeights.findMany({
    where: eq(followUpWeights.userId, userId),
  });
  const row = rows.find((r) => r.kind === kind);
  if (!row) return;

  if (row.shown < WEIGHT_MIN_SHOWN) {
    await db
      .update(followUpWeights)
      .set({ weight: 1 })
      .where(and(eq(followUpWeights.userId, userId), eq(followUpWeights.kind, kind)));
    return;
  }

  const eligible = rows.filter((r) => r.shown >= WEIGHT_MIN_SHOWN);
  const mean =
    eligible.reduce((acc, r) => acc + (r.accepted + 1) / (r.shown + 2), 0) /
    Math.max(1, eligible.length);
  const rate = (row.accepted + 1) / (row.shown + 2);
  const weight = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, rate / Math.max(0.01, mean)));

  await db
    .update(followUpWeights)
    .set({ weight })
    .where(and(eq(followUpWeights.userId, userId), eq(followUpWeights.kind, kind)));
}
```

- [ ] **Step 2: Write the pglite smoke test**

Create `scripts/smoke-follow-up-feedback.ts`:

```ts
/**
 * The feedback loop: accept, snooze, dismiss, mute, mark-sent.
 *
 * The assertions that matter most are the negative ones — that a dismissed reason does
 * not come back on the next pass, and that a mute never does.
 *
 * Run: npx tsx scripts/smoke-follow-up-feedback.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  followUpSuggestions,
  followUpSuppressions,
  followUpWeights,
  interactions,
  reminders,
  userSettings,
} from "../src/db/schema";
import {
  acceptSuggestion,
  dismissSuggestion,
  markSuggestionSent,
  muteContact,
  snoozeSuggestion,
} from "../src/lib/follow-ups/feedback";
import { runFollowUpPass } from "../src/lib/follow-ups/pass";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-follow-up-feedback-user";
const NOW = new Date("2026-09-09T12:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

async function reset() {
  const db = await getDb();
  await db.delete(followUpSuggestions).where(eq(followUpSuggestions.userId, USER));
  await db.delete(followUpSuppressions).where(eq(followUpSuppressions.userId, USER));
  await db.delete(followUpWeights).where(eq(followUpWeights.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function seedOneDormantContact(name: string) {
  const db = await getDb();
  const [c] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: name,
      closenessTier: "inner",
      lastInteractionAt: ago(120),
      firstInteractionAt: ago(400),
      dateMet: ago(400),
    })
    .returning({ id: contacts.id });
  return c.id;
}

async function main() {
  const db = await getDb();

  console.log("\naccept creates the reminder");
  await reset();
  await ensureUserSettings(USER);
  await seedOneDormantContact("Accept Me");
  await runFollowUpPass(USER, { now: NOW });
  let suggestion = (await db.query.followUpSuggestions.findFirst({
    where: eq(followUpSuggestions.userId, USER),
  }))!;
  check("a suggestion exists before accepting", Boolean(suggestion));

  const before = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("no reminder exists before accepting", before.length === 0);

  const { reminderId } = await acceptSuggestion(USER, suggestion.id, { now: NOW });
  const after = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("accepting creates exactly one reminder", after.length === 1);
  check("the reminder is a follow_up", after[0].actionKind === "follow_up");
  check("the suggestion links to it", (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) }))!.reminderId === reminderId);
  check("the suggestion is marked accepted", (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) }))!.status === "accepted");
  const contactAfter = await db.query.contacts.findFirst({ where: eq(contacts.id, suggestion.contactId) });
  check("accepting sets next_follow_up_at", contactAfter?.nextFollowUpAt !== null);
  const weightAfterAccept = await db.query.followUpWeights.findFirst({ where: eq(followUpWeights.userId, USER) });
  check("accepting increments the accepted counter", weightAfterAccept?.accepted === 1);
  check("acceptance suppresses the contact for 30 days", (await db.query.followUpSuppressions.findMany({ where: eq(followUpSuppressions.userId, USER) })).length === 1);

  console.log("\naccepting keeps them off the next pass");
  await runFollowUpPass(USER, { now: NOW });
  const pendingAfterAccept = await db.query.followUpSuggestions.findMany({
    where: eq(followUpSuggestions.userId, USER),
  });
  check(
    "the accepted contact does not get a fresh pending suggestion",
    pendingAfterAccept.every((r) => r.status !== "pending")
  );

  console.log("\ndismiss suppresses, and the next pass respects it");
  await reset();
  await ensureUserSettings(USER);
  await seedOneDormantContact("Dismiss Me");
  await runFollowUpPass(USER, { now: NOW });
  suggestion = (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.userId, USER) }))!;
  await dismissSuggestion(USER, suggestion.id, "not_now", { now: NOW });
  check("the row is dismissed", (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) }))!.status === "dismissed");
  check("the dismissed counter went up", (await db.query.followUpWeights.findFirst({ where: eq(followUpWeights.userId, USER) }))!.dismissed === 1);

  // 40 days on: the 60-day dismissal suppression is still live.
  await runFollowUpPass(USER, { now: new Date(NOW.getTime() + 40 * DAY) });
  const at40 = await db.query.followUpSuggestions.findMany({ where: eq(followUpSuggestions.userId, USER) });
  check("40 days later the dismissal still holds", at40.every((r) => r.status === "dismissed"));

  // 70 days on: it has expired, so the contact is eligible again.
  await runFollowUpPass(USER, { now: new Date(NOW.getTime() + 70 * DAY) });
  const at70 = await db.query.followUpSuggestions.findMany({ where: eq(followUpSuggestions.userId, USER) });
  check("70 days later the suppression has expired and they resurface", at70.some((r) => r.status === "pending"));

  console.log("\n\"stop this kind\" is permanent");
  await reset();
  await ensureUserSettings(USER);
  await seedOneDormantContact("Stop This Kind");
  await runFollowUpPass(USER, { now: NOW });
  suggestion = (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.userId, USER) }))!;
  await dismissSuggestion(USER, suggestion.id, "stop_this_kind", { now: NOW });
  const kindMute = await db.query.followUpSuppressions.findFirst({ where: eq(followUpSuppressions.userId, USER) });
  check("a kind-wide mute is written", kindMute?.kind === suggestion.primaryKind);
  check("it applies to every contact", kindMute?.contactId === null);
  check("it never expires", kindMute?.until === null);

  await runFollowUpPass(USER, { now: new Date(NOW.getTime() + 400 * DAY) });
  const yearLater = await db.query.followUpSuggestions.findMany({ where: eq(followUpSuggestions.userId, USER) });
  check("400 days later the muted kind still never fires", yearLater.every((r) => r.status !== "pending"));

  console.log("\nmuteContact");
  await reset();
  await ensureUserSettings(USER);
  const mutedId = await seedOneDormantContact("Muted Person");
  await muteContact(USER, mutedId);
  const passAfterMute = await runFollowUpPass(USER, { now: NOW });
  check("a muted contact produces no suggestion", passAfterMute.written === 0);
  check("but they were still detected — the mute is a filter, not a blind spot", passAfterMute.detected > 0);

  console.log("\nsnooze");
  await reset();
  await ensureUserSettings(USER);
  await seedOneDormantContact("Snooze Me");
  await runFollowUpPass(USER, { now: NOW });
  suggestion = (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.userId, USER) }))!;
  await snoozeSuggestion(USER, suggestion.id, 7, { now: NOW });
  const snoozed = await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) });
  check("the row is snoozed", snoozed?.status === "snoozed");
  check("snoozedUntil is seven days out", snoozed?.snoozedUntil?.getTime() === NOW.getTime() + 7 * DAY);
  await snoozeSuggestion(USER, suggestion.id, 9999, { now: NOW });
  const clamped = await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) });
  check("an absurd snooze is clamped to 90 days", clamped?.snoozedUntil?.getTime() === NOW.getTime() + 90 * DAY);

  console.log("\nmarkSuggestionSent logs the interaction");
  await reset();
  await ensureUserSettings(USER);
  await seedOneDormantContact("Sent Outside Orbit");
  await runFollowUpPass(USER, { now: NOW });
  suggestion = (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.userId, USER) }))!;
  await markSuggestionSent(USER, suggestion.id, { now: NOW });
  const logged = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  check("an outbound interaction was logged", logged.length === 1 && logged[0].direction === "out");
  const touched = await db.query.contacts.findFirst({ where: eq(contacts.id, suggestion.contactId) });
  check("last_interaction_at moved to now", touched?.lastInteractionAt?.getTime() === NOW.getTime());
  // This is the payoff: the logged interaction now trips the 7-day filter by itself.
  const passAfterSent = await runFollowUpPass(USER, { now: new Date(NOW.getTime() + 2 * DAY) });
  check("the 7-day filter now suppresses them with no extra bookkeeping", passAfterSent.written === 0);

  await reset();
  console.log("\nAll follow-up feedback checks passed.\n");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
```

- [ ] **Step 3: Register, run, commit**

Add `"smoke-follow-up-feedback": "pglite",` to `scripts/run-smoke.ts`. Dev server stopped.

```bash
npx tsx scripts/smoke-follow-up-feedback.ts
npx tsc --noEmit
git add src/lib/follow-ups/feedback.ts scripts/smoke-follow-up-feedback.ts scripts/run-smoke.ts
git commit -m "feat(follow-ups): the feedback loop

Accept is the only path that creates a reminders row. Dismissals write timed
suppressions, mutes write permanent ones, and both live in the same table. Mark-sent
logs a real interaction so the 7-day filter suppresses the contact by itself.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Scheduler, route, timezone capture, and the cron

**Files:**
- Create: `src/lib/follow-ups/scheduler.ts`, `src/app/api/follow-ups/run/route.ts`, `src/components/settings/timezone-capture.tsx`
- Modify: `src/lib/public-routes.ts`, `src/lib/cron-runs.ts`, `src/actions/settings.ts`, `.github/workflows/ops.yml`, `src/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: `runFollowUpPass` from Task 8.
- Produces: `runFollowUpScheduler(options?): Promise<FollowUpRunStats>` where `FollowUpRunStats = { claimed: number; passed: number; failed: number; written: number; budgetExhausted: boolean }`; `nextPassAt(timezone, now)`; the server action `captureTimezone(zone: string)`.

**Spec correction:** the spec put this cron in phase 3. It belongs here — without it the scheduler built in this task is never invoked and the whole phase is inert.

- [ ] **Step 1: Write `src/lib/follow-ups/scheduler.ts`**

```ts
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { runFollowUpPass } from "./pass";

/** Matches SYNC_TIME_BUDGET_MS — both routes share the same 300s function ceiling. */
export const FOLLOW_UP_TIME_BUDGET_MS = 4.5 * 60 * 1000;
export const USERS_PER_RUN = 20;
/** Local hour the daily pass targets. */
export const PASS_HOUR_LOCAL = 7;

export type FollowUpRunStats = {
  claimed: number;
  passed: number;
  failed: number;
  written: number;
  budgetExhausted: boolean;
};

/**
 * The next 07:00 in the user's zone, as an absolute instant.
 *
 * A null timezone falls back to UTC: degraded (the pass lands at an arbitrary local
 * hour) but correct, and never a reason to skip a user entirely.
 */
export function nextPassAt(timezone: string | null, now: Date): Date {
  const zone = timezone || "UTC";
  // Read the wall-clock hour in the target zone by formatting, which is the only way
  // to do this without pulling in a timezone library.
  let localHour: number;
  try {
    localHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour: "numeric",
        hour12: false,
      }).format(now)
    );
  } catch {
    // An invalid IANA string must not throw the whole pass. Treat it as UTC.
    localHour = now.getUTCHours();
  }

  const hoursUntil = (PASS_HOUR_LOCAL - localHour + 24) % 24 || 24;
  return new Date(now.getTime() + hoursUntil * 60 * 60 * 1000);
}

function deadlineReached(deadline: number) {
  return Date.now() >= deadline;
}

/**
 * One scheduler invocation.
 *
 * Structurally a copy of `runSyncPass` in `src/lib/sync-scheduler.ts`: claim a bounded
 * batch, check the budget BEFORE each item rather than after, and report exhaustion so
 * the route can self-continue.
 */
export async function runFollowUpScheduler(
  options: { now?: Date; budgetMs?: number; limit?: number } = {}
): Promise<FollowUpRunStats> {
  const now = options.now ?? new Date();
  const deadline = Date.now() + (options.budgetMs ?? FOLLOW_UP_TIME_BUDGET_MS);
  const db = await getDb();
  const stats: FollowUpRunStats = {
    claimed: 0,
    passed: 0,
    failed: 0,
    written: 0,
    budgetExhausted: false,
  };

  const due = await db.query.userSettings.findMany({
    where: and(
      or(
        isNull(userSettings.followUpNextPassAt),
        lte(userSettings.followUpNextPassAt, now)
      ),
      isNull(userSettings.suspendedAt)
    ),
    columns: { userId: true, timezone: true },
    limit: options.limit ?? USERS_PER_RUN,
  });
  stats.claimed = due.length;

  for (const user of due) {
    // Before the work, never after — a budget checked afterwards bounds nothing.
    if (deadlineReached(deadline)) {
      stats.budgetExhausted = true;
      break;
    }

    // Claim first. If the pass throws, the user is still rescheduled rather than
    // retried on every invocation forever.
    await db
      .update(userSettings)
      .set({ followUpNextPassAt: nextPassAt(user.timezone, now) })
      .where(eq(userSettings.userId, user.userId));

    try {
      const result = await runFollowUpPass(user.userId, { now });
      stats.passed += 1;
      stats.written += result.written;
    } catch (err) {
      stats.failed += 1;
      console.error(`follow-ups: pass failed for ${user.userId}`, err);
    }
  }

  return stats;
}
```

- [ ] **Step 2: Register the cron job name**

In `src/lib/cron-runs.ts`, extend `CronJobName`:

```ts
export type CronJobName =
  | "imports.process-stalled"
  | "ops.sweep"
  | "sync.run"
  | "webhooks.drain"
  | "followups.run";
```

- [ ] **Step 3: Write the route**

Create `src/app/api/follow-ups/run/route.ts`:

```ts
/**
 * The follow-up engine's scheduled entry point.
 *
 * Driven by `.github/workflows/ops.yml` rather than Vercel Cron: Hobby allows one cron
 * and it belongs to `/api/imports/process-stalled`. Structurally identical to
 * `/api/sync/run`, including posting back to itself when the budget runs out.
 */
import { NextResponse, after } from "next/server";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { runFollowUpScheduler } from "@/lib/follow-ups/scheduler";
import { internalFetch, isInternalRequest } from "@/lib/internal-auth";

export const maxDuration = 300;

export async function POST(request: Request) {
  // Before any write. An unauthenticated probe must not be able to insert ledger rows.
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = await startCronRun("followups.run");
  try {
    const stats = await runFollowUpScheduler();

    if (stats.budgetExhausted) {
      // Best-effort continuation. If it is lost, the next scheduled run picks the
      // remaining users up anyway — their `next_pass_at` is still in the past.
      after(async () => {
        await internalFetch("/api/follow-ups/run", { method: "POST" }).catch(() => null);
      });
    }

    await finishCronRun(handle, {
      // `partial` rather than `ok` when anything failed, so the ops sweep can tell
      // "nothing to do" from "some users are not getting follow-ups".
      status: stats.failed > 0 ? "partial" : "ok",
      stats,
    });

    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "follow-up run failed" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Add the route to `PUBLIC_ROUTES`**

In `src/lib/public-routes.ts`, next to `"/api/sync/run"`:

```ts
  "/api/follow-ups/run",
```

Clerk's middleware blocks anything not listed, and the route's own `isInternalRequest` gate is what actually secures it — fail-closed, exactly as `/api/sync/run` does.

- [ ] **Step 5: Add the timezone-capture server action**

In `src/actions/settings.ts`:

```ts
/**
 * Store the user's IANA timezone, captured from the browser.
 *
 * The scheduler needs a local 07:00 to aim at. Same source as `feedback-report.ts`
 * already uses. Write-once-ish: it updates whenever the browser reports something
 * different, so a permanent move is picked up without a settings screen.
 */
export async function captureTimezone(zone: string) {
  const userId = await requireUserId();
  const trimmed = zone.trim();
  // Validate rather than trust: an invalid zone would make `nextPassAt` fall back to
  // UTC forever, silently.
  if (!trimmed || trimmed.length > 80) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
  } catch {
    return;
  }
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ timezone: trimmed })
    .where(eq(userSettings.userId, userId));
}
```

- [ ] **Step 6: Add the capture component**

Create `src/components/settings/timezone-capture.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { captureTimezone } from "@/actions/settings";

/**
 * Renders nothing. Reports the browser's IANA zone once per mount so the daily
 * follow-up pass can aim at 07:00 local.
 *
 * A client component with no DOM rather than a settings field: asking someone to pick
 * their own timezone from a list is a worse experience than reading it, and the value
 * is only ever used to schedule a background job.
 */
export function TimezoneCapture({ current }: { current: string | null }) {
  useEffect(() => {
    let zone: string | undefined;
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!zone || zone === current) return;
    void captureTimezone(zone);
  }, [current]);

  return null;
}
```

Mount it in `src/app/(app)/layout.tsx`, passing the current value from settings so an unchanged zone costs no server action call.

- [ ] **Step 7: Add the cron — and widen the existing gates in the same edit**

In `.github/workflows/ops.yml`, add to `on.schedule`:

```yaml
    - cron: "23 * * * *"
```

Then add the step:

```yaml
      # The follow-up engine's daily pass. Hourly rather than daily because users are in
      # many timezones and each one's local 07:00 has to fall inside some invocation; the
      # scheduler itself only claims users whose `follow_up_next_pass_at` has arrived, so
      # 23 of every 24 runs are a cheap no-op query.
      - name: Run the follow-up pass (hourly)
        if: github.event.schedule == '23 * * * *' && steps.health.outcome == 'success'
        run: |
          curl -sS --fail-with-body --max-time 300 -X POST \
            -H "Authorization: Bearer $CRON_SECRET" \
            "$APP_URL/api/follow-ups/run"
        env:
          APP_URL: ${{ secrets.APP_URL }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
```

**Now widen the two existing gates.** This is not optional and not cosmetic — the file documents the trap itself. Change both the "Run the ops sweep" and "Drain outbound webhooks" steps from:

```yaml
        if: github.event.schedule != '*/15 * * * *' && steps.health.outcome == 'success'
```

to:

```yaml
        if: github.event.schedule != '*/15 * * * *' && github.event.schedule != '23 * * * *' && steps.health.outcome == 'success'
```

Without this the sweep fires on the new hourly schedule too, taking its cadence from every 10 minutes to roughly every 6 — more alert evaluations and more `cron_runs` rows than anyone chose.

Update the comment block at the top of the file to describe four schedules rather than three.

- [ ] **Step 8: Verify the route rejects an unauthenticated call**

Start the dev server (`npm run dev`), then:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/follow-ups/run
```

Expected: `401`. Then with the secret from `.env`:

```bash
curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/follow-ups/run
```

Expected: `200` with a JSON stats body. Confirm a `cron_runs` row was written for `followups.run`.

- [ ] **Step 9: Validate the workflow YAML**

```bash
python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/ops.yml')); print('schedules:', [s['cron'] for s in d['on']['schedule']]); print('steps:', len(d['jobs']['sweep']['steps']))"
```

Expected: four schedules listed, including `23 * * * *`. A YAML error here fails the whole workflow at parse time, which would silently stop *every* scheduled job — the file's own comment records that happening before.

- [ ] **Step 10: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/follow-ups/scheduler.ts src/app/api/follow-ups/run src/lib/public-routes.ts src/lib/cron-runs.ts src/actions/settings.ts src/components/settings/timezone-capture.tsx "src/app/(app)/layout.tsx" .github/workflows/ops.yml
git commit -m "feat(follow-ups): scheduler, internal route, timezone capture, hourly cron

Claims users whose local 07:00 has arrived, budgets to 4.5 minutes and self-continues,
mirroring /api/sync/run. The new hourly schedule required widening the existing ops.yml
gates in the same change — otherwise the ten-minute sweep silently becomes six-minute.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: The `/reminders` Today section

**Files:**
- Create: `src/actions/follow-ups.ts`, `src/components/reminders/today-section.tsx`, `src/components/reminders/suggestion-card.tsx`
- Modify: `src/app/(app)/(main)/reminders/page.tsx`

**Interfaces:**
- Consumes: everything from `feedback.ts`; `generateContactFollowUpDraft` from `@/lib/follow-up-drafts`.
- Produces: server actions `listTodaySuggestions()`, `acceptSuggestionAction(id)`, `snoozeSuggestionAction(id, days)`, `dismissSuggestionAction(id, reason)`, `muteSuggestionContactAction(id)`, `markSentAction(id)`, `draftForSuggestionAction(id)`; type `TodaySuggestion`.

- [ ] **Step 1: Write `src/actions/follow-ups.ts`**

```ts
"use server";

import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, followUpSuggestions } from "@/db/schema";
import { listActiveGoalTexts } from "@/actions/goals";
import { requireUserId } from "@/lib/auth";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import {
  acceptSuggestion,
  dismissSuggestion,
  markSuggestionSent,
  muteContact,
  muteKind,
  snoozeSuggestion,
} from "@/lib/follow-ups/feedback";
import { generateContactFollowUpDraft } from "@/lib/follow-up-drafts";
import { revalidateReminderPaths } from "@/lib/reminder-paths";

export type TodaySuggestion = {
  id: string;
  contactId: string;
  contactName: string;
  title: string | null;
  company: string | null;
  avatarUrl: string | null;
  primaryKind: string;
  reason: string;
  hook: string | null;
  signals: { kind: string; evidence: string }[];
};

export async function listTodaySuggestions(): Promise<TodaySuggestion[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const rows = await db
    .select({
      id: followUpSuggestions.id,
      contactId: followUpSuggestions.contactId,
      primaryKind: followUpSuggestions.primaryKind,
      reason: followUpSuggestions.reason,
      hook: followUpSuggestions.hook,
      signals: followUpSuggestions.signals,
      score: followUpSuggestions.score,
      fullName: contacts.fullName,
      preferredName: contacts.preferredName,
      title: contacts.title,
      company: contacts.company,
      avatarUrl: clientAvatarUrlSql(),
    })
    .from(followUpSuggestions)
    .innerJoin(contacts, eq(followUpSuggestions.contactId, contacts.id))
    .where(
      and(
        eq(followUpSuggestions.userId, userId),
        lte(followUpSuggestions.dueOn, today),
        or(
          eq(followUpSuggestions.status, "pending"),
          // A snooze that has elapsed is due again, without needing a pass to run.
          and(
            eq(followUpSuggestions.status, "snoozed"),
            lte(followUpSuggestions.snoozedUntil, now)
          )
        )
      )
    )
    .orderBy(sql`${followUpSuggestions.score} DESC`);

  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    contactName: r.preferredName?.trim() || r.fullName,
    title: r.title,
    company: r.company,
    avatarUrl: r.avatarUrl,
    primaryKind: r.primaryKind,
    reason: r.reason,
    hook: r.hook,
    signals: (r.signals ?? []).map((s) => ({ kind: s.kind, evidence: s.evidence })),
  }));
}

export async function acceptSuggestionAction(id: string) {
  const userId = await requireUserId();
  const result = await acceptSuggestion(userId, id);
  revalidateReminderPaths();
  return result;
}

export async function snoozeSuggestionAction(id: string, days: number) {
  const userId = await requireUserId();
  await snoozeSuggestion(userId, id, days);
  revalidateReminderPaths();
}

export async function dismissSuggestionAction(
  id: string,
  reason: "not_now" | "wrong_reason" | "stop_this_kind"
) {
  const userId = await requireUserId();
  await dismissSuggestion(userId, id, reason);
  revalidateReminderPaths();
}

export async function muteSuggestionContactAction(id: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const row = await db.query.followUpSuggestions.findFirst({
    where: and(eq(followUpSuggestions.id, id), eq(followUpSuggestions.userId, userId)),
    columns: { contactId: true },
  });
  if (!row) throw new Error("Suggestion not found");
  await muteContact(userId, row.contactId);
  revalidateReminderPaths();
}

export async function markSentAction(id: string) {
  const userId = await requireUserId();
  await markSuggestionSent(userId, id);
  revalidateReminderPaths();
}

/**
 * Draft a message for a suggestion.
 *
 * The hook is passed through as `intent`, which `generateContactFollowUpDraft` already
 * accepts — so the draft is grounded in the same reason the card is showing rather
 * than being a generic warm follow-up. Drafting does NOT accept the suggestion: the
 * user may read the draft and decide not to send it.
 */
export async function draftForSuggestionAction(id: string) {
  const userId = await requireUserId();
  const db = await getDb();
  const row = await db.query.followUpSuggestions.findFirst({
    where: and(eq(followUpSuggestions.id, id), eq(followUpSuggestions.userId, userId)),
    columns: { contactId: true, hook: true, reason: true },
  });
  if (!row) throw new Error("Suggestion not found");

  const goals = await listActiveGoalTexts();
  return generateContactFollowUpDraft(userId, row.contactId, goals, {
    intent: row.hook?.trim() || row.reason,
  });
}
```

**Note on `"use server"`:** every export in this file must be an `async function`. A single non-async export (a constant, a type re-export) breaks *every* export in the file, and `tsc` will not tell you. `TodaySuggestion` is exported with `export type`, which is erased at compile time and therefore safe.

- [ ] **Step 2: Write the card component**

Create `src/components/reminders/suggestion-card.tsx`. Follow the visual conventions already in `src/components/reminders/reminder-card.tsx` — read it first and match its spacing, typography and glass treatment rather than inventing a new card style.

Required structure, in order: avatar; name; `title · company` as secondary text; a small kind badge; the reason sentence as the primary text; the hook in quotes when present (in phase 1 it is always null, so this renders nothing); then the action row.

Actions, as an optimistic client component:

```tsx
"use client";

import { useState, useTransition } from "react";
import {
  acceptSuggestionAction,
  dismissSuggestionAction,
  draftForSuggestionAction,
  markSentAction,
  muteSuggestionContactAction,
  snoozeSuggestionAction,
  type TodaySuggestion,
} from "@/actions/follow-ups";
```

Buttons: **Draft** (primary), **Remind me**, **Snooze** (a menu offering 3 days / 1 week / 1 month), **Dismiss** (a menu offering the three reasons), and an overflow with **Mute this contact** and **I already messaged them**.

Use `useState` for the pending flag, not `useTransition` alone — this repo has a documented case where `useTransition` state was the wrong tool for tracking in-flight server work and produced a stuck UI.

- [ ] **Step 3: Write the section wrapper**

Create `src/components/reminders/today-section.tsx`: a server component that calls `listTodaySuggestions()`, returns `null` when empty (an empty "Today" heading is worse than no heading), and otherwise renders a heading plus the cards.

- [ ] **Step 4: Mount it in the page**

In `src/app/(app)/(main)/reminders/page.tsx`, add it above `SuggestedRemindersSection` inside its own `<Suspense fallback={null}>` boundary, matching the pattern already used there so an extra query never delays the reminders list:

```tsx
      <Suspense fallback={null}>
        <TodaySection />
      </Suspense>
```

`SuggestedRemindersPanel` stays exactly where it is. Unconfirmed commitments extracted from the user's own notes are a review queue — a different question from "who should you talk to today" — and merging them would muddle both.

- [ ] **Step 5: Verify in the browser**

Seed data and run a pass for your dev user, then start the dev server and check `/reminders` renders the Today section. Verify with the Browser pane rather than asking anyone to look:

1. `preview_start` the dev server.
2. `read_page` on `/reminders` — confirm the Today heading and one card per suggestion.
3. Click **Snooze → 1 week**, then `read_page` again and confirm the card is gone.
4. Click **Remind me** on another, and confirm a reminder appears in the list below.
5. `read_console_messages` — confirm no errors.

**Before starting the dev server, check whether one is already running for this worktree.** A build or a second `next dev` sharing one `.next` directory wedges it, and the symptom is lazy components silently never mounting while chunks still return 200.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit
npx eslint src/actions/follow-ups.ts src/components/reminders --max-warnings=100
git add src/actions/follow-ups.ts src/components/reminders "src/app/(app)/(main)/reminders/page.tsx"
git commit -m "feat(follow-ups): the /reminders Today section

Cards carry the reason and every contributing signal. Draft passes the hook through
as generateContactFollowUpDraft's existing intent parameter, so the message is
grounded in the reason the card fired rather than being a generic warm follow-up.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

ESLint baseline for this repo is 0 errors and roughly 36 warnings — any *error* is yours.

---

### Task 12: Dashboard consolidation and retiring the old system

**Files:**
- Modify: `src/lib/reminders.ts`, `src/actions/reminders.ts`, `src/components/dashboard/dashboard-sections.tsx`
- Delete: `src/components/dashboard/suggested-outreach-card.tsx`, `src/components/dashboard/generate-follow-ups-button.tsx`
- Test: `scripts/run-smoke.ts` (full suite)

**Interfaces:**
- Consumes: `listTodaySuggestions` from Task 11.
- Produces: nothing new. This task only removes.

This is the task that makes phase 1 a replacement rather than a second opinion. Do it last, and do it completely — leaving both systems running means two producers can nominate the same contact, which is exactly the dedupe problem the design exists to avoid.

- [ ] **Step 1: Delete the old producers from `src/lib/reminders.ts`**

Remove entirely: `AUTO_SUGGESTION_TYPES`, `MAX_AUTO_SUGGESTIONS`, `AUTO_TYPE_PRIORITY`, `isDiscoveryEligible`, `suggestionRefreshInFlight`, `refreshOutreachSuggestions`, `buildOutreachSuggestions`, `followUpCandidateScore`, `generateDueFollowUps`, `SUGGESTION_REFRESH_TTL_MS`, `ensureOutreachSuggestions`, `maybeRefreshOutreachSuggestions`.

Keep `getDashboardData`, `snoozeReminder` and `completeReminder`. Remove the `aiSuggestions` reads from `getDashboardData` that served only the retired suggestion types — leave any `score_bump` handling intact, since those come from enrichment and are unrelated to outreach.

- [ ] **Step 2: Remove the call sites in `src/actions/reminders.ts`**

Delete the imports of the five removed functions and the `fetchDashboard` logic that cold-started or refreshed the suggestion queue. `fetchDashboard` becomes a plain read.

- [ ] **Step 3: Find every remaining reference**

```bash
grep -rn "refreshOutreachSuggestions\|ensureOutreachSuggestions\|maybeRefreshOutreachSuggestions\|generateDueFollowUps\|buildOutreachSuggestions\|dormant_high_value\|linkedin_thread_quiet\|post_event" --include="*.ts" --include="*.tsx" src/ scripts/ extension/
```

Expected after this task: hits only inside `src/lib/follow-ups/` (where `post_event` is now a `SignalKind`) and its smoke scripts. Every other hit is a call site you still have to remove. Check `scripts/smoke-app-pulse.ts`, `scripts/smoke-page-budgets.ts` and `scripts/seed-demo.ts` in particular — all three reference the dashboard suggestion path.

- [ ] **Step 4: Collapse the two dashboard sections into one**

In `src/components/dashboard/dashboard-sections.tsx`, replace `SuggestedOutreachSection` and `RemindersAndFollowUpsSection` with a single `TodayGlanceSection` that calls `listTodaySuggestions()`, shows the top 3 with name and reason, and links to `/reminders`.

Update `src/app/(app)/(main)/dashboard/page.tsx` to render one section where it rendered two, and remove the now-unused Suspense fallback that paired them.

Then delete the two dead components:

```bash
git rm src/components/dashboard/suggested-outreach-card.tsx src/components/dashboard/generate-follow-ups-button.tsx
```

- [ ] **Step 5: Confirm nothing references the deleted components**

```bash
grep -rn "suggested-outreach-card\|generate-follow-ups-button\|SuggestedOutreachCard\|GenerateFollowUpsButton" --include="*.ts" --include="*.tsx" src/
```

Expected: no output.

- [ ] **Step 6: Run the full suite**

Dev server stopped. This is the gate for the whole phase.

```bash
npx tsx scripts/run-smoke.ts
```

Expected: every script passes, including `smoke-page-budgets` and `smoke-app-pulse`, which touch the dashboard path this task just rewrote.

Pay particular attention to `smoke-follow-up-actions`. That file guards the write paths the dashboard's Due follow-ups row drove, and this task rewrites that area — if it fails, the cause is a call site removed in Step 1 or 2, not a flake. Its day-preset and clear-follow-up assertions must still pass unchanged: those paths belong to the user's own manual follow-ups and are outside this engine.

If `smoke-admin-render` or `smoke-instrumentation` time out, check machine load before suspecting the code — those two flake above a load average of ~100. Re-run them alone before investigating.

- [ ] **Step 7: Build**

```bash
npm run build
```

Expected: PASS. The build baseline for this repo is green, so any failure is yours. Watch specifically for a `node:fs` chunking error naming neither file — that means a client component now reaches `@/db` through an import chain, and the likely culprit is `suggestion-card.tsx` importing something from `src/lib/follow-ups/` that pulls in `context.ts`.

- [ ] **Step 8: Verify the dashboard in the browser**

`preview_start`, then `read_page` on `/dashboard`. Confirm exactly one follow-up card where there were two sections, that it links to `/reminders`, and that `read_console_messages` is clean. Screenshot it for the commit.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(follow-ups): retire the old suggestion system

Removes AUTO_SUGGESTION_TYPES, buildOutreachSuggestions, generateDueFollowUps and
the on-view rebuild trio, and collapses the dashboard's two competing follow-up
sections into one glance card. The engine is now the single producer of
system-generated follow-ups.

contacts.next_follow_up_at is no longer written speculatively: only user action
sets it, so a system guess and a chosen date are finally distinguishable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Phase 1 done — what exists

- Four tables, four settings columns, schema version bumped and purge-covered.
- Nine signal sources, all pure functions over one preloaded context.
- Deterministic scoring with five hard filters, fusion, and learned per-kind weights.
- A daily pass that writes only `follow_up_suggestions`, capped at 3 per user, idempotent on re-run.
- A full feedback loop: accept, snooze, dismiss, mute, mark-sent.
- An hourly cron aiming at each user's local 07:00.
- `/reminders` Today, and a consolidated dashboard glance card.
- Five new smoke scripts — three of them `pure`, covering every source and every filter with no database.

**Not in phase 1:** the LLM judge (phase 2), the digest email (phase 3), birthdays and `contact_dates` population (phase 4), job changes and job openings (phase 5). `contact_dates` is created in Task 1 but stays empty until phase 4 — one schema bump rather than two, given how often `SCHEMA_VERSION` collides between branches in this repo.
