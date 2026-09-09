# Follow-up reminder engine

Design doc — 2026-09-09

## Problem

Orbit already decides who a user should reach out to, but it decides badly and in
three unconnected places.

`buildOutreachSuggestions` runs three hard-coded heuristics — `dormant_high_value`,
`linkedin_thread_quiet`, `post_event` — every one of them a bare `daysAgo(...) >= N`
threshold. It rebuilds the whole queue on dashboard load behind a 30-minute TTL.
`generateDueFollowUps` is a second, overlapping producer that stamps
`contacts.next_follow_up_at = now` on eight people at a time, which makes a system
guess indistinguishable from a date the user chose. `suggested_reminders` is a third
path, extracting dated commitments from pasted notes.

Nothing in that set reads a conversation. Nothing knows a birthday, a work
anniversary, or that a contact changed jobs. Nothing learns from being dismissed.
And because the queue is computed on view, anything time-sensitive is only correct
if the user happens to open the app that day.

This replaces all of it with one engine.

## Decisions

Settled during design; recorded so implementation does not relitigate them.

| Decision | Choice |
|---|---|
| Relationship to existing heuristics | **Replace.** One engine is the single producer of every system-generated follow-up. The three heuristics become signal sources inside it. `generateDueFollowUps` retires. |
| Where intelligence sits | **Cheap deterministic funnel, one batched LLM judge on the shortlist.** No model call scales with network size. |
| Delivery | **Daily scheduled pass + email digest + in-app.** Requires storing a user timezone. |
| External signals | **Contact job changes** and **job openings at network companies**. Company news is explicitly out of scope. |
| Personal dates | All four sources: derived anniversaries (free), Google Contacts birthdays, note extraction, manual entry — stored in one general `contact_dates` table. |
| Primary surface | **`/reminders` becomes the home.** A "Today" section on top; dashboard keeps one glance card. |
| Adaptation | **Implicit learning + explicit mutes**, unified into one suppressions table. |
| Drafting | **Hook now, full draft on demand.** The judge returns a one-line hook for free; `follow-up-drafts.ts` generates the message only when asked. |

## Constraints from the existing codebase

These are facts about this repo, verified during design. Violating any of them
breaks something that currently works.

1. **BYOK is absolute in production.** `allowEnvProviderKeys()` returns
   `!process.env.VERCEL`, so `getEnvProviderKey` always returns null on Vercel.
   A user without a personal API key cannot make AI calls at all. Every LLM stage
   in this design must degrade, never fail.
2. **Unconfirmed AI output must never reach `listDueNotificationItems`.** The
   `suggested_reminders` table exists precisely to enforce this — it fires desktop
   notifications, and an unconfirmed extraction firing one is the failure mode that
   table was created to prevent. The new engine inherits the rule.
3. **Query budgets are enforced.** `query-counter.ts` and `smoke-page-budgets.ts`
   guard per-page statement counts. A signal source that queries per contact is not
   acceptable.
4. **`ops.yml` cadence is gate-sensitive.** The workflow documents this about
   itself: adding a `schedule` entry raises the effective cadence of every step not
   gated on a specific schedule string. Adding a cron requires widening the
   existing gates in the same change.
5. **`interactions.direction` is nullable and unrecoverable for legacy imports.**
   The schema comment is explicit: earlier imports never persisted the sender and
   it cannot be reconstructed. "Has messages, all directions NULL" is a third state,
   not "outbound".
6. **`RESEND_API_KEY` is a platform env var** (in `env.ts`'s required list), so the
   digest sends on Orbit's key, not the user's.
7. **New tables need the DDL template plus a `SCHEMA_VERSION` bump**; the `alters`
   list is for columns only. `SCHEMA_VERSION` is 32 at time of writing — confirm
   before bumping, since parallel branches also bump it.
8. **An unregistered smoke script fails the whole suite.** Every new script must be
   added to the registry in `scripts/run-smoke.ts` with its tier.

## Architecture

Seven stages. Stage 5 carries the design's central invariant.

### 1. Detect

Signal sources emit candidates. A source is:

```ts
type SignalSource = {
  kind: SignalKind;
  cadence: "daily" | "opt-in";
  detect(ctx: SignalContext): SignalCandidate[];
};
```

`detect` is a **pure function over a preloaded context**. It does not query. One
`SignalContext` — contacts, recent interactions, contact dates, current
experiences, events and attendance — is loaded once per user and handed to every
source. This is what keeps thirteen sources from becoming a query storm
(constraint 3), and it is what makes the entire catalog unit-testable with no
database.

### 2. Score

Pure and deterministic. See "Scoring" below.

### 3. Judge

One batched LLM call per user per day over the top ~12 candidates. The only place
a model touches triggering.

### 4. Schedule

Survivors become rows dated `due_on`. Date-bound signals can be dated into the
future — a birthday detected today with two days of lead time is written for the
day it should surface.

### 5. Surface — the invariant

**The engine writes `follow_up_suggestions`. It never writes `reminders`.**

A suggestion becomes a `reminders` row only when the user accepts it. This
preserves constraint 2: nothing unconfirmed can fire a desktop notification or
land in the ICS calendar feed. It also means a daily pass is disposable — scoring
can change, a pass can be re-run or rolled back, and nothing the user owns is
touched.

### 6. Act

Draft, accept, snooze, dismiss, mute, mark-sent.

### 7. Learn

Outcomes write suppressions and per-kind weights.

### Module layout

```
src/lib/follow-ups/
  types.ts        SignalKind, SignalCandidate, SignalContext, ScoredSignal, judge I/O
  registry.ts     the source list — single source of truth for kinds
  context.ts      loads SignalContext for one user (the only querying module here)
  sources/*.ts    one file per signal source, each pure
  score.ts        pure scoring, filters, fusion
  judge.ts        the one LLM call + fallback
  pass.ts         one user's full pass
  scheduler.ts    who is due, time budget, self-continuation
  digest.ts       email build + send
  feedback.ts     dismissal/accept -> suppressions + weights
```

Entry point: `POST /api/follow-ups/run`, using the same internal-auth,
`cron_runs` ledger and self-continuation shape as `/api/sync/run`.

### What retires

- `AUTO_SUGGESTION_TYPES` and `buildOutreachSuggestions` in `src/lib/reminders.ts`
- `refreshOutreachSuggestions`, `ensureOutreachSuggestions`,
  `maybeRefreshOutreachSuggestions` — the on-view rebuild disappears entirely
- `generateDueFollowUps`

`aiSuggestions` survives for `score_bump` enrichment suggestions, which are
unrelated to outreach.

### One cleanup this forces

`contacts.next_follow_up_at` becomes **read-only to the engine**. Today
`generateDueFollowUps` writes it speculatively, so a system guess and a user's
chosen date are stored identically and cannot be told apart. In the new design it
is a signal source (`scheduled_follow_up`) and only user action writes it.

## Schema

`SCHEMA_VERSION` bump plus four new tables via the DDL template.

### `contact_dates`

Asserted personal dates.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | text not null | |
| `contact_id` | uuid | references `contacts`, on delete cascade |
| `kind` | text not null | `birthday` \| `wedding` \| `graduation` \| `custom` |
| `label` | text | required when `kind = 'custom'` |
| `label_normalized` | text | lowercased/trimmed, for the uniqueness constraint |
| `month` | integer not null | 1–12 |
| `day` | integer not null | 1–31 |
| `year` | integer | **nullable** — Google returns year-less birthdays constantly |
| `recurs` | boolean not null default true | |
| `source` | text not null | `google` \| `notes` \| `manual` |
| `source_excerpt` | text | the sentence a note-extracted date came from |
| `confidence` | integer | 0–100, matching `ai_suggestions.confidence_score` |
| `created_at`, `updated_at` | timestamptz | |

Indexes: unique `(user_id, contact_id, kind, label_normalized)`;
`(user_id, month, day)` for the daily scan.

**Deliberately absent: `work_anniversary` and `met_anniversary`.** Both are
derivable — from `contacts.date_met` / `first_interaction_at` and from
`contact_experiences.start_year` / `start_month` — and storing a copy creates a
sync problem the moment either source changes. They are computed at detect time.
This table holds only what a human or an import asserted.

### `follow_up_suggestions`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | text not null | |
| `contact_id` | uuid not null | references `contacts`, on delete cascade |
| `due_on` | date not null | the user-local calendar day it surfaces |
| `primary_kind` | text not null | the winning signal kind |
| `signals` | jsonb not null | `[{ kind, score, evidence }]` |
| `score` | real not null | |
| `reason` | text not null | one human sentence |
| `hook` | text | one-line opener; null when unjudged |
| `judged` | boolean not null default false | whether the LLM saw it |
| `status` | text not null default `pending` | `pending` \| `accepted` \| `snoozed` \| `dismissed` \| `expired` |
| `snoozed_until` | timestamptz | |
| `dismissed_reason` | text | |
| `reminder_id` | uuid | set on accept, references `reminders`, on delete set null |
| `digest_sent_at` | timestamptz | |
| `created_at`, `resolved_at` | timestamptz | |

Indexes: unique `(user_id, contact_id, primary_kind, due_on)`;
`(user_id, status, due_on)`.

The uniqueness constraint is what makes a re-run idempotent — necessary because
`ops.yml` explicitly states its schedule is a floor, not a promise, and a run can
fire twice.

`signals` as JSONB rather than a separate signals table is a deliberate YAGNI
call: it preserves full "why did this surface" debuggability and lets a contact
with three converging signals outrank one with a single strong signal, without a
fifth table.

### `follow_up_suppressions`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | text not null | |
| `contact_id` | uuid | null = applies to all contacts |
| `kind` | text | null = applies to all kinds |
| `until` | timestamptz | **null = permanent mute** |
| `reason` | text not null | `dismissed` \| `acted` \| `muted_contact` \| `muted_kind` |
| `created_at` | timestamptz | |

Indexes: `(user_id, contact_id)`, `(user_id, kind)`.

One table serves both halves of the adaptation decision: a dismissal writes
`until = now + 60d`; an explicit mute writes `until = null`. Implicit learning and
explicit control are the same mechanism.

### `follow_up_weights`

| column | type | notes |
|---|---|---|
| `user_id` | text not null | pk part |
| `kind` | text not null | pk part |
| `weight` | real not null default 1.0 | |
| `shown` | integer not null default 0 | |
| `accepted` | integer not null default 0 | |
| `dismissed` | integer not null default 0 | |
| `updated_at` | timestamptz | |

The counters are stored alongside the weight so the number is always explainable
rather than a mystery multiplier.

### Columns on `user_settings`

| column | type | notes |
|---|---|---|
| `timezone` | text | IANA. Captured from the browser exactly as `feedback-report.ts` already does. |
| `follow_up_digest` | text default `daily` | `daily` \| `weekly` \| `off` |
| `follow_up_daily_cap` | integer default 3 | |
| `follow_up_next_pass_at` | timestamptz | the scheduler's claim column, mirroring `next_sync_at` |

Timezone capture: on app load, if `user_settings.timezone` is null, write
`Intl.DateTimeFormat().resolvedOptions().timeZone`. Absent a timezone the pass
falls back to UTC 07:00 — degraded but correct.

## Signal catalog

Thirteen sources. Sources 1–9 are free and internal and ship in phase 1; 10–11 depend
on `contact_dates` being populated and ship in phase 4; 12–13 are external and ship in
phase 5.

| # | kind | base prior | fires when |
|---|---|---|---|
| 1 | `commitment_due` | 95 | A confirmed dated commitment reaches its date. The user literally said they would do this. |
| 2 | `scheduled_follow_up` | 90 | `contacts.next_follow_up_at <= today`. User-set only now. |
| 3 | `open_loop` | 80 | Last interaction was inbound, contains an unanswered ask, 7+ days elapsed. |
| 4 | `dormant` | 45 | Idle beyond a closeness-dependent threshold. |
| 5 | `thread_quiet` | 50 | A written-family thread with ≥2 messages went silent 14–90 days ago. |
| 6 | `post_event` | 70 | Recent first meeting, or shared event attendance, with no follow-up logged. |
| 7 | `never_contacted` | 40 | Captured but never interacted with. |
| 8 | `met_anniversary` | 50 | Derived: `date_met` / `first_interaction_at` month-day matches today. |
| 9 | `work_anniversary` | 55 | Derived: a current `contact_experiences` row's start month-day matches today. |
| 10 | `birthday` | 85 | From `contact_dates`. Surfaces with 0–2 days lead time. |
| 11 | `personal_date` | 60 | Other `contact_dates` kinds. |
| 12 | `job_change` | 80 | Apollo re-enrichment diff shows a new current role. |
| 13 | `job_opening` | 45 | A role posted at a company where the user knows someone. |

### Notes on individual sources

**3 — `open_loop`** is the source that most directly answers "understand the
context of the conversation." Detection is cheap: the most recent interaction has
`direction = 'in'`, its text contains a question mark or an imperative ask, and
7+ days have passed. The judge then confirms whether the loop is genuinely open.

Per constraint 5, `direction` is null for legacy imports. Those contacts fall back
to `interactions.action_items` — an existing jsonb array of extracted asks — as the
evidence for an open loop. Contacts with neither signal simply do not produce this
candidate; they are still covered by `thread_quiet` and `dormant`.

**4 — `dormant`** replaces the current flat 30-day threshold with a function of
`closeness_tier`: `inner` 30 days, `mid` 90, `outer` 180. A flat threshold is the
main reason the current suggestions feel wrong — a yearly acquaintance and a close
collaborator are not both overdue at day 31.

**5 — `thread_quiet`** generalizes `linkedin_thread_quiet` to every interaction
type with `family: "written"` (`linkedin_message`, `email`, `message`) rather than
LinkedIn alone.

**6 — `post_event`** keeps the existing 7–21 day post-intro window and adds a
second trigger from `events` + `event_attendees`: you attended an event with this
person N days ago and have not logged a follow-up.

**10 — `birthday`** needs lead time to be useful; a birthday surfaced the morning
of is often too late to act on well. It fires at `due_on = birthday - 2 days`.

**12 — `job_change`** requires re-enriching contacts through Apollo and diffing
`contact_experiences` for a new `is_current` row. Apollo is BYOK and consumes
paid credits, so this runs as an opt-in sweep with its own budget and cadence. It
does not ride the free daily pass.

**13 — `job_opening`** polls public Greenhouse and Lever boards keyed off
`companies.name_normalized`. It is **gated on the user having an active
job-search goal in `user_goals`** — for anyone not looking, every result is noise.
All outbound fetches go through `net-guard.ts`.

## Scoring

```
score = basePrior(kind) × contactWeight × recencyFit × userWeight(kind)
```

- **`contactWeight`** ≈ 0.8–1.4, from `closeness_tier` and `priority_level`.
- **`recencyFit`** saturates: a contact idle 400 days is not meaningfully more
  urgent than one idle 90.
- **`userWeight`** is the learned multiplier from `follow_up_weights`, clamped to
  `[0.25, 2.0]` and **pinned at 1.0 until that kind has `shown >= 5`**. Without the
  pin, one early dismissal permanently kills a signal type.

**Fusion.** When a contact has multiple signals:
`score = max + 0.15 × sum(rest)`, capped at `max × 1.5`. Three converging reasons
should beat one.

### Hard filters, applied before ranking

1. **Any interaction in the last 7 days drops every staleness-triggered signal.**

   This is the most important rule in the design. "Reach out to Priya, she has gone
   quiet" the morning after coffee with her is precisely what makes a user disable
   a feature like this permanently.

   The line runs between two classes of signal, and every kind belongs to exactly
   one:

   - **Staleness-triggered** — the evidence *is* the absence of contact. Recent
     contact refutes it outright. `dormant`, `thread_quiet`, `open_loop`,
     `never_contacted`, `post_event`, `job_opening`. **Dropped.**
   - **Date-triggered** — the evidence is a dated occurrence independent of contact
     frequency. Talking yesterday does not make it their birthday any less.
     `commitment_due`, `scheduled_follow_up`, `birthday`, `personal_date`,
     `met_anniversary`, `work_anniversary`, `job_change`. **Kept.**

2. An active suppression matching `(contact)`, `(contact, kind)` or `(kind)`.
3. `contacts.constellation_pin === 'out'` — carrying forward the existing rule that
   someone the user removed from their own chart stays removed.
4. A `follow_up_suggestions` row already pending for that contact.
5. A pending `reminders` row for that contact. No double-nagging.

Survivors sort by score; the top 12 go to the judge.

## The judge

One call per user per day:

```ts
completeJson(userId, {
  operation: "followup.judge",
  speed: "fast",
  temperature: 0.2,
  ...
})
```

`speed: "fast"` routes to `FAST_MODELS`, which is correct — this is classification,
not writing.

**Input:** the user's active goals, today's date, and for each candidate: contact
name, role and company, closeness tier, days since last contact, the signal kinds
with their evidence, and roughly 600 characters of the most recent conversation.

**Output:**

```ts
{ items: [{ id: string, keep: boolean, reason: string, hook: string, deferDays?: number }] }
```

**Prompt rules that carry the weight:**

- Drop anything that would read as a nag.
- Drop when the evidence does not actually support a reason to reach out.
- `reason` is one concrete sentence addressed to the user. No invented facts,
  meetings or shared history.
- `hook` is one line of *what to say* — not a drafted message.
- Use `deferDays` when the signal is real but the timing is wrong.

### Degradation

Three failure modes collapse to one fallback path: no AI key (the normal state on
Vercel per constraint 1), a JSON parse failure, or a provider error. In all three:
keep the top `follow_up_daily_cap` candidates by score, generate `reason` from a
per-kind template, leave `hook` null, set `judged = false`.

`follow-up-drafts.ts` already implements lenient recovery from truncated model
JSON; `judge.ts` mirrors that approach before giving up. **A model failure must
never mean the user gets an empty day.**

## The daily pass

`POST /api/follow-ups/run` — internal-auth via `isInternalRequest`, `cron_runs`
ledger under `followups.run`, `maxDuration = 300`, a ~4.5 minute time budget, and
`after()` + `internalFetch` self-continuation when the budget is exhausted. This is
a direct structural copy of `/api/sync/run`.

Per invocation it claims up to 20 users whose `follow_up_next_pass_at <= now`, runs
their pass, and sets `follow_up_next_pass_at` to the next 07:00 in their timezone.

Users with `follow_up_digest = 'off'` still get a pass — the in-app surface needs
it — but no email. Users with no AI key get a deterministic pass.

The route must be added to `PUBLIC_ROUTES` and gate on `isInternalRequest`
fail-closed, matching the other internal routes.

### `ops.yml`

Add an hourly schedule, `23 * * * *` — hourly is sufficient granularity for every
timezone's 07:00 to be hit within the hour.

Per constraint 4, the existing gates must be widened in the same change:

```yaml
if: github.event.schedule != '*/15 * * * *' && github.event.schedule != '23 * * * *'
```

on both the ops sweep and the webhook drain. Without this the sweep's cadence
silently goes from every 10 minutes to roughly every 6, taking alert volume and
`cron_runs` row count with it.

## The digest

Built with `buildBroadcastEmail` and `fromAddress()`, sent through the platform
`RESEND_API_KEY` — never the user's key.

Subject: `"3 people worth a message today"` (count-accurate). Each item shows the
contact, the reason sentence, the hook, and a deep link to
`/reminders?draft=<suggestion-id>`. Footer carries a link to turn the digest off,
mirroring `interest-list/unsubscribe`.

`digest_sent_at` guards against a double send when a run repeats.

**An empty day sends no email.** "Nothing for you today" is the fastest possible
route to an unsubscribe.

## Surfaces

### `/reminders`

A **Today** section above everything else. Per card: avatar, name, role @ company, a
kind badge, the reason sentence, and the hook in quotes.

Below it, `SuggestedRemindersPanel` **stays unchanged**. Unconfirmed commitments
extracted from the user's own notes are a review queue — "did I read this
correctly?" — which is a different question from "who should you talk to today."
Merging them would muddle both. Manual lists follow, unchanged.

### Dashboard

`SuggestedOutreachSection` and `RemindersAndFollowUpsSection` collapse into a single
glance card: the day's top 3, linking to `/reminders`. That duplication exists today
only because two systems independently produce follow-ups.

### Downstream surfaces

The unconfirmed/confirmed boundary holds everywhere:

- **Notification panel** — suggestions appear as their own group but **never fire a
  desktop notification**.
- **ICS feed** — suggestions never appear. Only accepted ones, which are real
  `reminders` rows.
- **Extension** (`/api/extension/follow-ups`) and **public API**
  (`/api/v1/followups`) — the day's list, read-only.

## Actions

| Action | Effect |
|---|---|
| **Draft** | Opens the composer, calling `generateContactFollowUpDraft` with `intent` set to the hook. That function already accepts `intent`, so the hook flows through and the draft is grounded in the reason the suggestion fired. Status stays `pending` — drafting is not accepting. |
| **Remind me** | Accept. Creates a `reminders` row (`actionKind: "follow_up"`, `reminderType: "generated"`, `createdBy: "system"`), links it via `reminder_id`, sets `contacts.next_follow_up_at`. Now in the calendar and desktop notifications. |
| **Snooze** | 3d / 1w / 1mo → `snoozed_until`. |
| **Dismiss** | With one-tap reasons: *not now* / *wrong reason* / *stop reminding me about this*. |
| **Mute** | Contact or kind, from the overflow menu. Writes a suppression with `until = null`. |
| **Sent it** | For messages sent outside Orbit. Logs an interaction and resolves the suggestion. Without this the engine believes nothing happened and re-fires — the failure that makes users stop trusting it. |

## Feedback loop

- **Surfaced** → `shown += 1` for that kind.
- **Accepted or drafted** → `accepted += 1`; suppress that contact for ~30 days.
- **Dismissed** → `dismissed += 1`; suppress `(contact, kind)` for 60 days.
- **Weight recompute** → Laplace-smoothed accept rate measured against the user's
  own mean across kinds, clamped to `[0.25, 2.0]`, applied only once `shown >= 5`.

Sending through `outreach-send` / `gmail-send` logs an interaction, which the
7-day hard filter then acts on by itself. The noise filter and the feedback loop
are the same mechanism.

## Testing

The purity of the sources is what makes this affordable — all thirteen `detect`
functions are pure over a preloaded `SignalContext` and need no database.

| script | tier | covers |
|---|---|---|
| `smoke-follow-up-signals` | pure | Every source against fixture contexts, including the null-`direction` fallback for `open_loop`. |
| `smoke-follow-up-scoring` | pure | Ordering, the 7-day filter, all five hard filters, fusion capping, weight clamping, the `shown >= 5` pin. |
| `smoke-follow-up-judge` | pure | Prompt assembly, parse, truncated-JSON recovery, and each of the three fallback paths. |
| `smoke-follow-up-pass` | pglite | Seed → pass → assert. Idempotency on re-run against the unique constraint. Daily cap enforced. |
| `smoke-follow-up-feedback` | pglite | Dismiss → suppression → not re-surfaced. Mute → never re-surfaced. |
| `smoke-follow-up-actions` | pglite | *Existing file*, extended for accept and snooze. |

All registered in `scripts/run-smoke.ts` with their tier (constraint 8).

`purgeUserData`'s category registry must gain all four new tables, or account
deletion leaves orphaned rows behind.

## Rollout

**Phase 1 — spine.** Schema, `contact_dates`, timezone capture, sources 1–9,
scoring, the pass, `/reminders` Today, the dashboard consolidation, and the
retirement of `AUTO_SUGGESTION_TYPES`, `generateDueFollowUps` and the on-view
rebuild trio. No LLM, no email. Useful on its own.

**Phase 2 — judge.** The batched call, reasons and hooks, and all three
degradation paths.

**Phase 3 — digest.** Email, preferences, and the `ops.yml` cron with its gate
widening.

**Phase 4 — birthdays.** Google `personFields` gains `birthdays` (no new OAuth
scope — it is included in the existing contacts-readonly grant), note extraction,
manual entry. Sources 10–11.

**Phase 5 — external.** `job_change` via opt-in Apollo re-enrichment;
`job_opening` via goal-gated Greenhouse/Lever polling. Sources 12–13.

## Risks

**Phase 1 deletes the current suggestion system and replaces it in one step.** This
is the right call — running both in parallel would require dedupe and priority
logic between two systems, built only to be thrown away — but it means phase 1
cannot ship half-finished. The pure-tier smoke tests are what make that safe, since
they cover the entire catalog and all the filters without a database.

**Volume is the way this feature fails.** Not wrong suggestions — too many
suggestions. The daily cap of 3, the 7-day interaction filter, and the judge's
explicit instruction to drop anything that reads as a nag are three independent
defenses against the same failure, and none of them should be relaxed without
evidence.

**Legacy `direction` data limits `open_loop` coverage.** Contacts whose messages
were imported before direction was persisted cannot produce this signal from
message direction alone. The `action_items` fallback narrows the gap but does not
close it. Coverage will improve naturally as new messages arrive.
