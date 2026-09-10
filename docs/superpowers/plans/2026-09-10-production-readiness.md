# Production readiness: what stands between Orbit and paying users

**Date:** 2026-09-10
**Status:** Plan — nothing here is implemented
**Target:** a few hundred paying users within three months
**Constraint:** stay on Vercel Hobby and the Neon free tier for now (see "The constraint", below)

Referenced by the `TEMPORARY STOPGAP` comment in `src/app/(app)/(main)/layout.tsx:16-20`,
which promised this document existed. It did not. This is it.

## What is already done

Stated first because it changes what the rest of this plan is. Orbit is not a prototype
being hardened; it is a well-built application with a specific and short list of gaps. The
following already exist and are not revisited below:

- **Schema and indexes.** 72 tables, 215 indexes, an HNSW index on `contact_embeddings`
  (`src/db/index.ts:1972`), a weighted `tsvector` for contact search (`:1131`), and a
  build-time coverage check that fails the deploy when `schema.ts` declares something the
  DDL never creates (`scripts/migrate.ts:43-50`).
- **A deploy gate.** `check:env && db:migrate && next build` — a missing production
  variable or a failing DDL statement fails the build and the previous deployment stays
  aliased (`vercel.json`, `src/lib/env.ts`).
- **Rate limiting** on every metered surface, failing closed (`src/lib/rate-limit.ts`).
- **Security headers** including a CSP (`src/lib/security-headers.ts`).
- **Observability**: Sentry, an ops sweep with Slack routing, `error_events`, `cron_runs`,
  a `/api/health` deep probe, `perf.slow` tracing (`src/lib/perf-trace.ts`), and a runbook
  (`docs/RUNBOOK.md`).
- **121 smoke scripts** gated in CI, including per-page SQL statement budgets
  (`scripts/smoke-page-budgets.ts`).
- **Entitlements and plan gates** enforced at `requireUserId`, not at a layout, because
  layouts do not re-run for Server Action POSTs (`src/lib/auth.ts:66-77`).

The work below is what that foundation does not yet cover.

## The constraint

The decision recorded here is to stay on Vercel Hobby and the Neon free tier. That is
workable for the engineering in P1 and P2. It is **not** workable for one thing, and this
document would be dishonest if it did not say so once, plainly:

> Vercel's Hobby plan does not permit commercial use, and `/upgrade` takes live Stripe
> payments (`src/lib/billing-stripe.ts`, `src/app/(checkout)/upgrade`). At a few hundred
> paying users the revenue is one to two orders of magnitude above Vercel Pro's cost. This
> is the one saving that can cost the entire deployment.

Everything below is written to work within the constraint anyway. Where the constraint
leaves a real exposure, it is marked **[accepted risk]** rather than quietly engineered
around, so the list of what is knowingly unsafe stays short and visible.

The architecture already carries the cost of this constraint in at least six places, and
each is a maintenance liability rather than a one-time cost:

| Workaround | Because | Where |
|---|---|---|
| GitHub Actions is the real scheduler | Hobby allows one cron per day | `.github/workflows/ops.yml` |
| `perf-trace.ts` writes traces to Postgres | Hobby keeps runtime logs ~1 hour | `src/lib/perf-trace.ts:6` |
| `/api/csp-report` stores reports in Postgres | same | `src/app/api/csp-report/route.ts:10` |
| Self-continuation over HTTP everywhere | 300s Fluid ceiling | `sync-scheduler.ts`, `import-engine.ts` |
| Weekly `pg_dump` to GitHub artifacts | Neon free PITR is ~6 hours | `.github/workflows/backup.yml` |
| `maxDuration = 300` on the app layout | no headroom to fix the real cause | `(app)/(main)/layout.tsx:21` |

## P0 — before the first paying user

### 0.1 Preview deployments may be migrating production

**The finding.** `vercel.json`'s build command runs `npm run db:migrate` for *every*
environment, and `scripts/migrate.ts:28-31` refuses only when `DATABASE_URL` is entirely
unset. If `DATABASE_URL` is scoped to "All Environments" in Vercel — the default when a
variable is added without picking environments — then every pull-request preview build
runs the full DDL reconciliation against the production database, plus
`backfillContactIdentities({ limit: 2000 })` and `mergeConfidentDuplicates()` on live
customer rows (`migrate.ts:60-77`). Those last two *write*, and the merge is a data-shape
change.

**Do.**
1. Verify the scoping in Vercel → Settings → Environment Variables. This is a
   five-minute check and it either clears the finding or makes it the most urgent item
   in this document.
2. Regardless of the answer, make `migrate.ts` refuse structurally: when
   `VERCEL_ENV === "preview"` and the `DATABASE_URL` host matches the production host,
   exit non-zero with a message naming the mistake. A guard that depends on a dashboard
   setting staying right is not a guard.
3. Give previews their own Neon branch. Neon branches are copy-on-write and free on the
   current tier; this also makes previews useful, since today a preview either shares
   production data or has none.

**Test.** A smoke script asserting the refusal, in the shape of
`scripts/smoke-security-headers.ts` — pure function over a fake env, no network.

### 0.2 `reconcileSchema` has no lock

Two concurrent builds — a production deploy and a preview, or two pushes in quick
succession — both call `reconcileSchema()` (`src/db/index.ts:2402`) with no mutual
exclusion. The statements are idempotent, so the common case is harmless, but
`migratePgvector` (`:1965`) and the dedupe-then-unique-index sequence at `:2153-2162` are
not safe to interleave: one connection can be deleting duplicate rows while the other
tries to build the unique index over them.

**Do.** Wrap the DDL path in `pg_advisory_lock(<constant>)` / `pg_advisory_unlock`, taken
after `schemaIsCurrent` returns false and released in a `finally`. Roughly ten lines. The
second builder then blocks, re-checks `schemaIsCurrent`, and finds nothing to do.

### 0.3 Data loss window is seven days

Backups are a weekly `pg_dump` encrypted to an `age` recipient and kept as a GitHub
artifact for 90 days (`.github/workflows/backup.yml`), and Neon's free-tier PITR window is
about six hours. So the worst case — corruption noticed on day six — loses six days of
every user's contact data, with no way to recover it.

**Do, within the constraint.**
1. Change the backup schedule from weekly (`0 6 * * 0`) to daily. It is a one-character
   change and the artifact retention already covers 90 days. This moves worst-case loss
   from seven days to one.
2. Add a *restore drill* to the plan and actually run it once: take a dump, restore it into
   a fresh Neon branch, and check row counts, per `docs/RUNBOOK.md:58-70`. An untested
   restore procedure is a document, not a backup. Record the date and the wall-clock time
   it took in the runbook.
3. Add the backup job's success to the ops sweep as a known condition, so a silently
   failing backup opens an alert rather than being discovered during an incident.

**[accepted risk]** Between the daily dump and the ~6h PITR window, up to 24 hours of
writes remain unrecoverable. Paid Neon reduces this to minutes. Named here so it is a
decision rather than an oversight.

### 0.4 The CSP is still report-only

`src/lib/security-headers.ts:6-9` says to flip `CSP_ENFORCE=1` "once the reports have
stayed quiet for a week". Orbit renders user-supplied contact notes and model-written
markdown, which is exactly the injection surface a CSP is for.

**Do.** Query `error_events` for `csp` rows over the last 30 days. If quiet, set
`CSP_ENFORCE=1` in production. If not, the rows name the origins to add first. Note that
`script-src` keeps `'unsafe-inline'` (documented at `:11-13`), so this is defence in
depth against injected *sources*, not against inline injection — worth doing, worth not
overselling.

### 0.5 Account deletion can leave a half-deleted account

`deleteAllUserData` (`src/lib/user-data.ts`) issues roughly thirty sequential
non-transactional `DELETE`s over the Neon HTTP driver, driven by the Clerk `user.deleted`
webhook. Two consequences:

- **Partial erasure.** A failure at delete twenty leaves the account's remaining tables
  populated with no retry and no record that it happened. For a right-to-erasure request
  that is the wrong failure mode.
- **Timeout.** Thirty round trips, each an unindexed-in-the-worst-case scan on a large
  account, against a webhook handler's ceiling.

**Do.** Make deletion a *job*, not a request: record a `deletion_requested_at`, delete in
bounded batches, and re-run until a verification pass counts zero rows for that `user_id`
across every table carrying one. The import engine's resumable shape
(`src/lib/import-engine.ts`) is the model, and the ops sweep already has somewhere to
report a deletion that has not completed. The exception list at `user-data.ts:66-107`
(operator ledgers deliberately retained) carries over unchanged.

### 0.6 There are no browser tests

121 smoke scripts, all Node-level against PGlite, and zero that open a browser. Nothing
verifies that sign-up → onboarding → capture → save works, or that Stripe checkout
completes. These are the two flows where a regression costs a user or a payment, and they
are the two flows with no automated coverage at all.

**Do.** A small Playwright suite — five to eight flows, not a comprehensive one — run
against preview deployments:

1. Sign up → onboarding wizard → dashboard renders
2. Capture: paste notes → review extraction → save → contact appears in `/contacts`
3. Contact profile: log an interaction → timeline updates
4. `/upgrade` → Stripe test checkout → entitlement reflected
5. Settings → add a BYOK key → chat returns a response
6. Delete-my-data → account is gone

Chromium is the only target worth the maintenance at this size.

## P1 — what a few hundred users actually break

### 1.1 The dashboard and graph load every contact into memory

**This is the root cause of the 300s stopgap, and the most important item in this
document.**

`getDashboardData` (`src/lib/reminders.ts:414`) runs
`db.query.contacts.findMany({ where: eq(contacts.userId, userId) })` with **no limit**.
The column projection is careful — `notes` and `profile_image_url` are excluded, with a
comment explaining why (`:428-437`) — but every row for the account is still pulled across
the Neon HTTP boundary and every subsequent computation is JavaScript over that array:
`dueFollowUpIds` (`:658`), `dueFollowUps` with a comparator (`:666`), `contactNameById`
(`:653`), `contactById` (`:688`), and then `getNetworkStats` over a re-mapped copy of the
whole thing (`src/actions/reminders.ts:77-104`). `/graph` has the same shape — its own page
comment calls it "the full-network scan" (`(app)/(main)/graph/page.tsx:13`).

At 200 contacts this is invisible. At 10,000 — a real LinkedIn export, which
`scripts/seed-scale.ts` defaults to 5,000 precisely because "a real LinkedIn export is
thousands" — it is seconds of transfer plus seconds of single-threaded JS in a lambda,
which is exactly the "Task timed out after 60 seconds" the stopgap was raised for.

**And the guard cannot see it.** `scripts/smoke-page-budgets.ts` asserts
`dashboard issues ≤ 13 statements` (`:124`) and `graph issues ≤ 9` (`:163`). Statement
*count* is bounded. Row count is not measured anywhere. So the guard built to catch
dashboard regressions is structurally blind to the one that is actually happening.

**Do, in this order.**

1. ~~**Extend the budget script to assert rows and bytes**, not just statements.~~ **Done**
   (`scripts/smoke-page-budgets.ts`, "Payload scaling"). It runs the loaders at 750 and
   3,000 contacts and reports growth. Measured:

   | Surface | 750 contacts | 3,000 contacts | Growth |
   |---|---|---|---|
   | dashboard | 755 rows | 3,005 rows | 4.0× |
   | graph (show all) | 755 rows | 3,005 rows | 4.0× |
   | notifications panel | 34 rows | 100 rows | 2.9×, bounded at 235 |

   Two corrections to what this document said before the measurement existed:

   - **The notifications panel is not a problem.** Its items come from four LIMITed queries
     (80 + 100 + 30 + 25), so it is bounded at 235 rows however large the account is. It is
     the shape the other two should end up in, not another instance of the defect.
   - **The dashboard's existing byte budget could not see the payload.** `contactById` is a
     `Map`, and `JSON.stringify` renders a Map as `{}` — so "dashboard payload under 1.5 MB"
     was weighing the bounded card lists while one row per contact passed through unweighed.
     Measured properly: **2.9 MB at 3,000 contacts, 983 bytes a contact, ~9.6 MB at 10,000** —
     moved over the HTTP driver and aggregated in a lambda on every visit. That is the
     60-second wall in numbers.
### Correction: the snapshot is not needed

Recorded because it overturns a decision already taken. The plan recommended
materialising the dashboard's whole-network work into a per-user snapshot, and that was
agreed with the freshness rule "live for the edited contact, snapshot for everyone else".
Reading the code to build it showed the snapshot buys nothing, because **every expensive
piece is already either bounded or already materialised**:

| Piece | Assumed | Actually |
|---|---|---|
| Peer-link analysis (the O(n²)) | needs the whole network | already capped at `METRICS_MAX_CONTACTS = 750`, sliced by closeness **in JS after loading all N**. Selecting the top 750 in SQL gives identical numbers. |
| Goal relevance per contact | recomputed from each contact's text every load | already computed during recalibration and stored in `contacts.closeness_breakdown`. `goalAlignedContacts` is `ORDER BY (closeness_breakdown->>'goalRelevance')::float DESC LIMIT 5`. |
| `tierCounts` | needs the whole network | a `GROUP BY` over the same stored breakdown. |
| Constellation clusters | needs the whole network | needs three columns (`id`, `company`, `school`), not the wide row — ~60 bytes a contact against 983. |
| Preview contacts | needs the whole network, then capped | `ORDER BY orbit_score DESC LIMIT <cap>` over the eligibility predicate. |

So the wide scan is not load-bearing for anything. It exists because the loader asks for
every column of every contact and then narrows in JavaScript — the narrowing is already
there, it is just happening on the wrong side of the wire.

**This is strictly better than the snapshot on every axis the freshness question was
about**: no staleness at all, no new table, no dirty-marking, no debounce, no background
rebuild, and no second materialisation mechanism to keep honest alongside
`closeness_cohorts`. The freshness trade-off that was chosen simply does not have to be
made.

One O(N) read survives and is worth naming rather than hiding: `readStoredCohortResult`
selects `{id, breakdown}` for every contact (`closeness-cohort.ts:226`). It is far
narrower than the wide scan — a few hundred bytes of JSON a contact rather than a
kilobyte — and it is shared with other surfaces, so bounding it is its own change. The
dashboard needs breakdowns only for the contacts it renders plus the top 750, both
bounded.

2. ~~**Push the aggregates into SQL.**~~ **Done** (`src/lib/dashboard-aggregates.ts`).
   Totals, the score histogram, dormant, overdue, and the company/school/tag vocabularies,
   in three statements. `dormantCount` and `overdueCount` stayed live rather than
   materialised for a reason worth keeping: they compare stored timestamps against `now()`,
   so a contact becomes overdue at a moment nobody writes anything. A materialised overdue
   count under-reports until some unrelated write refreshes it, and overdue is one of the
   few numbers on that page a user acts on. `smoke-dashboard-aggregates.ts` holds each SQL
   expression against the JavaScript it replaces.
3. **Bound the lists.** Every card on the dashboard renders a handful of rows —
   `.slice(0, 5)` appears at `reminders.ts:650`. `ORDER BY … LIMIT` those in the query
   instead of sorting the whole network to show five. **In progress**: the two that read
   the stored breakdown are done in SQL (`getDashboardTierCounts`,
   `getGoalAlignedContactIds`) but are not wired in yet. `recentContacts` (6),
   `dueFollowUps` (12) and the three lookup Maps still come off the full scan.

   The width half is done: the five widest columns (`aiSummary`, `keyFacts`,
   `sharedInterests`, `howMet`, `metContext`) are off the network scan and fetched by id
   for the only two sets that need them — the 750-contact metrics sample and the 150-contact
   preview. **983 → 863 bytes a contact** on the 3,000 fixture, verified behaviour-identical
   by capturing the whole dashboard payload before and after. The fixture writes a one-line
   `aiSummary`; a real account's is a paragraph, so this understates the production cut.

   Then eleven more columns came off, because nothing read them: `userId`, `firstName`,
   `lastName`, `location`, `industry`, `source`, `followUpStatus`, `firstInteractionAt`,
   `closeness`, `closenessTier` and `orbitScore`. **983 → 632 bytes a contact**, all of it
   behaviour-identical.

   `getNetworkStats` was why most of them survived. Its `preloaded.contacts` type named
   eleven fields; the function reads four. The dashboard donates its scan to that call, so
   an aspirational input type was setting the width of the widest query on the page.

   **What is left is not width.** The remaining 632 bytes are spread thinly across ~20
   columns — the largest single field is a timestamp at 46 bytes and the id is 43 — so
   there is no surgical cut left. Reducing further means selecting fewer columns for most
   contacts, i.e. the minimal-scan restructure below, not narrowing the ones that remain.

   The other O(N) read, measured: `readStoredCohortResult` is **334 bytes a contact**
   against the scan's 632. Total O(N) payload is 966 bytes a contact — about 2.8 MB at
   3,000 contacts, 9.7 MB at 10,000. So bounding the scan alone caps the win at roughly
   2.2×; the cohort read has to follow it.

4. **Give the ordered lists a total order first.** Done, and it is a prerequisite rather
   than a cleanup: `recentContacts` ordered by `updated_at` alone, and on a bulk import
   every contact carries the same one — 1,200 fixture contacts have five distinct values,
   250 sharing each. `ORDER BY updated_at DESC LIMIT 6` over a 250-way tie returns an
   arbitrary six, so no list here could be bounded in SQL until the order was total. Both
   `recentContacts` and `dueFollowUps` now break ties on `id`.
5. **Materialise what cannot be bounded.** The constellation preview and the network-depth
   chart genuinely need the whole graph. Those belong in a per-user precomputed row,
   refreshed by the existing deferred-work path, not recomputed on every page view.
   `closeness_cohorts` and `closeness-materialize.ts` are the pattern already in the repo.
6. **Then revert `maxDuration` to 60** in `(app)/(main)/layout.tsx` and delete the stopgap
   comment. That revert is the definition of done for this item.

### 1.2 Continuous sync saturates at roughly ten connections

`CONNECTIONS_PER_RUN = 5` (`src/lib/sync-scheduler.ts:58`) on a `*/15` cron
(`.github/workflows/ops.yml`) is 20 connection-syncs per hour. `SYNC_INTERVAL_MS` is 30
minutes (`:64`), i.e. each connection wants two per hour. **The steady-state ceiling is
about ten actively-syncing connections.** Self-continuation chains past the budget
(`/api/sync/run` `after()` block) but is explicitly best-effort, and the module header
already warns that GitHub cron lags 5–30 minutes and "nothing may assume a fixed interval".

At a few hundred users with calendar sync connected, connections go stale for hours and
the product silently stops being "continuous".

**Do, within the constraint.**
1. **Make the ceiling observable before it is hit.** Emit oldest-`next_sync_at` lag into
   `cron_runs.stats` and open an ops alert when the oldest due connection exceeds, say,
   2 hours. Today saturation is indistinguishable from working.
2. **Raise throughput within the 300s budget** by running connections concurrently rather
   than serially — the per-connection budget (`PER_CONNECTION_BUDGET_MS = 60_000`) and the
   per-connection error isolation already make this safe. A concurrency of 4–5 is roughly
   a 4–5× ceiling increase for no new infrastructure.
3. **Degrade honestly.** Back `SYNC_INTERVAL_MS` off as connection count grows, and tell
   the user in the UI when their last sync was, rather than implying continuity the
   scheduler cannot deliver.

**[accepted risk]** This defers rather than removes the ceiling. A real queue (Vercel
Queues, QStash, Inngest) is the actual answer and all three have free tiers worth
evaluating if step 2 proves insufficient.

### 1.3 GitHub Actions is a single point of failure that disables itself

`ops.yml` drives the sweep, the stalled-import job, the webhook drain, and provider sync.
Its own header records that scheduled workflows are **disabled after 60 days without a
commit on a public repository**. A quiet period — exactly what a stable product looks like
— turns off every background job Orbit has.

**Do.** The Better Stack heartbeat already covers detection. Add the *prevention*: a
scheduled job whose only purpose is to keep the repository non-idle is a hack; the honest
fix within the constraint is a calendar reminder plus an explicit line in the runbook's
"Alert → what to do" table. This is genuinely a case where $20/month removes an entire
class of outage.

### 1.4 Multi-statement writes without atomicity

`runAtomicWrite` (`src/db/index.ts:2485`) is well-designed — it correctly handles that
`neon-http` has no transactions and maps to `db.batch()` — but it has **two call sites**:
`contact-merge.ts` and `contact-profile.ts`. Meanwhile these paths write multiple rows
without it:

- note-batch save (`src/lib/note-batch-save.ts`)
- import commit (`src/lib/import-engine.ts`)
- billing/subscription writes from the Stripe webhook (`src/lib/billing-stripe.ts`)
- account deletion (covered separately in 0.5)

**Do.** Audit each for torn-state failure modes and decide per path: wrap in
`runAtomicWrite`, or make it idempotent and resumable. The billing one matters most — a
webhook that half-applies a subscription change is a support ticket about money.

### 1.5 Verify `statement_timeout` is actually set

`docs/RUNBOOK.md:72` instructs `ALTER ROLE <app role> SET statement_timeout = '20s'`, and
nothing anywhere verifies it was ever run. One runaway query on a shared free-tier compute
degrades every user.

**Do.** Add it to the `/api/health` deep probe: `SHOW statement_timeout`, and report it.
A setting nobody checks is a setting nobody has.

### 1.6 Rate limiting is a Postgres write per request

`consumeBucket` (`src/lib/rate-limit.ts:78`) upserts one row per `(scope, key)` per
request. The module header is honest that "memory would be cheaper but a serverless
instance's memory is neither shared nor durable", and at current volume this is the right
call. At a few hundred users it adds a write to the hot path of every chat, capture, API
and MCP call, all contending on a single row per user per scope.

**Do.** Nothing yet — but instrument it. Add the limiter's own latency to `perf-trace`, and
set a threshold at which it moves to Upstash Redis (free tier covers this comfortably).
Recorded here so the decision is made ahead of the pain rather than during it.

## P1 — frontend

### 1.7 Verify the heavy libraries are actually lazy

261 files carry `"use client"`; three.js, React Flow and `motion` are all in the tree; there
are 15 dynamic imports. `next.config.ts:38-46` documents real care here — three's barrel is
deep-path rewritten specifically to keep the earth-globe chunk from pulling loaders and
post-processing. That intent is not currently verified by anything.

**Do.** Run `npm run analyze`, confirm `/` and `/graph` carry their heavy chunks lazily,
and add a first-load-JS budget for `/`, `/pricing` and `/dashboard` to CI. The marketing
pages are the ones a cold visitor pays for.

### 1.8 The graph at scale is untested in a browser

`smoke-page-budgets.ts` bounds the graph's *queries*. Nothing bounds what React Flow does
with 3,000 nodes on a mid-range laptop. Add a render-time measurement to the Playwright
suite from 0.6, at the fixture size `seed-scale.ts` already produces.

### 1.9 Data-loss paths on the client

Capture is the flow where a user has typed something they cannot retype. Audit what
happens when a server action fails mid-capture: is the draft preserved locally, and does
the toast offer a retry that keeps the text? Sonner and the notification centre are already
in place (`src/lib/toast.tsx`); this is about what happens *before* the toast.

## P2 — after the first users

- **Sentry**: review sample rates (`sentry.server.config.ts:16` trades traces for the free
  quota) and route alerts somewhere a person reads.
- **An SLO on `/api/health`**, with the error budget written down, so "is it slow" has an
  answer that is not a judgement call.
- **`ENCRYPTION_SECRET` rotation.** `docs/RUNBOOK.md:54` says "do not rotate casually: it
  decrypts every user's BYOK key and OAuth token". That is a warning, not a procedure. If
  it ever leaks, the procedure has to exist already. Write the re-encryption script now.
- **Abuse controls on the public API and MCP.** Rate limits exist per key; there is no
  per-account ceiling, no key revocation flow beyond deletion, and no anomaly alert.
- **An incident and data-request process.** One page: who is paged, how a user requests
  their data, how long erasure takes, who signs off on a restore.

## Sequencing

| Phase | Items | Gate |
|---|---|---|
| **A** — one afternoon | ~~0.2, 0.3.1, 1.5~~ **done**; 0.1 (verify in Vercel), 0.4 (needs production `error_events`) | Config checks and small guards. No product risk. |
| **B** — the real work | 1.1 in full | Ends with `maxDuration` reverted to 60 and the row-count budget green at 25,000 contacts. |
| **C** — trust the deploy | 0.6, 1.7 | Playwright green on preview; bundle budgets in CI. |
| **D** — survive growth | 1.2, 0.5, 1.4 | Sync lag alerting live; deletion resumable; billing writes atomic. |
| **E** — ongoing | 0.3.2 drill, 1.3, 1.6 instrumentation, all of P2 | |

Phase B is the one that cannot be parallelised or hurried, and it is the one a user
actually feels. Everything in Phase A is small enough to land first without delaying it.

## What stays knowingly unsafe

Collected in one place, per the constraint:

1. **Commercial use on Vercel Hobby**, with live Stripe payments. Not an engineering risk;
   a terms-of-service one. Nothing in this plan mitigates it.
2. **Up to 24 hours of unrecoverable writes** after 0.3, versus minutes on paid Neon.
3. **The sync ceiling is deferred, not removed** (1.2), and returns at low thousands of
   connections.
4. **The scheduler turns itself off after 60 idle days** (1.3), detected by heartbeat
   rather than prevented.

Each of the four is closed by roughly $20–40/month.
