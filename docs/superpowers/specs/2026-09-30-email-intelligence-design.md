# Email intelligence → Radar

Status: proposed (design approved in chat 2026-09-30; awaiting spec review)
Branch: `claude/email-search-context-7329e6`

## Goal

As career-relevant mail arrives, Orbit understands it (a new job, a hiring-process next step, relevant news or an event), works out the most relevant people and tasks, and surfaces them as Radar cards with one-tap actions. The extracted context is also searchable by chat.

Today Orbit reads email in one narrow way: the user-triggered recruiter scan (`src/lib/gmail-scan-processor.ts`), which works sender by sender and stores one summary per recruiter. Nothing runs when mail arrives, and Radar's only inbound signal is LinkedIn messages (`src/lib/radar/signals/internal.ts`).

## Decisions

| Question | Decision |
|---|---|
| Inbox scope | Career and opportunity mail only: job postings, recruiter and hiring-process updates, industry news and events that touch the network. A prefilter drops bulk mail before any AI. |
| Whose names | Existing network first, ranked by role, company, warm path and goal fit; plus people named in the email as "add to Orbit" suggestions. |
| Stored | Derived facts and a short verbatim evidence quote. No full bodies. Threads are re-fetched from Gmail when needed. |
| Tasks | Radar card with one-tap accept. Nothing reaches `reminders` unaccepted. Radar autopilot (schedule with undo, never send) applies unchanged. |
| Search | Derived summaries and evidence are indexed into `memory_chunks`. |
| Architecture | Continuous thread-first polling pipeline. Not an extension of the recruiter scan; Gmail push can replace the trigger later. |
| Provider | Gmail first. Outlook is later work (Graph mail has no thread id, and `$search` caps at about 1,000 hits). |

### Defaults chosen for the earlier open questions (override in review)

1. **Plan gating:** Pro and Lifetime only, matching the recruiter scan (`requireRecruitersUser`, `src/lib/plan-guards.ts`).
2. **First-run backfill:** 14 days, drained under the normal per-account daily cap.
3. **Unresolved people:** shown as "Add to Orbit" chips on the event's top card. An event with no resolvable contact appears in a small "From your inbox" strip on Radar and creates no card.
4. **Sweep cadence:** every 15 minutes, on its own `ops.yml` line.
5. **Recruiter scan:** stays separate for now. Merging `user_recruiter_links` summaries into `email_events` is a follow-up.

## Constraints

- **No push, no per-email hook.** There is no Gmail `watch`, `historyId` or Pub/Sub in the repo. The scheduler is GitHub Actions (`.github/workflows/ops.yml`): 10 to 15 minute cadences, 5 to 30 minutes of lag, and schedules disabled after 60 days without a commit on a public repo. Nothing may assume a fixed interval.
- **Privacy copy currently promises the opposite.** `src/lib/legal.ts` and the privacy page say Gmail read is for the recruiter scan, bodies are never stored, and event-mail never reaches AI. `gmail.readonly` is a Google restricted scope and CASA is pending, so only listed test users can grant it today.
- **Runtime.** Routes cap at `maxDuration = 300`, and `after()` shares that budget. `neon-http` has no transactions, so claims are single conditional `UPDATE ... RETURNING` statements.
- **AI degrades.** Pro and Max accounts may use Orbit's managed keys (background work stops at the 50% credit floor); others need their own key. Every AI step needs a non-AI path.
- **Email text is attacker-controlled.** It is fenced, schema-validated and guard-checked, and a model can never write reminders directly.

## Design

### 1. Consent and legal gate (P0, no behavior change)

- New Google purpose `email_intel` mapped to `gmailRead` in `src/lib/google-scopes.ts`. Check the grant with `hasGmailReadScope` / `grantCovers`, because granular consent can withhold the scope.
- `user_settings.email_intel_enabled` (default false) is both the opt-in and the kill switch, modelled on `work_history_auto_enabled` and `radar_paused`. The setting sits with the Radar settings.
- Copy: a new row in `GOOGLE_SCOPE_DISCLOSURES` and updated privacy and terms text stating what is read, what is stored (derived facts and short quotes, no bodies), that it is sent to the user's AI provider, and that it is not used for training or ads. Bump `TERMS_VERSION` and `LEGAL_LAST_UPDATED`, refresh `scripts/legal-pages.lock.json`, and keep the Google Limited Use sentence.

### 2. Storage (P1, one schema bump)

The schema version must be above 142. Choose it after scanning every local and remote ref and every worktree (direct email already claims 140 on `origin/claude/orbit-direct-email-cc0746`).

**`email_threads`**
- `user_id`, `provider`, `thread_id`, `last_message_id`, `processed_at`.
- `status` with claim token, heartbeat and stall counter, the `capture_jobs` lifecycle in `src/lib/capture-jobs.ts`.
- `triage` (result of the prefilter), `subject`, `participants` (emails and names), `last_direction`.
- Unique on (`user_id`, `provider`, `thread_id`).

**`email_events`**
- `thread_id` FK, `kind` (`job_posting | process_update | news | event | other`), `company`, `role`, `stage`.
- `occurred_at`, `due_at`, `summary`, `evidence_quote`, `confidence`.
- `people` (jsonb: name, email, title, optional `contact_id`), `asks` (suggested tasks), `dismissed_at`.

New-table checklist:
- Drizzle definition in `src/db/schema.ts`.
- Matching `CREATE TABLE IF NOT EXISTS` and indexes in the `DDL` string in `src/db/index.ts`.
- `SCHEMA_VERSION` bump with the changelog comment.
- Table names added to `EXPECTED_TABLES` in `scripts/setup-db.ts`.
- `npx tsx scripts/smoke-schema-ddl.ts --update`, then the plain run, plus `smoke-schema-bootstrap`.

Data lifecycle:
- Register both tables in `src/lib/user-data.ts` for export, counts and purge. Derived output belongs with the `insights` category.
- Cascade on Gmail disconnect (the `connections` step).
- Handle `people[].contact_id` in `src/lib/contact-merge.ts`.
- `scripts/smoke-purge.ts` derives user-scoped tables from `schema.ts`, so it fails until this is done.

### 3. Ingest lane (P1)

- A new internal route (for example `/api/email-intel/sweep`) with its own `ops.yml` schedule line. It uses `isInternalRequest`, is listed in `src/lib/public-routes.ts` and `scripts/smoke-public-routes.ts`, has a `CronJobName` with `startCronRun`/`finishCronRun`, and gets staleness alerts in `ops-alerts.ts`. `scripts/smoke-schedules.ts` and `smoke-internal-auth.ts` cover it.
- Accounts are lease-claimed with one conditional `UPDATE ... RETURNING` (as in `claimDueConnections`, `src/lib/provider-connections.ts`). Per-account fairness and daily caps follow `src/lib/work-history-sweep.ts` and `consumeBucket` (`src/lib/rate-limit.ts`). The run stops at a time budget (`src/lib/time-budget.ts`) and can hand off over HTTP with `internalFetch`. AI never runs inside `runSyncPass`.
- Discovery: `messages.list` with the `after:` watermark (2-day overlap, as `src/lib/recruiter-scan-state.ts` does, because Gmail's `after:` is date-granular) and a career-oriented query, then `fetchGmailThreadsBatched` (`src/lib/gmail.ts`) for header metadata.
- Prefilter, cheapest first: bulk headers (`List-Unsubscribe`), `classifySenderKind`, `triageThread` (`src/lib/recruiter-triage.ts`), and `deriveAtsStage` (`src/lib/recruiter-stages.ts`) for ATS mail. Only threads that pass are fetched in full, with the body capped near 4,000 characters as in the recruiter scan.
- Idempotency comes from the unique thread key. A thread is reprocessed only when `last_message_id` changes. A stalled claim is resumed by the existing `process-stalled` backstop pattern, capped at three resumes.

### 4. Understanding (P2)

- New operation `email.understand` in `AI_OPERATIONS` (`src/lib/ai-operations.ts`): tier `fast`, minimal thinking, `background: true`.
- One call per surviving thread, via `cachedCompleteJson`. Email text goes through `fenceUntrusted("EMAILS", ...)`. Output is a zod-validated list of events.
- Validators:
  - `guardModelOutput` on all strings.
  - The evidence quote must be verbatim-contained in the source text, as `src/lib/opportunity-extract.ts` requires.
  - Events under a confidence floor of about 0.6 are dropped.
- Jev gates (`src/lib/decisions/gates.ts`) skip obvious non-career mail when the account has a TypeSafe key.
- No-AI fallback: `deriveAtsStage` still produces `process_update` events for ATS mail. Everything else is skipped, not guessed. A key or quota error aborts before the watermark advances, as in the recruiter scan.

### 5. People resolution (P3)

- Named people are matched by email through `contact_identities` (`findIdentityOwners`, `src/lib/contact-identity.ts`), which sets `contact_id`.
- Unmatched people are suggestions only. Nothing creates contacts silently, and plan caps are respected.

### 6. Relevance ranking (P3)

New pure module `src/lib/email-intel/relevance.ts`, modelled on `scoreAttendee` in `src/lib/events/relevance.ts` and `scoreContactKinds` in `src/lib/radar/score.ts`.

- Candidates: people on the thread, people at the same company (`findOrgRosters`, `src/lib/chat-roster.ts`), and `hybridSearchContacts` with expansion terms drawn from the company, role and function.
- Features: same or target company (`loadTargetKeys`), role and seniority (`seniorityOf`), goal fit (`goalRelevanceComponent`), closeness tier and warm path, recency.
- Each score carries reasons `{code, label, points}` and orders stably. No model chooses the order.
- Top three people per event.
- `role-function.ts` exists only on `claude/constellation-render-clustering-b81406`. Start with `seniorityOf`, and add role function when that lands or is cherry-picked.
- An optional bounded Jev or LLM rerank may follow, with the deterministic order as the fallback.

### 7. Radar integration (P4, no new card kinds)

An email producer in `src/lib/radar/signals/` sits next to `internal.ts`. New signal codes get weights in `RADAR_WEIGHTS` and cases in `scoreContactKinds`:

| Email event | Radar kind |
|---|---|
| `process_update` | `follow_up`; `prep` when it carries an interview or call date within 7 days |
| `job_posting` | `opportunity` |
| `news`, `event` | `heads_up` |
| a recruiter or named person with an open ask | `reach_out` |

- The evidence label reads "From your email: ..." with the summary and time. Suppression, dismissal penalties, the per-account learned model and the live index (unique per user, contact, kind) apply unchanged.
- Radar's AI prompts see labels only. The evidence quote is third-party text and stays out of the rerank prompt, or goes in fenced.
- Accepting a card calls `scheduleContactFollowUpForUser` or `createReminderForUser` (`src/lib/reminder-writes.ts`) with `sourceExcerpt` and `origin: "implied"`. Uncertain dates go to `suggested_reminders` for review.
- Ships dark behind Radar's `comingSoon` flag (`src/lib/surfaces.ts`) and its own setting, so the release order is independent.
- Radar's smokes (`smoke-radar-score.ts`, `smoke-radar-run.ts`) get email cases.

### 8. Search (P5)

- Index each `email_events` summary and evidence quote into `memory_chunks` with a new `source_kind`, `contact_ids` from resolved people, and `occurred_at`. The existing backfill sweep (`src/lib/memory-backfill.ts`) picks them up.
- Extend the `source_kind` type and every switch on it, so `search_notes` (`src/lib/tools/definitions.ts`) and chat retrieval cite email events with source chips.

## Phasing

Each phase ships on its own.

| Phase | Content |
|---|---|
| P0 | Consent, legal copy, setting, route skeleton. No behavior change. |
| P1 | Tables, sweep, prefilter, deterministic stage detection (no AI). Proves ingest, budgets and idempotency. |
| P2 | `email.understand` extraction and validators. |
| P3 | People resolution and the relevance module. |
| P4 | Radar signals, accept-to-task, unresolved-people surface. |
| P5 | Memory index and chat. |
| Later | Outlook, larger backfill, Gmail `watch` push, merging recruiter-scan data. |

## Risks

- **Restricted scope (CASA pending):** ship to listed test users and Jason's own account first.
- **Prompt injection:** fencing, zod, the verbatim-quote check and `guardModelOutput`.
- **Cost:** prefilter first, Jev gates, prompt-hash cache, per-account daily cap, the 50% floor on managed keys.
- **Cron lag or disablement:** the sweep is idempotent and watermark-based, with staleness alerts.
- **Schema version collisions** have happened seven times. Scan all refs before choosing the number.
- **False positives:** confidence floor, the evidence quote on the card, and Radar's dismiss and "never for this person" feedback.

## Testing

Smokes go in `scripts/` and are registered in `scripts/run-smoke.ts`:
- prefilter fixtures (bulk, ATS, human);
- extraction validator (injection attempt, missing quote, low confidence);
- relevance ordering, asserted as orderings rather than literals, as the Radar smokes do;
- Radar score cases for email signals;
- purge and export, schema DDL and bootstrap, public routes, schedules, internal auth, and the legal-pages lock.

A fixture set of realistic emails (job post, interview scheduling, rejection, newsletter, injection attempt) gates extraction quality.

End to end runs in local demo mode with a fake Gmail provider feeding threads, then the resulting Radar cards are checked in the browser pane. Stop other `next dev` instances first, because PGlite is single-writer. Finish with `npx tsc --noEmit`, `npm run build` and eslint.
