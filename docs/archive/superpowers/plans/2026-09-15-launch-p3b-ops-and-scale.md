# Launch Phase 3b — Operations, Migrations and Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every known failure mode reaches a person, a migration can no longer rewrite `contacts` or skip statements silently, connector sync and `/admin` survive growth, and the five core flows run in a real browser on every PR.
**Architecture:** Alert state is written before Slack is tried, and seven new conditions join the pure catalogue in `src/lib/ops-alerts.ts`, fed by `loadOpsSnapshot` in `src/lib/ops-sweep.ts`. Migration hardening stays inside `src/db/index.ts` (expression guard, DDL fingerprint beside the version, a runtime lease cap) plus a guard in `drizzle.config.ts`. Sync runs four connections at a time, `/admin` reuses its whole-table aggregates for ten minutes, and Playwright drives `next dev` in demo mode with a local Gemini stub.
**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle over Neon (neon-http) / PGlite, Clerk, Stripe, tsx smoke scripts
**Spec:** docs/production-readiness-audit-2026-09-15.md (items: B6, B7 (a)–(d), B11 rest (env docs, stale comments and docs), B13 (sync concurrency, admin aggregates, Playwright, 60-day rule), C6 health-token 401, B8 duplicate process-stalled schedule, the Phase 3a "Handoff to 3b" conditions, and `backup.stale` deferred from Phase 0's A1)
**Roadmap:** docs/superpowers/plans/2026-09-15-launch-readiness-roadmap.md

## Global Constraints

- Branch: create `claude/launch-<phase>` off `origin/main` in a fresh worktree; run `npm ci` in it (worktrees share no node_modules). Commit after every task; commit messages end with the line `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Next.js 16 has breaking changes versus common training data: before using any Next API (route handlers, `proxy.ts`, `after()`, server actions, config), read the matching guide under `node_modules/next/dist/docs/`.
- Tests are tsx smoke scripts `scripts/smoke-<name>.ts`, each an executable spec that prints `ok`/`FAIL` lines and exits nonzero on failure. Pure scripts touch no database. Database scripts MUST start with `import "./smoke/_env";` (deletes DATABASE_URL, uses a throwaway PGlite dir) and wrap main in `run()` from that module. EVERY new smoke script must be added to `MANIFEST` in `scripts/run-smoke.ts` with tier `"pure"` or `"pglite"` or the whole suite refuses to run. Run one: `npx tsx scripts/smoke-<name>.ts`. Run all: `npm test`.
- Every task ends green on: the task's smoke script, `npm run typecheck`, `npm run lint` (baseline is 0 errors; any error is yours), and `npx tsx scripts/smoke-toast-copy.ts` when user-facing copy changed.
- tsx scripts must exit explicitly (`run()` or `process.exit(0)`); PGlite keeps the loop alive. Never import `next/server` into a low-level `src/lib/*` module that scripts import — the import alone hangs every script.
- A `"use server"` module may export ONLY async functions; a const/type export silently breaks every export in it. Put shared constants/types in `src/lib/*-types.ts`.
- A client component must not import anything that reaches `@/db` (build fails with a node:fs chunk error). Pure metadata goes in a DB-free module.
- User-facing errors: throw `new UserFacingError("…")` for copy you want shown; across a server-action boundary return it as data via `asActionResult`; catch sites use `friendlyError(err, fallback)` from `src/lib/errors.ts`, never `err.message`. Toast/copy voice (enforced by `scripts/smoke-toast-copy.ts`): curly apostrophes (’), "Couldn’t" not "Could not", never the word "failed", no trailing period, " — " as the one connector.
- Drizzle: use bare `.returning()` (partial returning does not typecheck across the driver union); read `db.execute()` results with `rowsOf<T>()` from `@/db`; `db.transaction` does not exist on neon-http — use `runAtomicWrite` (src/db/index.ts) or accept sequential idempotent writes; a column interpolated into a `sql```` template inside `.select()` loses its table prefix.
- Schema changes: table in `src/db/schema.ts`; `CREATE TABLE IF NOT EXISTS` in the `DDL` template in `src/db/index.ts` (the template has ZERO `--` comments, no backticks, no `;` inside comments — explanations go on the Drizzle table); new columns ALSO go in the `alters` list; new tables go in `EXPECTED_TABLES` in `scripts/setup-db.ts`; bump `export const SCHEMA_VERSION` with a changelog comment line; then `npx tsx scripts/smoke-schema-ddl.ts --update` and `npm run db:setup` (read the printed table list). NEVER hardcode the new version in the plan: compute it at execution time as one more than the highest value claimed by any remote branch:
  `git fetch -q --all && for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do git show "${b}:src/db/index.ts" 2>/dev/null | grep -oE 'export const SCHEMA_VERSION = [0-9]+'; done | grep -oE '[0-9]+$' | sort -n | tail -1`
  (56 is already claimed by three open branches as of 2026-09-15.) Re-run the scan immediately before pushing. Never put backticks in comments inside the `alters`/`SCALE_DDL` arrays.
- Tailwind compiles utility classes it finds in comments: never write an arbitrary-value class (e.g. `w-[123px]`) in a code comment.
- UI changes are verified in the browser: start the `orbit-web` configuration from `.claude/launch.json` (port 3001, demo mode on local PGlite when no Clerk keys are set). Controlled React inputs must be driven with real keystrokes, not DOM value writes.
- Do not add dependencies unless a task explicitly says so and gives the exact package and version.
- Scope: implement only the audit items assigned to this plan. Do not refactor neighbours.

### Plan-specific constraints

- **Branch** `claude/launch-p3b`, cut from `origin/main` after Phase 2 merges. Runs in parallel with Phase 3a. **Do not edit** `src/lib/gmail.ts`, `src/lib/ai.ts`, `src/lib/errors.ts`, `src/lib/embedding-backfill.ts`, or the avatar and outreach modules — 3a owns them. This plan owns `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts`, the reconcile code in `src/db/index.ts` and `.github/workflows/ops.yml` (3a's plan says so too).
- **No `SCHEMA_VERSION` bump.** The one schema change is `schema_migrations.fingerprint text` (Task 11). `schema_migrations` is runtime-managed (not in `schema.ts`, not in the `DDL` template, not in the `alters` list), the column is created by `schemaIsCurrent`/`recordSchemaVersion` themselves, and the schema-ddl lock does not read those functions. Do not touch `DDL`, `SCALE_DDL` text, `alters`, `schema.ts`, `EXPECTED_TABLES` or `SCHEMA_VERSION`. If a merge of `main` pulls in another phase's bump, keep theirs as-is.
- **Line numbers were read at `33a213c`.** Phases 0–2 have since changed several of these files (Phase 0 Task 6 rewrote `schemaIsCurrent`/`recordSchemaVersion`; Phase 2 added the `purge.stuck` condition, a snapshot field for it, and edits to the Stripe route). Find the quoted anchor text; never trust the number. Where this plan says "add", add beside what is there — never delete a field, condition or check a previous phase introduced.
- **Positional `Promise.all` in `loadOpsSnapshot`.** Every task that adds a query appends it as the LAST array element and its name as the LAST destructured name, so earlier phases' entries keep their positions.
- **`scripts/smoke-ops-sweep.ts` asserts exact delivery counts.** Every task that adds a condition sourced from a shared table also adds a line to that script's `reset()` so rows left by other scripts in the shared PGlite cannot open it.
- **Runbook rows.** Each condition task adds its row to the "Alert → what to do" table in `docs/RUNBOOK.md`.
- Order: Tasks 1–7 are sequential (same files). Task 10 must land before Task 11 (the fingerprint forces one full sweep on production; the guard stops that sweep rewriting `contacts`). Task 15 needs Task 14. Tasks 21–24 need Task 20. Tasks 25–27 come after Task 7 (same catalogue region); Tasks 25 and 27 also need Phase 3a merged into this branch (its `embedding_failures` table, `quota` error kind and `RATE_LIMITS` keys) — Task 26 does not. Task 28 needs Phase 0 Task 7 (its `backup.yml` and `scripts/smoke-backup-workflow.ts`). Everything else is independent.

## Task index

| # | Task | Audit |
|---|---|---|
| 1 | Alert state is persisted before Slack is tried | B6 |
| 2 | `config.alerts_undeliverable` when Slack is unset in production | B6 |
| 3 | `cron.partial_streak` and `drain.failed` | B6 |
| 4 | `backfill.failed` | B6 |
| 5 | `config.statement_timeout_unbounded` | B6 |
| 6 | `stripe.unattributed` | B6 |
| 7 | `embedding.backlog` | B6 (3a handoff) |
| 8 | Env contract and `.env.example` coverage | B6, B11 |
| 9 | Stale README, performance doc and demo-account comments | B11, C5 |
| 10 | `linkedin_slug` is rewritten only when its expression changed | B7a |
| 11 | DDL fingerprint beside the schema version | B7b |
| 12 | `drizzle-kit push` refuses without consent or against production | B7c |
| 13 | Runtime migration-lease wait capped at 20 s | B7d |
| 14 | Connector sync: 4 at a time, 20 per run, lag metric | B13 |
| 15 | `sync.lagging` | B13 |
| 16 | `/admin` reuses its aggregates for ten minutes | B13 |
| 17 | `internalFetch` times out after 10 s | B13 scheduler |
| 18 | One schedule for process-stalled; GitHub 60-day runbook | B13, B8 |
| 19 | `/api/health?token=<wrong>` answers 401 | C6 |
| 20 | Playwright harness, Gemini stub, CI job, onboarding flow | B13 |
| 21 | Browser flow: capture → review → contact | B13 |
| 22 | Browser flow: log an interaction | B13 |
| 23 | Browser flow: Settings → Delete data | B13 |
| 24 | Browser flow: `/upgrade` → Stripe Checkout | B13 |
| 25 | `embedding.unembeddable` and `ai.quota_failures` | 3a handoff |
| 26 | `calendar.disarmed` | 3a handoff |
| 27 | `avatar.source_exhausted` and `apollo.hosted_cap_hits` | 3a handoff |
| 28 | `backup.stale`: Better Stack heartbeat after each stored backup | A1 (deferred from Phase 0) |

---

### Task 1: Alert state is persisted before Slack is tried (B6)

Today `runOpsSweep` delivers first and persists only on success (`src/lib/ops-sweep.ts:228-235`), and `deliverToSlack` throws when `SLACK_OPS_WEBHOOK_URL` is unset (`src/lib/ops-notify.ts:47-48`). So with Slack broken, `ops_alert_state` stays empty and `/admin/health` "Open alerts" says nothing is wrong.

**Files**
- Modify: `src/lib/ops-alerts.ts` — `planTransitions` (`:305-331`, the `if` at `:316`)
- Modify: `src/lib/ops-sweep.ts` — `OpsSweepResult` (`:154-162`), the delivery loops in `runOpsSweep` (`:223-306`)
- Modify: `scripts/smoke-ops-alerts.ts` (after the escalation check, `:156-157`), `scripts/smoke-ops-sweep.ts` (before the final `reset()`, `:104-105`)

**Interfaces**
- Consumes: `OpsAlertRow.lastNotifiedAt: Date | null`, `deliver(d: OpsDelivery): Promise<void>` (existing).
- Produces: `OpsSweepResult.undelivered: string[]`. Rule: an active row with `lastNotifiedAt === null` is "persisted, never announced"; `planTransitions` puts it in `open` again every sweep until delivery succeeds. `notifyCount` counts successful deliveries only. A recovery always persists `active = false`; its message is sent only if the open was ever announced.

- [ ] **Step 0: Branch.** `git fetch origin && git worktree add ../launch-p3b -b claude/launch-p3b origin/main && cd ../launch-p3b && npm ci`
- [ ] **Step 1: Failing pure test.** In `scripts/smoke-ops-alerts.ts`, directly after the "an escalation in severity re-opens" check, add:

```ts
  t = planTransitions([row("a", { lastNotifiedAt: null, notifyCount: 0 })], [cond("a", "warning")], NOW);
  check("an active row Slack never took is offered as an open again", t.open.length === 1 && t.unchanged.length === 0 && t.remind.length === 0);

  t = planTransitions([row("a", { lastNotifiedAt: null, notifyCount: 0 })], [], NOW);
  check("a never-announced row still recovers (state closes)", t.recover.length === 1);
```

- [ ] **Step 2: Failing pglite test.** In `scripts/smoke-ops-sweep.ts`, insert before `await db.delete(opsAlertState).where(eq(opsAlertState.id, "stripe.checkout_error"));`:

```ts
  console.log("\nSlack is down: the condition is persisted anyway, and retried...");
  await reset();
  const failing = {
    deliver: async () => { throw new Error("Slack webhook answered 500"); },
    heartbeat: async () => {},
  };
  const down = await runOpsSweep({ trigger: "manual", deps: failing });
  check("a failed delivery marks the sweep partial", down.status === "partial" && down.deliveryFailures === 1, JSON.stringify(down));
  check("it is reported as undelivered, not opened",
    down.undelivered.includes("cron.missed") && !down.opened.includes("cron.missed"), JSON.stringify(down));
  const pending = await db.query.opsAlertState.findFirst({ where: eq(opsAlertState.id, "cron.missed") });
  check("the row exists, active, never notified",
    pending?.active === true && pending.lastNotifiedAt === null && pending.notifyCount === 0, JSON.stringify(pending));

  sent.length = 0;
  const retried = await runOpsSweep({ trigger: "manual", deps });
  check("the next sweep announces it as an open",
    sent.length === 1 && sent[0].kind === "open" && sent[0].condition.id === "cron.missed" && retried.opened.includes("cron.missed"),
    JSON.stringify(sent));
  const delivered = await db.query.opsAlertState.findFirst({ where: eq(opsAlertState.id, "cron.missed") });
  check("and stamps the notification without moving openedAt",
    delivered?.notifyCount === 1 && delivered.lastNotifiedAt !== null &&
      delivered.openedAt.getTime() === pending!.openedAt.getTime(), JSON.stringify(delivered));

  const nightly = await startCronRun("imports.process-stalled", "manual");
  await finishCronRun(nightly, { status: "ok" });
  const closedWhileDown = await runOpsSweep({ trigger: "manual", deps: failing });
  const closed = await db.query.opsAlertState.findFirst({ where: eq(opsAlertState.id, "cron.missed") });
  check("a recovery during a Slack outage still closes the row",
    closed?.active === false && closedWhileDown.recovered.includes("cron.missed"), JSON.stringify(closed));

  console.log("\nAn alert nobody was told about recovers silently...");
  await reset();
  await runOpsSweep({ trigger: "manual", deps: failing });
  const again = await startCronRun("imports.process-stalled", "manual");
  await finishCronRun(again, { status: "ok" });
  sent.length = 0;
  const silent = await runOpsSweep({ trigger: "manual", deps });
  check("no recovery message for an open that never reached Slack",
    sent.length === 0 && silent.recovered.includes("cron.missed"), JSON.stringify(sent));
```

- [ ] **Step 3: Run, expect failure.** `npx tsx scripts/smoke-ops-alerts.ts` → `FAIL an active row Slack never took is offered as an open again`. `npx tsx scripts/smoke-ops-sweep.ts` → throws `TypeError: Cannot read properties of undefined (reading 'includes')` on `down.undelivered`.
- [ ] **Step 4: `planTransitions`.** In `src/lib/ops-alerts.ts` replace the line `if (!prev || !prev.active || prev.severity !== c.severity) {` with:

```ts
    // `lastNotifiedAt === null` on an active row means the sweep persisted the condition but
    // Slack never took the message (see runOpsSweep). Offer it again until it lands.
    if (!prev || !prev.active || prev.severity !== c.severity || prev.lastNotifiedAt === null) {
```

- [ ] **Step 5: `OpsSweepResult`.** In `src/lib/ops-sweep.ts` add the field after `deliveryFailures: number;` and its initial value after `deliveryFailures: 0,`:

```ts
  /** Conditions whose Slack message failed this sweep. Their state is persisted regardless. */
  undelivered: string[];
```
```ts
    undelivered: [],
```

- [ ] **Step 6: Loops.** Replace everything from `const detailOf = (c: OpsCondition) =>` through the closing `}` of the `for (const row of plan.recover)` loop (the line before `if (result.deliveryFailures > 0) result.status = "partial";`) with:

```ts
    const prevById = new Map(previous.map((r) => [r.id, r]));
    const detailOf = (c: OpsCondition) => ({ title: c.title, detail: c.detail, href: c.href ?? null });
    const markNotified = (id: string) =>
      db
        .update(opsAlertState)
        .set({ lastNotifiedAt: now, notifyCount: sql`${opsAlertState.notifyCount} + 1`, updatedAt: now })
        .where(eq(opsAlertState.id, id));

    // State is written BEFORE delivery; delivery only stamps `last_notified_at`. The old order
    // (deliver, then persist) left `ops_alert_state` empty whenever Slack was unset or down —
    // so /admin/health showed nothing at exactly the moment nothing reached a phone either.
    for (const c of plan.open) {
      const prev = prevById.get(c.id);
      // A retry of an undelivered open keeps its opening time; a fresh open or an escalation
      // starts the clock again.
      const openedAt = prev && prev.active && prev.severity === c.severity ? prev.openedAt : now;
      await db
        .insert(opsAlertState)
        .values({
          id: c.id, severity: c.severity, active: true, openedAt, lastSeenAt: now,
          lastNotifiedAt: null, notifyCount: 0, detail: detailOf(c), updatedAt: now,
        })
        .onConflictDoUpdate({
          target: opsAlertState.id,
          set: {
            severity: c.severity, active: true, openedAt, lastSeenAt: now,
            lastNotifiedAt: null, detail: detailOf(c), updatedAt: now,
          },
        });
      try {
        await deliver({ kind: "open", condition: c });
      } catch {
        result.deliveryFailures += 1;
        result.undelivered.push(c.id);
        continue;
      }
      await markNotified(c.id);
      result.opened.push(c.id);
    }

    for (const c of plan.remind) {
      await db
        .update(opsAlertState)
        .set({ lastSeenAt: now, detail: detailOf(c), updatedAt: now })
        .where(eq(opsAlertState.id, c.id));
      try {
        await deliver({ kind: "remind", condition: c });
      } catch {
        // `last_notified_at` is untouched, so the reminder is due again next sweep.
        result.deliveryFailures += 1;
        result.undelivered.push(c.id);
        continue;
      }
      await markNotified(c.id);
      result.reminded.push(c.id);
    }

    if (plan.unchanged.length > 0) {
      await db
        .update(opsAlertState)
        .set({ lastSeenAt: now, updatedAt: now })
        .where(inArray(opsAlertState.id, plan.unchanged.map((c) => c.id)));
    }

    for (const row of plan.recover) {
      // Closed first and unconditionally: the page must stop showing a condition that is gone.
      // A recovery message lost to a Slack outage is not retried — the open did reach Slack,
      // and /admin/health shows it closed.
      await db.update(opsAlertState).set({ active: false, updatedAt: now }).where(eq(opsAlertState.id, row.id));
      result.recovered.push(row.id);
      if (row.lastNotifiedAt === null) continue; // nobody was told it opened
      try {
        await deliver({ kind: "recover", condition: conditionFromRow(row) });
      } catch {
        result.deliveryFailures += 1;
        result.undelivered.push(row.id);
      }
    }
```

- [ ] **Step 7: Pass.** Both smokes print only `ok` lines and end `All ops-alert checks passed.` / `All ops-sweep checks passed.`. Then `npm run typecheck && npm run lint` (0 errors; `src/actions/admin.ts` `runOpsSweepAction` still compiles — it reads fields by name).
- [ ] **Step 8: Commit.** `git add src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts scripts/smoke-ops-sweep.ts && git commit -m "Persist ops alert state before Slack delivery" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 2: `config.alerts_undeliverable` when Slack is unset in production (B6)

With Task 1 in place a condition can live in `ops_alert_state` without Slack; this makes "Slack is not configured" itself one of them, so `/admin/health` "Open alerts" names the problem.

**Files**
- Modify: `src/lib/env.ts` — `EnvReport` (`:66-71`), `validateEnv` (`:77-160`)
- Modify: `src/lib/ops-alerts.ts` — `OpsSnapshot` (`:38-60`), `evaluateOpsConditions` (after the `config.missing` block, `:247-254`)
- Modify: `src/lib/ops-sweep.ts` — the `return` of `loadOpsSnapshot` (`:103-129`)
- Modify: `scripts/smoke-env.ts`, `scripts/smoke-ops-alerts.ts`, `docs/RUNBOOK.md`

**Interfaces**
- Produces: `EnvReport.missingExpected: string[]` (names from `EXPECTED_IN_PRODUCTION` that are unset; production only, `[]` elsewhere); `OpsSnapshot.missingExpectedEnv: string[]`; condition id `config.alerts_undeliverable` (warning) when it includes `"SLACK_OPS_WEBHOOK_URL"`.

- [ ] **Step 1: Failing tests.** In `scripts/smoke-env.ts` change the import to `import { validateEnv, REQUIRED_IN_PRODUCTION, EXPECTED_IN_PRODUCTION } from "../src/lib/env";` and add before `const preview = validateEnv(`:

```ts
  check(
    "missingExpected lists exactly the unset EXPECTED_IN_PRODUCTION names",
    JSON.stringify(prod({}).missingExpected) ===
      JSON.stringify(EXPECTED_IN_PRODUCTION.filter((n) => !GOOD[n])),
    JSON.stringify(prod({}).missingExpected)
  );
  check("an unset Slack webhook is in missingExpected",
    prod({ SLACK_OPS_WEBHOOK_URL: undefined }).missingExpected.includes("SLACK_OPS_WEBHOOK_URL"));
  check("off production missingExpected is always empty",
    validateEnv({}, { vercelEnv: undefined }).missingExpected.length === 0 &&
      validateEnv({}, { vercelEnv: "preview" }).missingExpected.length === 0);
```

In `scripts/smoke-ops-alerts.ts` add `missingExpectedEnv: [],` to `HEALTHY` (after `missingRequiredEnv: [],`) and, before `check("prod behind main by more than 6h`, add:

```ts
  check("Slack unset in production → config.alerts_undeliverable (warning)",
    find({ ...HEALTHY, missingExpectedEnv: ["SLACK_OPS_WEBHOOK_URL"] }, "config.alerts_undeliverable")?.severity === "warning");
  check("another missing expected variable is not an alert",
    !find({ ...HEALTHY, missingExpectedEnv: ["SENTRY_DSN"] }, "config.alerts_undeliverable"));
```

- [ ] **Step 2: Run, expect failure.** `npx tsx scripts/smoke-env.ts` → throws `missingExpected lists exactly … FAILED` (the field is undefined). `npx tsx scripts/smoke-ops-alerts.ts` → `FAIL Slack unset in production → config.alerts_undeliverable`.
- [ ] **Step 3: `env.ts`.** Add to `EnvReport` after `missingRequired: string[];`:

```ts
  /** Names from EXPECTED_IN_PRODUCTION that are unset. Production only. Feeds `config.alerts_undeliverable`. */
  missingExpected: string[];
```

In `validateEnv`: declare `const missingExpected: string[] = [];` after `const missingRequired: string[] = [];`; replace the production EXPECTED loop with

```ts
    for (const name of EXPECTED_IN_PRODUCTION) {
      if (!has(env, name)) {
        warnings.push(`${name} is unset; the feature it enables is off`);
        missingExpected.push(name);
      }
    }
```

and change all three `return { errors, warnings, missingRequired };` lines to `return { errors, warnings, missingRequired, missingExpected };`.

- [ ] **Step 4: Catalogue.** In `OpsSnapshot` after `missingRequiredEnv: string[];` add:

```ts
  /** EXPECTED_IN_PRODUCTION names that are unset (production only). */
  missingExpectedEnv: string[];
```

After the `config.missing` block in `evaluateOpsConditions` add:

```ts
  // Persisted even though it can never reach Slack (see runOpsSweep): this row IS the alert,
  // on /admin/health and in the deep /api/health view.
  if (s.missingExpectedEnv.includes("SLACK_OPS_WEBHOOK_URL")) {
    out.push({
      id: "config.alerts_undeliverable",
      severity: "warning",
      title: "Alerts are not reaching Slack",
      detail: "SLACK_OPS_WEBHOOK_URL is unset in production, so every alert stays on /admin/health until someone looks.",
      href: "/admin/health",
    });
  }
```

- [ ] **Step 5: Snapshot.** In `loadOpsSnapshot`'s returned object, after `missingRequiredEnv: getEnvReport().missingRequired,` add `missingExpectedEnv: getEnvReport().missingExpected,`.
- [ ] **Step 6: Runbook.** Append to the "Alert → what to do" table in `docs/RUNBOOK.md`:

```md
| `config.alerts_undeliverable` | Slack → your app → Incoming Webhooks → copy the URL → Vercel → Environment Variables → `SLACK_OPS_WEBHOOK_URL` (Production) → Redeploy. Until then `/admin/health` is the only place alerts appear. |
```

- [ ] **Step 7: Pass.** `npx tsx scripts/smoke-env.ts`, `npx tsx scripts/smoke-ops-alerts.ts`, `npx tsx scripts/smoke-ops-sweep.ts` (it deletes `VERCEL_ENV`, so the new condition stays quiet) all pass; `npm run typecheck && npm run lint`.
- [ ] **Step 8: Commit.** `git add src/lib/env.ts src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-env.ts scripts/smoke-ops-alerts.ts docs/RUNBOOK.md && git commit -m "Raise config.alerts_undeliverable when Slack is unset in production" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 3: `cron.partial_streak` and `drain.failed` (B6)

`cron.failed` fires only on `failed`/`stale` (`src/lib/ops-alerts.ts:101-109`), so a process-stalled run that ends `partial` every time is silent; nothing reads the `webhooks.drain` rows in `cron_runs` (the cron reads are `src/lib/ops-sweep.ts:57-68`).

**Files**
- Modify: `src/lib/ops-alerts.ts` — `OpsSnapshot.cron` and a new top-level field; the process-stalled `if/else if` chain (`:90-109`); a new drain block after it
- Modify: `src/lib/ops-sweep.ts` — `loadOpsSnapshot` (`:47-82` array/destructuring, `:101-129` return)
- Create: `scripts/smoke-ops-snapshot.ts` (pglite) — the loader test every later condition task extends
- Modify: `scripts/smoke-ops-alerts.ts`, `scripts/smoke-ops-sweep.ts` (`reset()`, `:32-34`), `scripts/run-smoke.ts`, `docs/RUNBOOK.md`

**Interfaces**
- Produces: `export const PARTIAL_STREAK = 3;` in `ops-alerts.ts`; `OpsSnapshot.processStalledRecent: CronRunState[]` (newest first, up to `PARTIAL_STREAK`); `OpsSnapshot.cron.drain: { lastStartedAt: Date | null; lastState: CronRunState | null }`; condition ids `cron.partial_streak`, `drain.failed` (both warning). `processStalledRecent` is top-level on purpose: existing tests replace `cron.processStalled` wholesale, and a new required field inside it would break their types.
- Produces for later tasks: `scripts/smoke-ops-snapshot.ts` with a `// (new sections go above this line)` marker.

- [ ] **Step 1: Failing pure tests.** In `scripts/smoke-ops-alerts.ts` `HEALTHY`: inside `cron: { … }` add `drain: { lastStartedAt: hoursAgo(0.2), lastState: "ok" },`; at top level add `processStalledRecent: ["ok"],`. Add before `// Connector sync. Its freshness window`:

```ts
  check("three partial nightly runs in a row → cron.partial_streak (warning)",
    find({ ...HEALTHY, processStalledRecent: ["partial", "partial", "partial"] }, "cron.partial_streak")?.severity === "warning");
  check("two partials then an ok is not a streak",
    !find({ ...HEALTHY, processStalledRecent: ["partial", "partial", "ok"] }, "cron.partial_streak"));
  check("only two runs recorded is not yet a streak",
    !find({ ...HEALTHY, processStalledRecent: ["partial", "partial"] }, "cron.partial_streak"));
  check("a failed drain → drain.failed",
    find({ ...HEALTHY, cron: { ...HEALTHY.cron, drain: { lastStartedAt: hoursAgo(0.1), lastState: "failed" } } }, "drain.failed")?.severity === "warning");
  check("a killed drain → drain.failed",
    Boolean(find({ ...HEALTHY, cron: { ...HEALTHY.cron, drain: { lastStartedAt: hoursAgo(1), lastState: "stale" } } }, "drain.failed")));
  check("a partial drain (customer endpoints refusing) is not drain.failed",
    !find({ ...HEALTHY, cron: { ...HEALTHY.cron, drain: { lastStartedAt: hoursAgo(0.1), lastState: "partial" } } }, "drain.failed"));
```

- [ ] **Step 2: Failing pglite test.** Create `scripts/smoke-ops-snapshot.ts`:

```ts
/**
 * Asserts `loadOpsSnapshot` reads each ops condition's source rows from a real database,
 * and that the catalogue turns them into the right condition. The pure predicates live in
 * smoke-ops-alerts; this pins the queries behind them.
 *
 * Run: npx tsx scripts/smoke-ops-snapshot.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
// Off production, so the production-only fields stay quiet unless a section sets it.
delete process.env.VERCEL_ENV;

import { inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { cronRuns } from "../src/db/schema";
import { evaluateOpsConditions } from "../src/lib/ops-alerts";
import { loadOpsSnapshot } from "../src/lib/ops-sweep";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const JOBS = ["imports.process-stalled", "webhooks.drain", "sync.run"] as const;

async function cronRun(job: (typeof JOBS)[number], status: "ok" | "partial" | "failed", minutesAgo: number) {
  const db = await getDb();
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await db.insert(cronRuns).values({ job, trigger: "manual", status, startedAt: at, finishedAt: at });
}

async function idsNow(): Promise<string[]> {
  const now = new Date();
  return evaluateOpsConditions(await loadOpsSnapshot(now, null), now).map((c) => c.id);
}

run(async () => {
  const db = await getDb();
  await db.delete(cronRuns).where(inArray(cronRuns.job, [...JOBS]));

  console.log("Cron ledger...");
  await cronRun("imports.process-stalled", "partial", 180);
  await cronRun("imports.process-stalled", "partial", 120);
  await cronRun("imports.process-stalled", "partial", 60);
  await cronRun("webhooks.drain", "failed", 5);
  const snap = await loadOpsSnapshot(new Date(), null);
  check("the last three process-stalled states are read, newest first",
    JSON.stringify(snap.processStalledRecent) === JSON.stringify(["partial", "partial", "partial"]),
    JSON.stringify(snap.processStalledRecent));
  check("the drain's last state is read", snap.cron.drain.lastState === "failed", JSON.stringify(snap.cron.drain));
  let ids = await idsNow();
  check("three partial runs open cron.partial_streak", ids.includes("cron.partial_streak"), ids.join(","));
  check("a failed drain opens drain.failed", ids.includes("drain.failed"), ids.join(","));

  await cronRun("imports.process-stalled", "ok", 1);
  await cronRun("webhooks.drain", "partial", 1);
  ids = await idsNow();
  check("an ok run breaks the streak", !ids.includes("cron.partial_streak"), ids.join(","));
  check("a partial drain is not drain.failed", !ids.includes("drain.failed"), ids.join(","));
  await db.delete(cronRuns).where(inArray(cronRuns.job, [...JOBS]));

  // (new sections go above this line)

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll ops-snapshot checks passed.");
});
```

Add `"smoke-ops-snapshot": "pglite",` to the pglite section of `MANIFEST` in `scripts/run-smoke.ts` (next to `"smoke-ops-sweep"`).

- [ ] **Step 3: Run, expect failure.** `npx tsx scripts/smoke-ops-alerts.ts` → `FAIL three partial nightly runs in a row …` and `FAIL a failed drain → drain.failed`. `npx tsx scripts/smoke-ops-snapshot.ts` → `FAIL the last three process-stalled states …` (`undefined`) then a `TypeError` reading `snap.cron.drain.lastState`.
- [ ] **Step 4: Catalogue.** In `src/lib/ops-alerts.ts`: inside `OpsSnapshot.cron` after `syncRun: …;` add

```ts
    /** The outbound webhook drain (`/api/webhooks/outbound/drain`), every ten minutes. */
    drain: { lastStartedAt: Date | null; lastState: CronRunState | null };
```

and at top level after `cron: { … };` add

```ts
  /** The last PARTIAL_STREAK process-stalled states, newest first. */
  processStalledRecent: CronRunState[];
```

Below `const WEBHOOK_STREAK = 3;` add `export const PARTIAL_STREAK = 3;`. Extend the process-stalled chain — after the `cron.failed` branch's closing `}` of `out.push(...)`, change the final `}` into:

```ts
  } else if (
    s.processStalledRecent.length >= PARTIAL_STREAK &&
    s.processStalledRecent.slice(0, PARTIAL_STREAK).every((state) => state === "partial")
  ) {
    out.push({
      id: "cron.partial_streak",
      severity: "warning",
      title: "Nightly job keeps finishing partial",
      detail: `The last ${PARTIAL_STREAK} runs ended partial — one housekeeping step is failing every time. The run stats on /admin/health show which counter stopped moving.`,
      href: "/admin/health",
    });
  }

  // The drain's own `partial` means customer endpoints refused deliveries, which is theirs to
  // fix; `failed`/`stale` means the drain itself broke and nothing is being retried.
  const drain = s.cron.drain;
  if (drain.lastState === "failed" || drain.lastState === "stale") {
    out.push({
      id: "drain.failed",
      severity: "warning",
      title: `Outbound webhook drain ${drain.lastState === "stale" ? "was killed" : "failed"}`,
      detail: `Last run ${drain.lastStartedAt?.toISOString() ?? "unknown"} ended ${drain.lastState}; customer webhooks are not being retried.`,
      href: "/admin/health",
    });
  }
```

- [ ] **Step 5: Loader.** In `src/lib/ops-sweep.ts`: import `PARTIAL_STREAK` from `@/lib/ops-alerts` (add to the existing import). Change the first cron query's `.limit(1)` to `.limit(PARTIAL_STREAK)`. Append to the `Promise.all` array (LAST element) and the destructuring (LAST name, `lastDrain`):

```ts
      db
        .select()
        .from(cronRuns)
        .where(eq(cronRuns.job, "webhooks.drain"))
        .orderBy(desc(cronRuns.startedAt))
        .limit(1),
```

After `const syncRun = lastSyncRun[0];` add `const drainRun = lastDrain[0];`. In the returned object add inside `cron: { … }`

```ts
      drain: {
        lastStartedAt: drainRun?.startedAt ?? null,
        lastState: drainRun ? deriveCronRunState(drainRun, now) : null,
      },
```

and at top level `processStalledRecent: lastNightly.map((r) => deriveCronRunState(r, now)),`. (`const nightly = lastNightly[0];` still reads the newest row.)

- [ ] **Step 6: Sweep isolation.** In `scripts/smoke-ops-sweep.ts` `reset()` change the job list to `["imports.process-stalled", "ops.sweep", "sync.run", "webhooks.drain"]`.
- [ ] **Step 7: Runbook rows.**

```md
| `cron.partial_streak` | `/admin/health` → Nightly job → the run's stats. Each housekeeping step in `src/app/api/imports/process-stalled/route.ts` is its own try/catch; the one whose counter stays at zero is failing. Sentry has the exception. |
| `drain.failed` | No outbound webhook is being retried. Run it by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://orbit.jasonpereira.live/api/webhooks/outbound/drain`; a 500 means the drain throws — Sentry has it. |
```

- [ ] **Step 8: Pass.** `npx tsx scripts/smoke-ops-alerts.ts`, `npx tsx scripts/smoke-ops-snapshot.ts`, `npx tsx scripts/smoke-ops-sweep.ts`, `npx tsx scripts/run-smoke.ts --check`; `npm run typecheck && npm run lint`.
- [ ] **Step 9: Commit.** `git add src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts scripts/smoke-ops-snapshot.ts scripts/smoke-ops-sweep.ts scripts/run-smoke.ts docs/RUNBOOK.md && git commit -m "Alert on a partial-run streak and a failing webhook drain" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 4: `backfill.failed` (B6)

Both backfill routes swallow their exception inside `after()` with no row anywhere (`src/app/api/embeddings/backfill/route.ts:36-38`, `src/app/api/linkedin/timeline-events/backfill/route.ts:37-39`).

**Files**
- Modify: `src/lib/error-events.ts` — `ERROR_SOURCES` (`:33-81`)
- Create: `src/lib/backfill-failures.ts`
- Modify: both route files above (catch blocks only; `src/lib/embedding-backfill.ts` is 3a's — untouched)
- Modify: `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts` (loader + the `otherErrors` filter at `:87-89`)
- Modify: `scripts/smoke-ops-alerts.ts`, `scripts/smoke-ops-snapshot.ts`, `scripts/smoke-ops-sweep.ts`, `docs/RUNBOOK.md`

**Interfaces**
- Produces: `ERROR_SOURCES.backfillFailed = "backfill.failed"`; `type BackfillKind = "embeddings" | "linkedin_timeline"`; `recordBackfillFailure(kind: BackfillKind, userId: string, err: unknown): Promise<boolean>` (false when throttled; one row per kind and account per hour); `OpsSnapshot.backfillFailures24h: { accounts: number; kinds: string[] }`; condition `backfill.failed` (warning) at 2+ distinct accounts in 24 h — one account failing is that user's key, which 3a surfaces as an account alert; `backfill.failed` rows are excluded from `errors.burst`.

- [ ] **Step 1: Failing tests.** `scripts/smoke-ops-alerts.ts`: add `backfillFailures24h: { accounts: 0, kinds: [] },` to `HEALTHY`; add before the Slack check from Task 2:

```ts
  check("backfills failing for two accounts → backfill.failed (warning)",
    find({ ...HEALTHY, backfillFailures24h: { accounts: 2, kinds: ["embeddings"] } }, "backfill.failed")?.severity === "warning");
  check("one account's failing backfill is that user's key, not an ops alert",
    !find({ ...HEALTHY, backfillFailures24h: { accounts: 1, kinds: ["embeddings"] } }, "backfill.failed"));
```

`scripts/smoke-ops-snapshot.ts`: add imports `import { and, eq, gt } from "drizzle-orm";` (merge with the existing `inArray` import), `errorEvents` from `../src/db/schema`, `import { ERROR_SOURCES } from "../src/lib/error-events";`, `import { recordBackfillFailure } from "../src/lib/backfill-failures";`, and above the marker:

```ts
  console.log("\nBackfill failures...");
  await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.backfillFailed));
  const boom = new Error("Embedding provider answered 500");
  check("the first failure for an account is recorded", await recordBackfillFailure("embeddings", "snap-backfill-a", boom));
  check("a repeat within the hour is throttled", !(await recordBackfillFailure("embeddings", "snap-backfill-a", boom)));
  check("another kind for the same account is its own row", await recordBackfillFailure("linkedin_timeline", "snap-backfill-a", boom));
  await recordBackfillFailure("embeddings", "snap-backfill-b", boom);
  const rows = await db.select().from(errorEvents).where(and(
    eq(errorEvents.source, ERROR_SOURCES.backfillFailed), gt(errorEvents.createdAt, new Date(Date.now() - 60_000))));
  check("three rows, never the raw error text beyond the friendly message", rows.length === 3, JSON.stringify(rows.map((r) => r.kind)));
  const bf = (await loadOpsSnapshot(new Date(), null)).backfillFailures24h;
  check("the snapshot counts distinct accounts and kinds",
    bf.accounts === 2 && bf.kinds.includes("embeddings") && bf.kinds.includes("linkedin_timeline"), JSON.stringify(bf));
  check("two accounts open backfill.failed", (await idsNow()).includes("backfill.failed"));
  await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.backfillFailed));
```

- [ ] **Step 2: Run, expect failure.** `npx tsx scripts/smoke-ops-snapshot.ts` → `Error: Cannot find module '../src/lib/backfill-failures'`. `npx tsx scripts/smoke-ops-alerts.ts` → `FAIL backfills failing for two accounts …`.
- [ ] **Step 3: Source.** In `ERROR_SOURCES` after `providerHealthCheck` add:

```ts
  /**
   * A background backfill (embeddings, LinkedIn timeline events) threw inside `after()`,
   * where nothing else would ever see it. Throttled per (kind, account) per hour by
   * `recordBackfillFailure`, so a key that keeps failing is one row an hour, not one per kick.
   */
  backfillFailed: "backfill.failed",
```

- [ ] **Step 4: Helper.** Create `src/lib/backfill-failures.ts`:

```ts
import { ERROR_SOURCES, recordErrorEvent, shouldRecordThrottled } from "@/lib/error-events";

/** Which background backfill failed — the `kind` column of the error row. */
export type BackfillKind = "embeddings" | "linkedin_timeline";

/**
 * Records a backfill that threw where only a swallowed `catch {}` would otherwise see it.
 * Returns false when the hourly latch suppressed the write. Never throws. No `next/server`
 * import: smoke scripts call this directly.
 */
export async function recordBackfillFailure(
  kind: BackfillKind,
  userId: string,
  err: unknown
): Promise<boolean> {
  if (!shouldRecordThrottled(`${ERROR_SOURCES.backfillFailed}:${kind}:${userId}`)) return false;
  await recordErrorEvent({ source: ERROR_SOURCES.backfillFailed, kind, userId, message: err });
  return true;
}
```

- [ ] **Step 5: Routes.** Embeddings route: add `import { recordBackfillFailure } from "@/lib/backfill-failures";` and replace its catch with

```ts
    } catch (err) {
      // The work stays pending on purpose and the nightly job re-kicks it; the row is what
      // lets the ops sweep notice a backfill that keeps failing.
      await recordBackfillFailure("embeddings", userId, err);
    }
```

Timeline route: same import, same catch with `"linkedin_timeline"`. Read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md` first (awaiting inside `after()` is fine; it runs within `maxDuration`).
- [ ] **Step 6: Catalogue.** `OpsSnapshot` add `/** Distinct accounts and kinds with a backfill.failed row in the last day. */ backfillFailures24h: { accounts: number; kinds: string[] };`. Below `const OUTAGE_ACCOUNTS = 2;` add `const BACKFILL_FAILING_ACCOUNTS = 2;`. After the `ai.provider_outage` loop add:

```ts
  if (s.backfillFailures24h.accounts >= BACKFILL_FAILING_ACCOUNTS) {
    out.push({
      id: "backfill.failed",
      severity: "warning",
      title: "Background backfills are failing",
      detail: `${s.backfillFailures24h.kinds.join(" and ")} backfill failed for ${s.backfillFailures24h.accounts} accounts in the last day — the provider or Orbit, not one user's key.`,
      href: "/admin/health",
    });
  }
```

- [ ] **Step 7: Loader.** Append to the `Promise.all` (last) and destructuring (last name `backfillAgg`):

```ts
      db
        .select({
          accounts: sql<number>`count(distinct ${errorEvents.userId})::int`,
          kinds: sql<string | null>`string_agg(distinct ${errorEvents.kind}, ',')`,
        })
        .from(errorEvents)
        .where(and(eq(errorEvents.source, ERROR_SOURCES.backfillFailed), gt(errorEvents.createdAt, dayAgo))),
```

Change the `otherErrors` filter to `.filter(([source]) => source !== ERROR_SOURCES.perfSlow && source !== ERROR_SOURCES.backfillFailed)`. In the return add `backfillFailures24h: { accounts: backfillAgg[0]?.accounts ?? 0, kinds: backfillAgg[0]?.kinds ? backfillAgg[0].kinds.split(",") : [] },`.
- [ ] **Step 8: Sweep isolation.** In `scripts/smoke-ops-sweep.ts` import `errorEvents` from the schema and `ERROR_SOURCES` from `../src/lib/error-events`; at the end of `reset()` add `await db.delete(errorEvents).where(inArray(errorEvents.source, [ERROR_SOURCES.backfillFailed]));`.
- [ ] **Step 9: Runbook row.**

```md
| `backfill.failed` | `/admin/health` → error events, source `backfill.failed`: `kind` names the backfill, `message` says why. Two or more accounts means it is not one user's key — check the provider status panel and `ai.provider_outage`. |
```

- [ ] **Step 10: Pass + commit.** The three ops smokes pass; `npm run typecheck && npm run lint`. `git add src/lib/error-events.ts src/lib/backfill-failures.ts src/app/api/embeddings/backfill/route.ts src/app/api/linkedin/timeline-events/backfill/route.ts src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts scripts/smoke-ops-snapshot.ts scripts/smoke-ops-sweep.ts docs/RUNBOOK.md && git commit -m "Record swallowed backfill failures and alert when several accounts hit them" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 5: `config.statement_timeout_unbounded` (B6)

`SHOW statement_timeout` is reported in the deep health view (`src/lib/health.ts:89-94`) but nothing alerts on `"0"`.

**Files**
- Modify: `src/lib/health.ts` — export `probeStatementTimeout` (`:89`)
- Modify: `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts`
- Modify: `scripts/smoke-ops-alerts.ts`, `scripts/smoke-ops-snapshot.ts`, `docs/RUNBOOK.md`

**Interfaces**
- Consumes: `probeStatementTimeout(): Promise<string | null>` (now exported, unchanged body).
- Produces: `OpsSnapshot.statementTimeout: string | null` (probed in production only; null elsewhere and on error); condition `config.statement_timeout_unbounded` (warning) when it equals `"0"`.

- [ ] **Step 1: Failing tests.** `scripts/smoke-ops-alerts.ts`: `HEALTHY` gains `statementTimeout: "20s",`; add:

```ts
  check("statement_timeout 0 → config.statement_timeout_unbounded (warning)",
    find({ ...HEALTHY, statementTimeout: "0" }, "config.statement_timeout_unbounded")?.severity === "warning");
  check("a bounded or unknown timeout is quiet",
    !find(HEALTHY, "config.statement_timeout_unbounded") && !find({ ...HEALTHY, statementTimeout: null }, "config.statement_timeout_unbounded"));
```

`scripts/smoke-ops-snapshot.ts`, above the marker (PGlite's default `statement_timeout` is `0`):

```ts
  console.log("\nstatement_timeout...");
  check("not probed off production", (await loadOpsSnapshot(new Date(), null)).statementTimeout === null);
  process.env.VERCEL_ENV = "production";
  try {
    const prodSnap = await loadOpsSnapshot(new Date(), null);
    check("probed in production (PGlite reports 0)", prodSnap.statementTimeout === "0", String(prodSnap.statementTimeout));
    check("which opens config.statement_timeout_unbounded",
      evaluateOpsConditions(prodSnap, new Date()).some((c) => c.id === "config.statement_timeout_unbounded"));
  } finally {
    delete process.env.VERCEL_ENV;
  }
```

- [ ] **Step 2: Run, expect failure.** ops-alerts → `FAIL statement_timeout 0 …`; ops-snapshot → `FAIL not probed off production` (field is `undefined`).
- [ ] **Step 3: Export.** In `src/lib/health.ts` change `async function probeStatementTimeout()` to `export async function probeStatementTimeout()`.
- [ ] **Step 4: Catalogue.** `OpsSnapshot` add `/** The app role's statement_timeout ("20s", "0" = none). Production only. */ statementTimeout: string | null;`. After the Task 2 block add:

```ts
  if (s.statementTimeout === "0") {
    out.push({
      id: "config.statement_timeout_unbounded",
      severity: "warning",
      title: "Database queries have no time limit",
      detail: "The app role's statement_timeout is 0, so one runaway query can hold the shared compute for every user. Run the ALTER ROLE in docs/RUNBOOK.md → Neon one-time settings.",
      href: "/admin/health",
    });
  }
```

- [ ] **Step 5: Loader.** In `src/lib/ops-sweep.ts` add `import { probeStatementTimeout } from "@/lib/health";`. Before `const nightly = lastNightly[0];` add:

```ts
  // Production only: PGlite and preview branches report Postgres's default of 0, which would
  // open this condition in every local sweep and smoke run.
  const statementTimeout =
    process.env.VERCEL_ENV === "production" ? await probeStatementTimeout().catch(() => null) : null;
```

and `statementTimeout,` in the returned object.
- [ ] **Step 6: Runbook row.**

```md
| `config.statement_timeout_unbounded` | Run `ALTER ROLE <app role> SET statement_timeout = '20s';` (Neon one-time settings below), then confirm `GET /api/health?token=$HEALTH_TOKEN` shows `config.statementTimeout: "20s"`. It clears on the next sweep. |
```

- [ ] **Step 7: Pass + commit.** Ops smokes and `npx tsx scripts/smoke-health.ts` pass; `npm run typecheck && npm run lint`. `git add src/lib/health.ts src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts scripts/smoke-ops-snapshot.ts docs/RUNBOOK.md && git commit -m "Alert when the database role has no statement timeout" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 6: `stripe.unattributed` (B6)

An unattributed fulfilment is a `console.error` (`src/app/api/webhooks/stripe/route.ts:169-173`; logs expire in an hour) and `ignored` never trips the webhook streak.

**Files**
- Modify: `src/lib/error-events.ts`, `src/app/api/webhooks/stripe/route.ts` (the `missing_user_id` block and the `@/lib/error-events` import, `:22`)
- Create: `scripts/smoke-stripe-unattributed.ts` (pglite)
- Modify: `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts`, `scripts/smoke-ops-alerts.ts`, `scripts/smoke-ops-snapshot.ts`, `scripts/smoke-ops-sweep.ts`, `scripts/run-smoke.ts`, `docs/RUNBOOK.md`

**Interfaces**
- Produces: `ERROR_SOURCES.stripeUnattributed = "stripe.unattributed"`; an `error_events` row per unattributed event (`kind` = event type, `context` = `{ eventId, resourceId }` — ids only, never payload fields); `OpsSnapshot.stripeUnattributed24h: { fulfilments: number; other: number }` (fulfilments = kinds starting `checkout.session.`); condition `stripe.unattributed`: critical when `fulfilments > 0`, else warning when `other > 0`.

- [ ] **Step 1: Failing route test.** Create `scripts/smoke-stripe-unattributed.ts`:

```ts
/**
 * A Stripe event Orbit cannot attribute to an account leaves an error_events row the ops
 * sweep reads, not just a log line that expires in an hour.
 *
 * Run: npx tsx scripts/smoke-stripe-unattributed.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const TEST_SECRET = "whsec_test_smoke_unattributed_only";
process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
process.env.STRIPE_SECRET_KEY ||= "sk_test_smoke_only_not_a_real_key";

import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { errorEvents } from "../src/db/schema";
import { ERROR_SOURCES } from "../src/lib/error-events";
import { POST } from "../src/app/api/webhooks/stripe/route";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const EVENT_ID = "evt_smoke_unattributed_1";

function signed(event: unknown) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_SECRET });
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

run(async () => {
  const db = await getDb();
  await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.stripeUnattributed));

  // No client_reference_id, no user metadata, and a customer id no account has.
  const res = await POST(signed({
    id: EVENT_ID,
    object: "event",
    type: "checkout.session.completed",
    created: 1_700_000_000,
    data: { object: { id: "cs_smoke_unattributed", object: "checkout.session", payment_status: "paid",
      customer: "cus_smoke_nobody", customer_details: { email: "buyer@example.test" }, metadata: {} } },
  }) as unknown as Parameters<typeof POST>[0]);
  check("the webhook still answers 200 (a retry would not help)", res.status === 200, String(res.status));

  const rows = await db.select().from(errorEvents).where(and(
    eq(errorEvents.source, ERROR_SOURCES.stripeUnattributed), eq(errorEvents.kind, "checkout.session.completed")));
  check("one stripe.unattributed row, kind = event type", rows.length === 1, JSON.stringify(rows));
  const ctx = (rows[0]?.context ?? {}) as Record<string, unknown>;
  check("context carries the event and session ids", ctx.eventId === EVENT_ID && ctx.resourceId === "cs_smoke_unattributed", JSON.stringify(ctx));
  check("and nothing from the payload itself", !JSON.stringify(rows[0]).includes("buyer@example.test"));

  await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.stripeUnattributed));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll stripe-unattributed checks passed.");
});
```

Add `"smoke-stripe-unattributed": "pglite",` to `MANIFEST`.
- [ ] **Step 2: Failing catalogue/loader tests.** `scripts/smoke-ops-alerts.ts`: `HEALTHY` gains `stripeUnattributed24h: { fulfilments: 0, other: 0 },`; add:

```ts
  check("an unattributed checkout → stripe.unattributed (critical)",
    find({ ...HEALTHY, stripeUnattributed24h: { fulfilments: 1, other: 0 } }, "stripe.unattributed")?.severity === "critical");
  check("an unattributed invoice or refund only → warning",
    find({ ...HEALTHY, stripeUnattributed24h: { fulfilments: 0, other: 2 } }, "stripe.unattributed")?.severity === "warning");
```

`scripts/smoke-ops-snapshot.ts`, above the marker:

```ts
  console.log("\nUnattributed Stripe events...");
  await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.stripeUnattributed));
  await db.insert(errorEvents).values([
    { source: ERROR_SOURCES.stripeUnattributed, kind: "checkout.session.completed", context: { eventId: "evt_a" } },
    { source: ERROR_SOURCES.stripeUnattributed, kind: "invoice.paid", context: { eventId: "evt_b" } },
  ]);
  const su = (await loadOpsSnapshot(new Date(), null)).stripeUnattributed24h;
  check("fulfilments and other events are counted apart", su.fulfilments === 1 && su.other === 1, JSON.stringify(su));
  await db.delete(errorEvents).where(eq(errorEvents.source, ERROR_SOURCES.stripeUnattributed));
```

- [ ] **Step 3: Run, expect failure.** `npx tsx scripts/smoke-stripe-unattributed.ts` → `FAIL one stripe.unattributed row …` (0 rows; `ERROR_SOURCES.stripeUnattributed` is `undefined`). ops-alerts and ops-snapshot fail on the new checks.
- [ ] **Step 4: Source + route.** `ERROR_SOURCES` add `/** A Stripe event no account matched (checkout, invoice, refund). Ids only. */ stripeUnattributed: "stripe.unattributed",`. In the route change the import to `import { ERROR_SOURCES, recordErrorEvent, shouldRecordThrottled } from "@/lib/error-events";` and replace the `missing_user_id` block with:

```ts
    if (decision.outcome === "ignored" && decision.reason === "missing_user_id") {
      console.error(`Stripe ${event.type} (${event.id}) could not be attributed to a user.`);
      // Logs expire in an hour; this row is what the ops sweep reads. Ids only — no amounts,
      // emails or names from the payload. Not throttled: each one is a real incident.
      await recordErrorEvent({
        source: ERROR_SOURCES.stripeUnattributed,
        kind: event.type,
        context: { eventId: event.id, resourceId: decision.resourceId },
      });
    }
```

- [ ] **Step 5: Catalogue.** `OpsSnapshot` add `/** stripe.unattributed rows in the last day: checkout fulfilments vs everything else. */ stripeUnattributed24h: { fulfilments: number; other: number };`. After the `stripe.checkout_error` block add:

```ts
  const unattributed = s.stripeUnattributed24h;
  if (unattributed.fulfilments + unattributed.other > 0) {
    out.push({
      id: "stripe.unattributed",
      severity: unattributed.fulfilments > 0 ? "critical" : "warning",
      title: unattributed.fulfilments > 0 ? "Someone paid and has no plan" : "Stripe events match no account",
      detail: `${unattributed.fulfilments} checkout fulfilment(s) and ${unattributed.other} other Stripe event(s) in the last day matched no Orbit account. error_events (source stripe.unattributed) holds each event id.`,
      href: "/admin/health",
    });
  }
```

- [ ] **Step 6: Loader.** Append to the `Promise.all` (last) and destructuring (last name `unattributedAgg`):

```ts
      db
        .select({ kind: errorEvents.kind, n: sql<number>`count(*)::int` })
        .from(errorEvents)
        .where(and(eq(errorEvents.source, ERROR_SOURCES.stripeUnattributed), gt(errorEvents.createdAt, dayAgo)))
        .groupBy(errorEvents.kind),
```

Return field:

```ts
    stripeUnattributed24h: {
      fulfilments: unattributedAgg.filter((r) => r.kind.startsWith("checkout.session.")).reduce((sum, r) => sum + r.n, 0),
      other: unattributedAgg.filter((r) => !r.kind.startsWith("checkout.session.")).reduce((sum, r) => sum + r.n, 0),
    },
```

- [ ] **Step 7: Sweep isolation + runbook.** In `scripts/smoke-ops-sweep.ts` `reset()` extend the Task 4 array to `[ERROR_SOURCES.backfillFailed, ERROR_SOURCES.stripeUnattributed]`. Runbook row:

```md
| `stripe.unattributed` | Critical: someone paid for a checkout Orbit could not match. error_events (source `stripe.unattributed`) → `context.eventId` → Stripe Dashboard → Events → that id → the customer's email → `/admin/users` → comp the plan, or refund. Warning: an invoice/refund for a customer with no account, usually one created in the Dashboard. |
```

- [ ] **Step 8: Pass + commit.** New smoke, ops smokes and `npx tsx scripts/smoke-stripe-webhook.ts` pass; `npm run typecheck && npm run lint`. `git add src/lib/error-events.ts src/app/api/webhooks/stripe/route.ts src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-stripe-unattributed.ts scripts/smoke-ops-alerts.ts scripts/smoke-ops-snapshot.ts scripts/smoke-ops-sweep.ts scripts/run-smoke.ts docs/RUNBOOK.md && git commit -m "Record unattributed Stripe events and page on unattributed checkouts" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 7: `embedding.backlog` (B6, Phase 3a handoff)

Contacts wait in `contacts.embedding_stale_at` (partial index `contacts_embedding_stale_idx`) until a backfill clears them; nothing watches how long. Phase 3a's "Handoff to 3b" names this condition `embedding.backlog`: accounts with a stale flag older than six hours — several hourly backfill passes — mean a key-level failure is holding search back. This task uses that id and that rule (it needs only the existing column, so it does not wait for 3a); the oldest age goes in the detail. There is no separate `ai.embedding_backlog`.

**Files**
- Modify: `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts` (imports `:1-3`, loader)
- Modify: `scripts/smoke-ops-alerts.ts`, `scripts/smoke-ops-snapshot.ts`, `scripts/smoke-ops-sweep.ts`, `docs/RUNBOOK.md`

**Interfaces**
- Produces: `OpsSnapshot.embeddingBacklog: { accounts: number; oldestAt: Date | null }` — `accounts` = distinct users with a flag older than six hours, `oldestAt` = oldest flag of any age; `export const EMBEDDING_BACKLOG_STALE_HOURS = 6;`; condition `embedding.backlog` (warning) when `accounts >= 1`.

- [ ] **Step 1: Failing tests.** `scripts/smoke-ops-alerts.ts`: `HEALTHY` gains `embeddingBacklog: { accounts: 0, oldestAt: null },`; add:

```ts
  check("an account with a flag older than 6h → embedding.backlog (warning)",
    find({ ...HEALTHY, embeddingBacklog: { accounts: 1, oldestAt: hoursAgo(30) } }, "embedding.backlog")?.severity === "warning");
  check("fresh flags only (the backfill is working) → quiet",
    !find({ ...HEALTHY, embeddingBacklog: { accounts: 0, oldestAt: hoursAgo(2) } }, "embedding.backlog"));
```

`scripts/smoke-ops-snapshot.ts`: import `contacts` from the schema; above the marker:

```ts
  console.log("\nEmbedding backlog...");
  await db.delete(contacts).where(inArray(contacts.userId, ["snap-backlog", "snap-backlog-fresh"]));
  const base = (await loadOpsSnapshot(new Date(), null)).embeddingBacklog.accounts;
  await db.insert(contacts).values({ userId: "snap-backlog-fresh", fullName: "Fresh Flag", embeddingStaleAt: new Date(Date.now() - 3_600_000) });
  check("a flag an hour old is not counted", (await loadOpsSnapshot(new Date(), null)).embeddingBacklog.accounts === base);
  const staleSince = new Date(Date.now() - 30 * 3_600_000);
  await db.insert(contacts).values({ userId: "snap-backlog", fullName: "Backlog Person", embeddingStaleAt: staleSince });
  const eb = (await loadOpsSnapshot(new Date(), null)).embeddingBacklog;
  check("a flag 30h old counts its account", eb.accounts === base + 1, JSON.stringify(eb));
  check("and the oldest flag is read", eb.oldestAt !== null && eb.oldestAt.getTime() <= staleSince.getTime() + 1000, String(eb.oldestAt));
  check("which opens embedding.backlog", (await idsNow()).includes("embedding.backlog"));
  await db.delete(contacts).where(inArray(contacts.userId, ["snap-backlog", "snap-backlog-fresh"]));
```

- [ ] **Step 2: Run, expect failure.** ops-alerts → `FAIL an account with a flag older than 6h …`; ops-snapshot → `TypeError: Cannot read properties of undefined (reading 'accounts')`.
- [ ] **Step 3: Catalogue.** `OpsSnapshot` add:

```ts
  /** Accounts with an embedding flag older than EMBEDDING_BACKLOG_STALE_HOURS, and the oldest flag. */
  embeddingBacklog: { accounts: number; oldestAt: Date | null };
```

Export `EMBEDDING_BACKLOG_STALE_HOURS = 6` below `DRIFT_AFTER_MS`, and after the Task 4 block add:

```ts
  if (s.embeddingBacklog.accounts >= 1) {
    const oldestHours = s.embeddingBacklog.oldestAt
      ? (now.getTime() - s.embeddingBacklog.oldestAt.getTime()) / 3_600_000
      : EMBEDDING_BACKLOG_STALE_HOURS;
    out.push({
      id: "embedding.backlog",
      severity: "warning",
      title: "Semantic search is falling behind",
      detail: `${s.embeddingBacklog.accounts} account(s) have contacts waiting over ${EMBEDDING_BACKLOG_STALE_HOURS} h for search embeddings (oldest ${oldestHours.toFixed(1)} h), so search and chat fall back to keywords for them.`,
      href: "/admin/health",
    });
  }
```

- [ ] **Step 4: Loader.** Add `isNotNull` to the `drizzle-orm` import and `contacts` to the `@/db/schema` import. Append (last) with destructured name `backlogAgg`:

```ts
      db
        .select({
          // Single-table select, so the unprefixed column in the template is unambiguous.
          accounts: sql<number>`(count(distinct ${contacts.userId}) filter (where ${contacts.embeddingStaleAt} < now() - interval '6 hours'))::int`,
          oldest: sql<string | Date | null>`min(${contacts.embeddingStaleAt})`,
        })
        .from(contacts)
        .where(isNotNull(contacts.embeddingStaleAt)),
```

Return field (a raw `min()` comes back as a string on both drivers):

```ts
    embeddingBacklog: {
      accounts: backlogAgg[0]?.accounts ?? 0,
      oldestAt: backlogAgg[0]?.oldest ? new Date(backlogAgg[0].oldest) : null,
    },
```

The `'6 hours'` literal and `EMBEDDING_BACKLOG_STALE_HOURS` must agree; a comment on the constant says so.
- [ ] **Step 5: Sweep isolation.** In `scripts/smoke-ops-sweep.ts` change its drizzle import to `import { eq, inArray, sql } from "drizzle-orm";` and add to `reset()`: ``await db.execute(sql`UPDATE contacts SET embedding_stale_at = NULL WHERE embedding_stale_at < now() - interval '6 hours'`);``
- [ ] **Step 6: Runbook row.**

```md
| `embedding.backlog` | Check `backfill.failed`, `embedding.unembeddable` and `ai.provider_outage` first. One account: usually that user's key (they already see an account alert). Several: `/admin/health` → Nightly job stats — `embeddingsGenerated` 0 with `embeddingBackfillsKicked` > 0 means every kick is failing. |
```

- [ ] **Step 7: Pass + commit.** Ops smokes pass; `npm run typecheck && npm run lint`. `git add src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts scripts/smoke-ops-snapshot.ts scripts/smoke-ops-sweep.ts docs/RUNBOOK.md && git commit -m "Alert when accounts wait over six hours for search embeddings" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 8: Env contract and `.env.example` coverage (B6, B11)

**Files**
- Modify: `src/lib/env.ts` — `EXPECTED_IN_PRODUCTION` (`:31-45`)
- Modify: `.env.example` — Blob block (`:63-68`), after the Microsoft block (`:132-140`), after the contact-form block (`:142-152`), AI block (`:34-37`)
- Create: `scripts/smoke-env-documented.ts` (pure)
- Modify: `scripts/smoke-env.ts`, `scripts/run-smoke.ts`

**Interfaces**
- Produces: six more names in `EXPECTED_IN_PRODUCTION`; a pure guard that fails when `src/` reads `process.env.X` and `.env.example` does not mention `X` (allowlisting platform-injected names), and when a REQUIRED/EXPECTED name is undocumented. Verified at `33a213c`: the undocumented names are exactly `APOLLO_API_KEY`, `BLOB_STORE_ID`, `EVENTBRITE_CLIENT_ID`, `EVENTBRITE_CLIENT_SECRET`, `EVENTBRITE_REDIRECT_URI`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `VERCEL_OIDC_TOKEN`; platform-injected reads are `NODE_ENV`, `NEXT_RUNTIME`, `NEXT_PHASE`, `PORT`, `BUILD_TIME` (set in `next.config.ts`), `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_PROJECT_PRODUCTION_URL`, `NEXT_PUBLIC_VERCEL_ENV`, `ORBIT_PGLITE_DIR`. If the failure lists names Phases 0–2 introduced, document those too.

- [ ] **Step 1: Failing tests.** Create `scripts/smoke-env-documented.ts`:

```ts
/**
 * Every environment variable the app reads is documented in `.env.example`, and so is every
 * name `src/lib/env.ts` requires or expects in production. A variable read by code and
 * mentioned nowhere is how Eventbrite connect failed at OAuth start with nothing to say why.
 *
 * Pure: reads files only. Run: npx tsx scripts/smoke-env-documented.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_IN_PRODUCTION, REQUIRED_IN_PRODUCTION } from "../src/lib/env";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** Set by Vercel, Next, the harness or next.config.ts — never by hand, so never documented. */
const PLATFORM_INJECTED = new Set([
  "NODE_ENV", "NEXT_RUNTIME", "NEXT_PHASE", "PORT", "CI", "BUILD_TIME",
  "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_GIT_COMMIT_SHA", "VERCEL_DEPLOYMENT_ID",
  "VERCEL_PROJECT_PRODUCTION_URL", "NEXT_PUBLIC_VERCEL_ENV", "ORBIT_PGLITE_DIR", "SMOKE_ALLOW_REMOTE",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

const readBy = new Map<string, string>();
for (const file of walk("src")) {
  for (const m of readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
    if (!readBy.has(m[1])) readBy.set(m[1], file);
  }
}
const documented = new Set(
  [...readFileSync(".env.example", "utf8").matchAll(/^#?\s*([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1])
);

console.log(`Variables read in src/: ${readBy.size}; documented in .env.example: ${documented.size}`);
const undocumented = [...readBy.entries()].filter(([name]) => !documented.has(name) && !PLATFORM_INJECTED.has(name));
check("every variable src/ reads is in .env.example (or platform-injected)", undocumented.length === 0,
  undocumented.map(([name, file]) => `${name} (read in ${file})`).join("\n       "));
const contract = [...REQUIRED_IN_PRODUCTION, ...EXPECTED_IN_PRODUCTION].filter((n) => !documented.has(n));
check("every REQUIRED/EXPECTED production variable is documented", contract.length === 0, contract.join(", "));

// (doc checks go above this line)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll env-documentation checks passed.");
```

Add `"smoke-env-documented": "pure",` to `MANIFEST`. In `scripts/smoke-env.ts` add before `const preview = validateEnv(`:

```ts
  for (const name of [
    "SLACK_OPS_CRITICAL_WEBHOOK_URL", "BETTERSTACK_HEARTBEAT_URL", "RESEND_WEBHOOK_SECRET",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI",
  ]) {
    check(`${name} is expected in production`, (EXPECTED_IN_PRODUCTION as readonly string[]).includes(name));
    const r = prod({ [name]: undefined });
    check(`production without ${name} warns and never errors`,
      r.errors.length === 0 && r.warnings.some((w) => w.startsWith(name)), r.errors.join("; "));
  }
```

- [ ] **Step 2: Run, expect failure.** `npx tsx scripts/smoke-env-documented.ts` → `FAIL every variable src/ reads …` listing the nine names above. `npx tsx scripts/smoke-env.ts` → throws `SLACK_OPS_CRITICAL_WEBHOOK_URL is expected in production FAILED`.
- [ ] **Step 3: `env.ts`.** Append inside `EXPECTED_IN_PRODUCTION`, after `"PRODUCTION_DB_HOST",`:

```ts
  // Critical alerts also go here (the channel with push on); unset, criticals only reach #orbit-ops.
  "SLACK_OPS_CRITICAL_WEBHOOK_URL",
  // The only detector for a dead scheduler: the sweep pings it, the monitor pages on silence.
  "BETTERSTACK_HEARTBEAT_URL",
  // Unset, bounces and complaints are never recorded and a dead address is mailed forever.
  "RESEND_WEBHOOK_SECRET",
  // Gmail, Google Contacts and Calendar all ride this one OAuth client.
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
```

- [ ] **Step 4: `.env.example`.** After the `# BLOB_READ_WRITE_TOKEN=` line add:

```
# On Vercel with a Blob store connected to the project, the store id plus Vercel's
# injected OIDC token also work instead of the read-write token (src/lib/contact-avatar.ts).
# VERCEL_OIDC_TOKEN is set by Vercel at runtime and by `vercel env pull` locally.
# BLOB_STORE_ID=store_...
# VERCEL_OIDC_TOKEN=
```

After `# MICROSOFT_TENANT_ID=common` add:

```

# Eventbrite OAuth (optional — the Eventbrite connection on /events). Create an app at
# https://www.eventbrite.com/platform/api-keys with the redirect below. Without the id and
# secret, "Connect Eventbrite" fails at the OAuth start. The redirect defaults to
# APP_BASE_URL + /api/events/eventbrite/callback when unset.
# EVENTBRITE_CLIENT_ID=
# EVENTBRITE_CLIENT_SECRET=
# EVENTBRITE_REDIRECT_URI=http://localhost:3000/api/events/eventbrite/callback
```

After `# CONTACT_FROM_EMAIL=contact@your-verified-domain.com` add:

```

# Hosted outreach (optional). Orbit's own Apollo and Twilio credentials, used only for plans
# with hosted enrichment/sending (src/lib/apollo.ts, src/lib/outreach-send.ts); a user's own
# keys in Settings always win. Unset, those plans silently fall back to "add your own key".
# APOLLO_API_KEY=
# TWILIO_ACCOUNT_SID=AC...
# TWILIO_AUTH_TOKEN=
# TWILIO_FROM_NUMBER=+15555550123
```

- [ ] **Step 5: Pass + commit.** Both smokes pass; `npx tsx scripts/run-smoke.ts --check`; `npm run typecheck && npm run lint`. `git add src/lib/env.ts .env.example scripts/smoke-env-documented.ts scripts/smoke-env.ts scripts/run-smoke.ts && git commit -m "Expect the ops and Google variables in production; document every variable the code reads" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 9: Stale README, performance doc and demo-account comments (B11, C5)

`README.md:79` documents `npm run db:push` (the script is `db:push:DANGEROUS`); its env table (`:85-97`) lists a fraction of `.env.example` and says Apollo/Twilio are undocumented; `docs/performance.md:22` says the `(main)` layout is 300 s (it is 60, `layout.tsx:28`) and omits `capture`/`imports` at 300; three comments say `DEMO_ACCOUNT_USER_ID` is "reachable in production" although `env.ts:62` forbids it there.

**Files**
- Modify: `README.md` (`:53-97`), `docs/performance.md` (`:15-26`), `.env.example` (`:106-111`), `src/actions/billing.ts` (`:185-195`), `src/components/celebration/plan-celebration-watcher.tsx` (`:247-254`), `src/app/(clerk)/(app)/(main)/capture/page.tsx` (`:11-13`)
- Modify: `scripts/smoke-env-documented.ts` (above `// (doc checks go above this line)`)

**Interfaces**
- Produces: two more doc checks — every `npm run <x>` in `README.md`, `docs/RUNBOOK.md`, `docs/performance.md` exists in `package.json`; no file says the showcase shortcut is reachable in production.

- [ ] **Step 1: Failing test.** Add above the doc-checks marker:

```ts
const scripts = Object.keys(
  (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts
);
for (const doc of ["README.md", "docs/RUNBOOK.md", "docs/performance.md"]) {
  const missing = [...readFileSync(doc, "utf8").matchAll(/npm run ([A-Za-z][\w:-]*\w)/g)]
    .map((m) => m[1])
    .filter((name) => !scripts.includes(name));
  check(`${doc}: every \`npm run\` names a real script`, missing.length === 0, missing.join(", "));
}
const staleDemoClaims = [
  ".env.example",
  "src/actions/billing.ts",
  "src/components/celebration/plan-celebration-watcher.tsx",
].filter((file) => /reachable (in|from) production|DOES exist in\s+(\/\/\s*)?production/i.test(readFileSync(file, "utf8")));
check("no comment claims the showcase shortcut works in production (env.ts forbids it)",
  staleDemoClaims.length === 0, staleDemoClaims.join(", "));
```

- [ ] **Step 2: Run, expect failure.** `npx tsx scripts/smoke-env-documented.ts` → `FAIL README.md: every \`npm run\` names a real script` (`db:push`) and `FAIL no comment claims …` (all three files).
- [ ] **Step 3: README.** Replace the Quick start code block and the Database and Env vars subsections (from `## Quick start` through the paragraph ending "for sending outreach email/SMS.") with:

````md
## Quick start

```bash
cp .env.example .env.local
npm ci             # a fresh git worktree has no node_modules of its own
npm run db:setup   # create tables (Neon via DATABASE_URL, or local PGlite)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or the port Next prints if 3000 is taken).

Without Clerk keys, the app runs as `demo-user` in development only, and an empty account is filled with a demo network on its first request (set `ORBIT_DEMO_DATA=off` to start empty). Add a Gemini, OpenAI, or Anthropic API key in **Settings** (or the matching env var, honoured locally only) before using Capture / Chat.

Optional demo contact:

```bash
npm run db:seed
```

Restart `npm run dev` afterward if the server was already running, so it reloads the shared PGlite database.

### Database

| Command | Purpose |
|---|---|
| `npm run db:setup` | Bootstrap schema + verify read/write |
| `npm run db:migrate` | Reconcile the schema to `SCHEMA_VERSION` — what every Vercel build runs before `next build` |
| `npm run db:check` | Fail when DDL changed without a `SCHEMA_VERSION` bump |
| `npm run db:generate` | Generate SQL migrations under `drizzle/` (reference only; the app never applies them) |
| `npm run db:seed` | Insert a sample contact for `demo-user` |

Leave `DATABASE_URL` unset to use on-disk PGlite (`.data/pglite`). Schema changes go in `src/db/index.ts` — read the comment above `SCHEMA_VERSION` first. There is deliberately no plain `db:push`: `drizzle-kit push` would drop columns Orbit manages outside `schema.ts` (`embedding_vector`, the HNSW index, the migration tables).

### Env vars

`.env.example` is the complete, commented list — `scripts/smoke-env-documented.ts` fails CI when the code reads a variable it does not mention. `src/lib/env.ts` says what production requires (`REQUIRED_IN_PRODUCTION`, which fails the build) and expects (`EXPECTED_IN_PRODUCTION`, which warns). To get started you need at most:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon/Postgres connection (omit to use local `.data/pglite`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Auth (omit locally for demo mode) |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Server-side AI, local dev only — on Vercel every user brings a key |
| `ENCRYPTION_SECRET` | Encrypts BYOK keys and OAuth tokens at rest |
| `ORBIT_DEMO_DATA=off` | Start local accounts empty, for onboarding work |
````

- [ ] **Step 4: `docs/performance.md`.** Replace the `maxDuration` table (header row through the `/api/health` row) with (values from `grep -rn "export const maxDuration" src/app` at `33a213c`):

```md
| Where | Value | Why |
|---|---|---|
| pages (default) | Vercel default | Nothing user-facing should need more. |
| `(app)/(main)/layout.tsx` | 60 | Every signed-in page unless it overrides. It was 300 as a stopgap; the dashboard payload is bounded now. |
| `capture/page.tsx`, `imports/page.tsx` | 300 | Their server actions summarise a meeting (several model calls) or start a large import. |
| `chat/page.tsx`, `/api/chat` | 60 | A full model completion on the user's own key. |
| `/api/imports/process-stalled`, `/api/embeddings/backfill`, `/api/linkedin/timeline-events/backfill`, `/api/imports/[id]/continue`, `/api/sync/run`, `/api/capture/jobs`, `/api/capture/jobs/[id]/run`, `/api/scan/[token]/pages` | 300 | Batch work that self-continues past the ceiling. |
| `/api/capture/meetings/[id]/chunks` | 120 | One chunk's transcription, which can fall through Wispr's 60 s deadline before Whisper starts. |
| `/api/ops/sweep`, `/api/webhooks/outbound/drain`, `/api/mcp`, `/api/mcp/[token]`, `/api/scan/[token]/finish` | 60 | Bounded reads, or network work inside its own 40 s budget. |
| `/api/extension/parse`, `/api/extension/starters` | 30 | One small completion for the extension panel. |
| `/api/health` | 10 | Every check inside is capped at 4 s. |
```

- [ ] **Step 5: Comments.** `.env.example` `:106-111` becomes:

```
# Live-demo cheat code (optional, NOT for production). The Clerk user id that Ctrl+Shift+U
# may grant Orbit Lifetime to, with the plan-celebration animation, instead of a real Stripe
# checkout. Scoped to exactly this one account. src/lib/env.ts refuses a production build
# that sets it, so live demos run on a preview or local deployment. Unset disables it.
# DEMO_ACCOUNT_USER_ID=user_xxxxxxxxxxxxxxxxxxxxxxxx
```

`src/actions/billing.ts` — replace the doc comment above `triggerDemoCelebration` with:

```ts
/**
 * Live-demo cheat code: grants Lifetime with a keypress instead of a real checkout.
 *
 * Deliberately narrow. The gate is not "is this dev/staging" but "is this literally the one
 * account the showcase runs from": `DEMO_ACCOUNT_USER_ID` names that account's Clerk id, and
 * every other caller gets `{ ok: false }` with nothing changed. `src/lib/env.ts` forbids the
 * variable in production builds, so there it is always unset and the shortcut is off; live
 * demos run from a preview or local deployment.
 */
```

`plan-celebration-watcher.tsx` — replace the comment block starting `// Live-demo trigger — Ctrl+Shift+U.` (through `// that specific account.`) with:

```ts
  // Live-demo trigger — Ctrl+Shift+U. Unlike the dev preview above, this is not gated on
  // NODE_ENV: it is how the showcase account gets Lifetime on stage without a real Stripe
  // checkout, on whatever preview or local deployment the demo runs from. The guard that
  // matters is server-side: `triggerDemoCelebration` only comps the one Clerk account named
  // by `DEMO_ACCOUNT_USER_ID`, which src/lib/env.ts forbids in production, so there every
  // keypress is a silent no-op.
```

`capture/page.tsx` — replace `// a stopgap slated to go back to 60; this page needs its own.` (and the line before it) with `// hour-long meeting is a map-reduce over several model calls. The (main) layout is 60, so this page needs its own.` keeping the first comment line.
- [ ] **Step 6: Pass.** `npx tsx scripts/smoke-env-documented.ts` passes; `npm run typecheck && npm run lint`. No UI change (comments only).
- [ ] **Step 7: Commit.** `git add README.md docs/performance.md .env.example src/actions/billing.ts src/components/celebration/plan-celebration-watcher.tsx "src/app/(clerk)/(app)/(main)/capture/page.tsx" scripts/smoke-env-documented.ts && git commit -m "Fix the stale README, maxDuration table and showcase-account comments" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 10: `linkedin_slug` is rewritten only when its expression changed (B7a)

`SCALE_DDL` runs `ALTER TABLE contacts DROP COLUMN IF EXISTS linkedin_slug` and re-adds it on every sweep (`src/db/index.ts:1445-1461`): a full rewrite of `contacts` under an exclusive lock while the previous deployment is serving. The guard reads the stored generated expression (`pg_get_expr(adbin, adrelid)` from `pg_attrdef`) and drops only when it differs. `SCALE_DDL`'s text is NOT changed, so the schema-ddl lock does not move and no version bump is needed.

**Files**
- Modify: `src/db/index.ts` — new exports just above `export const SCALE_DDL` (`:1417`); `applyScaleSchema` (`:1709-1710`)
- Create: `scripts/smoke-linkedin-slug-guard.ts` (pglite); modify `scripts/run-smoke.ts`

**Interfaces**
- Produces: `LINKEDIN_SLUG_EXPRESSION: string`, `DROP_LINKEDIN_SLUG_STATEMENT: string`, `normalizeGeneratedExpression(expr: string): string` (lowercase, strip `::text`, whitespace and parentheses — Postgres re-renders a stored expression with casts and upper-case keywords), `linkedinSlugNeedsRewrite(stored: string | null): boolean` (null = no column = nothing to drop). If Neon ever renders the expression differently the guard returns "needs rewrite" and the sweep behaves exactly as today — the safe failure.

- [ ] **Step 1: Failing test.** Create `scripts/smoke-linkedin-slug-guard.ts`:

```ts
/**
 * The linkedin_slug generated column is dropped and re-added only when its stored
 * expression is not the one SCALE_DDL declares. Dropping rewrote all of `contacts` under an
 * exclusive lock on every version bump. `attnum` is the tell: a drop-and-add gives the
 * column a new one.
 *
 * Run: npx tsx scripts/smoke-linkedin-slug-guard.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import {
  DROP_LINKEDIN_SLUG_STATEMENT, LINKEDIN_SLUG_EXPRESSION, SCALE_DDL, SCHEMA_VERSION,
  getDb, linkedinSlugNeedsRewrite, normalizeGeneratedExpression, reconcileSchema, rowsOf,
} from "../src/db";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "smoke-slug-guard";

async function slugColumn(): Promise<{ attnum: number; expr: string } | undefined> {
  const db = await getDb();
  return rowsOf<{ attnum: number; expr: string }>(await db.execute(sql`
    SELECT a.attnum, pg_get_expr(d.adbin, d.adrelid) AS expr
      FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'contacts'::regclass AND a.attname = 'linkedin_slug' AND NOT a.attisdropped`))[0];
}

async function forceSweep() {
  const db = await getDb();
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`);
  return reconcileSchema();
}

run(async () => {
  console.log("The guard's own invariants...");
  check("SCALE_DDL still carries the exact DROP the guard filters", SCALE_DDL.includes(DROP_LINKEDIN_SLUG_STATEMENT));
  const add = SCALE_DDL.find((s) => s.includes("ADD COLUMN IF NOT EXISTS linkedin_slug")) ?? "";
  check("SCALE_DDL's ADD uses LINKEDIN_SLUG_EXPRESSION",
    normalizeGeneratedExpression(add).includes(normalizeGeneratedExpression(LINKEDIN_SLUG_EXPRESSION)));
  check("no column means nothing to rewrite", linkedinSlugNeedsRewrite(null) === false);

  console.log("\nA sweep over a current column leaves it alone...");
  const before = await slugColumn();
  check("the stored expression reads as current", Boolean(before) && !linkedinSlugNeedsRewrite(before!.expr), before?.expr);
  const swept = await forceSweep();
  check("the sweep ran cleanly", swept.applied === true && swept.failed.length === 0, JSON.stringify(swept));
  const after = await slugColumn();
  check("the column was not dropped and re-added (attnum unchanged)", after?.attnum === before?.attnum,
    `${before?.attnum} → ${after?.attnum}`);

  console.log("\nA column carrying the old expression is rewritten...");
  const db = await getDb();
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await db.execute(sql.raw(DROP_LINKEDIN_SLUG_STATEMENT));
  // The earlier revision: stops at the first "/" only, so a query string stays on the slug.
  await db.execute(sql.raw(`ALTER TABLE contacts ADD COLUMN linkedin_slug text GENERATED ALWAYS AS (
    lower(nullif(split_part(split_part(coalesce(linkedin_url, ''), '/in/', 2), '/', 1), ''))) STORED`));
  await db.execute(sql`INSERT INTO contacts (user_id, full_name, linkedin_url)
    VALUES (${USER}, 'Ada Query', 'https://www.linkedin.com/in/ada?trk=feed')`);
  const old = await slugColumn();
  check("fixture: the old expression reads as stale", Boolean(old) && linkedinSlugNeedsRewrite(old!.expr), old?.expr);
  const rewrite = await forceSweep();
  check("the sweep ran cleanly", rewrite.applied === true && rewrite.failed.length === 0, JSON.stringify(rewrite));
  const fixed = await slugColumn();
  check("the column now carries the current expression", Boolean(fixed) && !linkedinSlugNeedsRewrite(fixed!.expr), fixed?.expr);
  const slug = rowsOf<{ linkedin_slug: string | null }>(
    await db.execute(sql`SELECT linkedin_slug FROM contacts WHERE user_id = ${USER}`))[0]?.linkedin_slug;
  check("existing rows are recomputed with the query string stripped", slug === "ada", String(slug));
  check("the slug index is back",
    rowsOf(await db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'contacts_slug_idx'`)).length === 1);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll linkedin-slug guard checks passed.");
});
```

Add `"smoke-linkedin-slug-guard": "pglite",` to `MANIFEST`.
- [ ] **Step 2: Run, expect failure.** `npx tsx scripts/smoke-linkedin-slug-guard.ts` → `FAIL SCALE_DDL still carries …` then `TypeError: normalizeGeneratedExpression is not a function`.
- [ ] **Step 3: Exports.** In `src/db/index.ts`, directly above the doc comment of `export const SCALE_DDL`, add:

```ts
/**
 * The generated expression behind `contacts.linkedin_slug`, byte-for-byte the one in the
 * SCALE_DDL ADD below (whitespace aside). `applyScaleSchema` compares the stored expression
 * against it; `scripts/smoke-linkedin-slug-guard.ts` asserts the two cannot drift.
 */
export const LINKEDIN_SLUG_EXPRESSION =
  "lower(nullif(split_part(split_part(split_part(split_part(coalesce(linkedin_url, ''), '/in/', 2), '?', 1), '#', 1), '/', 1), ''))";

/** The rewrite SCALE_DDL performs when that expression changes. Matched by exact text. */
export const DROP_LINKEDIN_SLUG_STATEMENT = "ALTER TABLE contacts DROP COLUMN IF EXISTS linkedin_slug";

/** Postgres re-renders stored expressions (casts, upper-case keywords, parentheses). */
export function normalizeGeneratedExpression(expr: string): string {
  return expr.toLowerCase().replace(/::text/g, "").replace(/[\s()]/g, "");
}

/** Whether the stored linkedin_slug expression differs from LINKEDIN_SLUG_EXPRESSION. */
export function linkedinSlugNeedsRewrite(stored: string | null): boolean {
  if (stored === null) return false; // no column yet: the ADD creates it
  return normalizeGeneratedExpression(stored) !== normalizeGeneratedExpression(LINKEDIN_SLUG_EXPRESSION);
}

/** The stored expression, null when there is no such column, undefined when unreadable. */
async function storedLinkedinSlugExpression(run: StatementRunner): Promise<string | null | undefined> {
  try {
    const result = await run(
      `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
         FROM pg_attribute a
         JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = to_regclass('public.contacts')
          AND a.attname = 'linkedin_slug'
          AND NOT a.attisdropped`
    );
    return rowsOf<{ expr: string | null }>(result)[0]?.expr ?? null;
  } catch {
    return undefined;
  }
}
```

(`StatementRunner` is declared further down the file; a type alias is usable before its declaration. `rowsOf` is a hoisted function declaration.) Do NOT edit the comment above the DROP inside `SCALE_DDL`: it already contains a backtick pair, `scripts/smoke-schema-ddl.ts` hashes backtick bodies in that array, and any edit there moves the lock and forces a version bump this plan must not take.
- [ ] **Step 4: `applyScaleSchema`.** Replace its first line `await runStatements(run, SCALE_DDL, "scale DDL", failed);` with:

```ts
  // The linkedin_slug DROP rewrites every contacts row under an exclusive lock, so it runs
  // only when the stored expression is not the declared one (or cannot be read — then the
  // old unconditional behaviour is the safe default).
  const stored = await storedLinkedinSlugExpression(run);
  const rewriteSlug = stored === undefined || linkedinSlugNeedsRewrite(stored);
  const statements = rewriteSlug ? SCALE_DDL : SCALE_DDL.filter((s) => s !== DROP_LINKEDIN_SLUG_STATEMENT);
  await runStatements(run, statements, "scale DDL", failed);
```

- [ ] **Step 5: Pass.** The new smoke passes; `npx tsx scripts/smoke-scale-schema.ts`, `npx tsx scripts/smoke-schema-upgrade.ts`, `npx tsx scripts/smoke-schema-ddl.ts` (lock unchanged) and `npx tsx scripts/smoke-contacts-page.ts` pass; `npm run typecheck && npm run lint`.
- [ ] **Step 6: Commit.** `git add src/db/index.ts scripts/smoke-linkedin-slug-guard.ts scripts/run-smoke.ts && git commit -m "Rewrite contacts.linkedin_slug only when its generated expression changed" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 11: DDL fingerprint beside the schema version (B7b) — the plan's one schema change

A burned version number (two branches both shipping `SCHEMA_VERSION = N`, which the changelog says happened at 33, 44, 46, 53, 54) makes the second branch's statements — including data statements in `alters` such as the embeddings dedupe `DELETE` and `DROP INDEX` — silently skip. The task text mentions a runtime `schemaFingerprint()`; **none exists at `33a213c`** (the only fingerprint is the build-time lock in `scripts/smoke-schema-ddl.ts:305-331`), so this task defines it.

**Schema change:** `schema_migrations.fingerprint text`, runtime-managed: added to the `CREATE TABLE IF NOT EXISTS` in `schemaIsCurrent` (fresh databases) and by `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `recordSchemaVersion` (existing ones). A database without the column fails the `SELECT` in `schemaIsCurrent`, which answers "not current", so the first deploy of this task runs one full sweep and records the fingerprint. No `SCHEMA_VERSION` bump, no lock update. Land Task 10 first so that sweep does not rewrite `contacts`.

**Files**
- Modify: `src/db/index.ts` — the `node:crypto` import (`:11`), `schemaIsCurrent` (`:1764-1782`), `recordSchemaVersion` (`:1807-1819`), new `schemaFingerprint`/`isSchemaCurrent` beside them
- Modify: `scripts/smoke-scale-schema.ts` (`:333-336`)
- Create: `scripts/smoke-schema-fingerprint.ts` (pglite); modify `scripts/run-smoke.ts`

**Interfaces**
- Produces: `schemaFingerprint(): string` (sha256 hex of `DDL`, every `SCALE_DDL` statement and every `alters` statement — `alters` already spreads `ADMIN_V2_STATEMENTS` — whitespace-collapsed, memoised); `isSchemaCurrent(recorded: { version: number; fingerprint: string | null } | null): boolean` — version ahead → current (a rollback is serving: never re-sweep with older DDL, the never-downgrade rule Phase 0 Task 6 introduced); behind → not current; equal → current only when the fingerprint matches. DDL embedded in code (`migratePgvector`, `ensureColumn` calls) is not hashed; changing it still needs a version bump, as today.
- Merge note: Phase 0 Task 6 rewrote these two functions. Keep its behaviour (recorded ≥ expected is healthy; never downgrade) — the code below includes both; if Phase 0 added anything else, keep that too.

- [ ] **Step 1: Failing test.** Create `scripts/smoke-schema-fingerprint.ts`:

```ts
/**
 * The schema version is recorded with a fingerprint of the DDL that produced it, so a burned
 * version number cannot skip another branch's statements, and a rollback never re-sweeps.
 *
 * Run: npx tsx scripts/smoke-schema-fingerprint.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { SCHEMA_VERSION, getDb, isSchemaCurrent, reconcileSchema, rowsOf, schemaFingerprint } from "../src/db";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

run(async () => {
  const db = await getDb();
  const recorded = async () =>
    rowsOf<{ version: number | string; fingerprint: string | null }>(
      await db.execute(sql`SELECT version, fingerprint FROM schema_migrations WHERE id = 1`))[0];
  const fp = schemaFingerprint();

  console.log("The decision (isSchemaCurrent)...");
  check("the fingerprint is a stable sha256", /^[0-9a-f]{64}$/.test(fp) && fp === schemaFingerprint());
  check("no row → sweep", !isSchemaCurrent(null));
  check("behind → sweep", !isSchemaCurrent({ version: SCHEMA_VERSION - 1, fingerprint: fp }));
  check("ahead (a rollback is serving) → leave it", isSchemaCurrent({ version: SCHEMA_VERSION + 1, fingerprint: "other" }));
  check("same number, same DDL → leave it", isSchemaCurrent({ version: SCHEMA_VERSION, fingerprint: fp }));
  check("same number, other DDL (a burned number) → sweep", !isSchemaCurrent({ version: SCHEMA_VERSION, fingerprint: "another-branch" }));
  check("same number, stamped before fingerprints → sweep", !isSchemaCurrent({ version: SCHEMA_VERSION, fingerprint: null }));

  console.log("\nA fresh database...");
  const fresh = await recorded();
  check("records version and fingerprint", Number(fresh?.version) === SCHEMA_VERSION && fresh?.fingerprint === fp, JSON.stringify(fresh));

  console.log("\nA burned number: same version, another branch's DDL...");
  await db.execute(sql`DROP INDEX IF EXISTS contacts_embedding_stale_idx`);
  await db.execute(sql`UPDATE schema_migrations SET fingerprint = 'another-branch' WHERE id = 1`);
  const burned = await reconcileSchema();
  check("the sweep runs although the version matches", burned.applied === true && burned.failed.length === 0, JSON.stringify(burned));
  check("a statement the burned number would have skipped ran",
    rowsOf(await db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'contacts_embedding_stale_idx'`)).length === 1);
  check("this build's fingerprint is recorded", (await recorded())?.fingerprint === fp);
  check("and the next reconcile is a no-op", (await reconcileSchema()).applied === false);

  console.log("\nA database stamped before the column existed...");
  await db.execute(sql`ALTER TABLE schema_migrations DROP COLUMN fingerprint`);
  const legacy = await reconcileSchema();
  check("takes the full pass once", legacy.applied === true && legacy.failed.length === 0, JSON.stringify(legacy));
  check("and gains the column with this build's fingerprint", (await recorded())?.fingerprint === fp);

  console.log("\nA newer build already migrated this database...");
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION + 1}, fingerprint = 'newer-build' WHERE id = 1`);
  check("an older build does not re-sweep", (await reconcileSchema()).applied === false);
  const kept = await recorded();
  check("and never overwrites the newer stamp", Number(kept?.version) === SCHEMA_VERSION + 1 && kept?.fingerprint === "newer-build", JSON.stringify(kept));

  // Leave the shared PGlite as every later script expects it.
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION}, fingerprint = ${fp} WHERE id = 1`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll schema-fingerprint checks passed.");
});
```

Add `"smoke-schema-fingerprint": "pglite",` to `MANIFEST`.
- [ ] **Step 2: Run, expect failure.** `npx tsx scripts/smoke-schema-fingerprint.ts` → `TypeError: schemaFingerprint is not a function`.
- [ ] **Step 3: Implement.** Change `import { randomUUID } from "node:crypto";` to `import { createHash, randomUUID } from "node:crypto";`. Replace `schemaIsCurrent` with:

```ts
/**
 * A hash of every statement in `DDL`, `SCALE_DDL` and `alters` (which spreads
 * `ADMIN_V2_STATEMENTS`), whitespace-collapsed. Recorded beside SCHEMA_VERSION: two
 * branches that both shipped the same number with different statements disagree here, so
 * the second one's statements run instead of being skipped by a matching integer.
 */
let fingerprintMemo: string | undefined;
export function schemaFingerprint(): string {
  if (!fingerprintMemo) {
    const statements = [DDL, ...SCALE_DDL, ...alters]
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    fingerprintMemo = createHash("sha256").update(statements.join("\n")).digest("hex");
  }
  return fingerprintMemo;
}

/** The decision `schemaIsCurrent` makes from the recorded row. Pure. */
export function isSchemaCurrent(recorded: { version: number; fingerprint: string | null } | null): boolean {
  if (!recorded || !Number.isFinite(recorded.version)) return false;
  // A newer build migrated this database and an older one is serving (a rollback): never
  // re-sweep with older DDL — the never-downgrade rule.
  if (recorded.version > SCHEMA_VERSION) return true;
  if (recorded.version < SCHEMA_VERSION) return false;
  return recorded.fingerprint === schemaFingerprint();
}

/**
 * Whether the recorded schema already matches this build.
 *
 * One SELECT standing in for the whole DDL sweep. Anything unexpected (no table yet, a
 * database that predates the fingerprint column, a permissions problem) answers "no" and the
 * caller does the full pass — being wrong here costs a slow boot, never a wrong schema.
 */
export async function schemaIsCurrent(run: StatementRunner): Promise<boolean> {
  try {
    await run(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id integer PRIMARY KEY DEFAULT 1,
         version integer NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now(),
         fingerprint text,
         CONSTRAINT schema_migrations_single_row CHECK (id = 1)
       )`
    );
    const result = await run(`SELECT version, fingerprint FROM schema_migrations WHERE id = 1`);
    const row = rowsOf<{ version: number | string; fingerprint: string | null }>(result)[0];
    return isSchemaCurrent(row ? { version: Number(row.version), fingerprint: row.fingerprint ?? null } : null);
  } catch {
    return false;
  }
}
```

Replace `recordSchemaVersion` with:

```ts
export async function recordSchemaVersion(run: StatementRunner) {
  try {
    // Databases stamped before the fingerprint existed lack the column. Idempotent.
    await run(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS fingerprint text`);
    // Never downgrades: a rollback that sweeps must not overwrite a newer build's stamp.
    // The fingerprint is hex, so inlining it is safe.
    await run(
      `INSERT INTO schema_migrations (id, version, applied_at, fingerprint)
       VALUES (1, ${SCHEMA_VERSION}, now(), '${schemaFingerprint()}')
       ON CONFLICT (id) DO UPDATE
         SET version = EXCLUDED.version,
             applied_at = EXCLUDED.applied_at,
             fingerprint = EXCLUDED.fingerprint
         WHERE schema_migrations.version <= EXCLUDED.version`
    );
  } catch (err) {
    // A boot that cannot record its version just re-runs the idempotent sweep next time.
    console.error("[db] could not record schema version\n", err);
  }
}
```

- [ ] **Step 4: Scale-schema smoke.** In `scripts/smoke-scale-schema.ts` replace the two lines that set `SCHEMA_VERSION + 1` and check "a version mismatch forces the full sweep" (if Phase 0 already rewrote them, replace its version) with:

```ts
  await client.query(`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`);
  check("a database behind the code forces the full sweep", !(await schemaIsCurrent(client.query.bind(client))));
  await client.query(`UPDATE schema_migrations SET version = ${SCHEMA_VERSION + 1} WHERE id = 1`);
  check("a database a newer build migrated is left alone", await schemaIsCurrent(client.query.bind(client)));
  await client.query(`UPDATE schema_migrations SET version = ${SCHEMA_VERSION}, fingerprint = 'another-branch' WHERE id = 1`);
  check("the same number stamped by other DDL forces the full sweep", !(await schemaIsCurrent(client.query.bind(client))));
```

- [ ] **Step 5: Pass.** New smoke passes; also `smoke-scale-schema` (still "the check costs 2 statements"), `smoke-schema-upgrade`, `smoke-sync-columns`, `smoke-migration-guards`, `smoke-health`, `smoke-schema-ddl`; `npm run typecheck && npm run lint`; `npm run db:setup` prints the table list without errors.
- [ ] **Step 6: Commit.** `git add src/db/index.ts scripts/smoke-schema-fingerprint.ts scripts/smoke-scale-schema.ts scripts/run-smoke.ts && git commit -m "Record a DDL fingerprint beside the schema version" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 12: `drizzle-kit push` refuses without consent or against production (B7c)

`npm run db:push:DANGEROUS` is plain `drizzle-kit push`; `drizzle.config.ts:1-14` loads `.env.local` (the remote Neon URL in the main checkout) with no guard. drizzle-kit 0.31.10 loads the config in-process through its tsx register (`node_modules/drizzle-kit/bin.cjs`, `safeRegister`), so `process.argv` carries the subcommand.

**Files**
- Modify: `src/lib/env.ts` (append after `checkMigrationTarget`), `drizzle.config.ts`, `.env.example` (after `# PRODUCTION_DB_HOST=…`, `:10`), `README.md` (Database table from Task 9)
- Create: `scripts/smoke-drizzle-guard.ts` (pure); modify `scripts/run-smoke.ts`

**Interfaces**
- Produces: `DRIZZLE_WRITE_COMMANDS = ["push", "migrate", "drop"] as const`; `checkDrizzleCommand(argv: readonly string[], env: Record<string, string | undefined>): { allowed: boolean; reason: string }` — allowed for non-writing commands (`generate`, `studio`, `check`); for writing ones only when `ALLOW_DRIZZLE_PUSH=1`, `DATABASE_URL` parses, `PRODUCTION_DB_HOST` is set, and the hosts differ (fail-closed when production cannot be identified).

- [ ] **Step 1: Failing test.** Create `scripts/smoke-drizzle-guard.ts`:

```ts
/**
 * `drizzle-kit push` computes DROPs for everything Orbit manages outside schema.ts
 * (embedding_vector, the HNSW index, the migration tables). The config refuses it unless
 * explicitly allowed and pointed away from production.
 *
 * Pure: the subprocess check targets 127.0.0.1:1, where nothing listens, and the guard
 * refuses before any connection. Run: npx tsx scripts/smoke-drizzle-guard.ts
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkDrizzleCommand } from "../src/lib/env";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const PROD = "ep-prod-1234.us-east-2.aws.neon.tech";
const BRANCH = "ep-branch-5678.us-east-2.aws.neon.tech";
const url = (host: string) => `postgres://u:secret@${host}/orbit?sslmode=require`;
const argv = (cmd: string) => ["/usr/bin/node", "/x/node_modules/drizzle-kit/bin.cjs", cmd];

check("generate is always allowed", checkDrizzleCommand(argv("generate"), {}).allowed);
check("studio is always allowed", checkDrizzleCommand(argv("studio"), { DATABASE_URL: url(PROD), PRODUCTION_DB_HOST: PROD }).allowed);
const noConsent = checkDrizzleCommand(argv("push"), { DATABASE_URL: url(BRANCH), PRODUCTION_DB_HOST: PROD });
check("push without ALLOW_DRIZZLE_PUSH=1 is refused, naming the variable",
  !noConsent.allowed && noConsent.reason.includes("ALLOW_DRIZZLE_PUSH"), noConsent.reason);
const atProd = checkDrizzleCommand(argv("push"), { ALLOW_DRIZZLE_PUSH: "1", DATABASE_URL: url(PROD), PRODUCTION_DB_HOST: PROD });
check("push at the production host is refused even with consent", !atProd.allowed && atProd.reason.includes(PROD), atProd.reason);
check("the refusal never prints the password", !atProd.reason.includes("secret"));
check("push with PRODUCTION_DB_HOST unset is refused (cannot tell)",
  !checkDrizzleCommand(argv("push"), { ALLOW_DRIZZLE_PUSH: "1", DATABASE_URL: url(BRANCH) }).allowed);
check("migrate and drop are guarded the same way",
  !checkDrizzleCommand(argv("migrate"), {}).allowed && !checkDrizzleCommand(argv("drop"), {}).allowed);
check("push with consent at a non-production host is allowed",
  checkDrizzleCommand(argv("push"), { ALLOW_DRIZZLE_PUSH: "1", DATABASE_URL: url(BRANCH), PRODUCTION_DB_HOST: PROD }).allowed);

console.log("\nThe real CLI, through drizzle.config.ts...");
const r = spawnSync(process.execPath, [join("node_modules", "drizzle-kit", "bin.cjs"), "push"], {
  env: { ...process.env, ALLOW_DRIZZLE_PUSH: "", DATABASE_URL: "postgres://u:p@127.0.0.1:1/none", PRODUCTION_DB_HOST: PROD },
  encoding: "utf8",
  timeout: 60_000,
});
check("drizzle-kit push exits nonzero", r.status !== 0, `status ${r.status}`);
check("because the config refused it", `${r.stdout}${r.stderr}`.includes("ALLOW_DRIZZLE_PUSH"), `${r.stdout}${r.stderr}`.slice(0, 400));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll drizzle-guard checks passed.");
process.exit(0);
```

Add `"smoke-drizzle-guard": "pure",` to `MANIFEST`.
- [ ] **Step 2: Run, expect failure.** `npx tsx scripts/smoke-drizzle-guard.ts` → `TypeError: checkDrizzleCommand is not a function`.
- [ ] **Step 3: Guard.** Append to `src/lib/env.ts`:

```ts
/** drizzle-kit subcommands that write schema to the database the config points at. */
export const DRIZZLE_WRITE_COMMANDS = ["push", "migrate", "drop"] as const;

/**
 * Whether this drizzle-kit invocation may run. `drizzle.config.ts` calls it with its own
 * argv. Fail-closed for writing commands: they need explicit consent, a parseable target,
 * and a PRODUCTION_DB_HOST that is not that target. Names hosts, never credentials.
 */
export function checkDrizzleCommand(
  argv: readonly string[],
  env: EnvBag
): { allowed: boolean; reason: string } {
  const command = argv.find((a) => (DRIZZLE_WRITE_COMMANDS as readonly string[]).includes(a));
  if (!command) return { allowed: true, reason: "not a schema-writing drizzle-kit command" };
  if (env.ALLOW_DRIZZLE_PUSH?.trim() !== "1") {
    return {
      allowed: false,
      reason:
        `drizzle-kit ${command} is refused unless ALLOW_DRIZZLE_PUSH=1. It drops what Orbit ` +
        "manages outside schema.ts (embedding_vector, the HNSW index, the migration tables); " +
        "use npm run db:migrate instead.",
    };
  }
  const target = databaseHost(env.DATABASE_URL);
  if (!target) return { allowed: false, reason: `drizzle-kit ${command} needs a postgres:// DATABASE_URL.` };
  const production = env.PRODUCTION_DB_HOST?.trim().toLowerCase();
  if (!production) {
    return {
      allowed: false,
      reason: `drizzle-kit ${command} is refused while PRODUCTION_DB_HOST is unset: nothing can tell ${target} from production.`,
    };
  }
  if (target === production) {
    return {
      allowed: false,
      reason: `drizzle-kit ${command} is refused: DATABASE_URL points at ${target}, which PRODUCTION_DB_HOST names as production.`,
    };
  }
  return { allowed: true, reason: `target ${target} is not the production host` };
}
```

Replace `drizzle.config.ts` with:

```ts
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { checkDrizzleCommand } from "./src/lib/env";

config({ path: ".env.local" });
config(); // fallback .env

// .env.local in the main checkout carries the remote Neon URL. Refuse schema-writing
// commands unless explicitly allowed and pointed away from production.
const verdict = checkDrizzleCommand(process.argv, process.env);
if (!verdict.allowed) {
  console.error(`drizzle.config: ${verdict.reason}`);
  process.exit(1);
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
});
```

- [ ] **Step 4: Docs.** `.env.example` after `# PRODUCTION_DB_HOST=…`:

```
#
# drizzle-kit push/migrate/drop are refused by drizzle.config.ts unless this is 1 AND
# DATABASE_URL is not PRODUCTION_DB_HOST. Set it only for the one command, never in a file.
# ALLOW_DRIZZLE_PUSH=1
```

README Database table, add a row: `| \`npm run db:push:DANGEROUS\` | \`drizzle-kit push\`. Refused unless \`ALLOW_DRIZZLE_PUSH=1\` and \`DATABASE_URL\` is not \`PRODUCTION_DB_HOST\`; prefer \`db:migrate\` |` (in the file, plain backticks — the backslashes here are only escaping).
- [ ] **Step 5: Pass + commit.** New smoke, `smoke-env`, `smoke-migration-guards`, `smoke-env-documented` pass; `npm run typecheck && npm run lint`. `git add src/lib/env.ts drizzle.config.ts .env.example README.md scripts/smoke-drizzle-guard.ts scripts/run-smoke.ts && git commit -m "Refuse drizzle-kit push without consent or against production" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 13: Runtime migration-lease wait capped at 20 s (B7d)

`withMigrationLock` waits `MIGRATION_LOCK_WAIT_MS` (3 min, `src/db/index.ts:2818`) then sweeps anyway. Taken from `getDb()` at runtime, that exceeds the 60 s page `maxDuration`, and the sweep-anyway races the builder the lease exists to serialise. `scripts/migrate.ts` keeps the long wait.

**Files**
- Modify: `src/db/index.ts` — lease constants (`:2816-2820`), `withMigrationLock` (`:2844-2918`), `SchemaReconcileResult` (`:2919-2925`), `reconcileSchema` (`:2941-2972`), `getDb` (`:2978`)
- Modify: `scripts/migrate.ts` (`:22`, `:48`), `scripts/smoke-migration-guards.ts` (after the steal test, `:122-125`)

**Interfaces**
- Produces: `BUILD_MIGRATION_LOCK_WAIT_MS = 180_000`, `RUNTIME_MIGRATION_LOCK_WAIT_MS = 20_000`; `type ReconcileOptions = { lockWaitMs?: number; onLockTimeout?: "sweep" | "skip" }`; `reconcileSchema(options?: ReconcileOptions)` (defaults = build behaviour); `SchemaReconcileResult.lockTimedOut?: boolean`. `getDb()` passes `{ lockWaitMs: RUNTIME_MIGRATION_LOCK_WAIT_MS, onLockTimeout: "skip" }`: on timeout it serves without sweeping (the holder is migrating).

- [ ] **Step 1: Failing test.** In `scripts/smoke-migration-guards.ts` change the import to `import { BUILD_MIGRATION_LOCK_WAIT_MS, RUNTIME_MIGRATION_LOCK_WAIT_MS, getDb, reconcileSchema } from "../src/db";`, add `import { readFileSync } from "node:fs";`, and append to `leaseChecks()`:

```ts
  // A runtime cold start meeting a builder's live lease must give up fast and not sweep.
  await db.execute(sql`INSERT INTO schema_migration_lock (id, holder, acquired_at, expires_at)
    VALUES (1, 'slow-builder', now(), now() + interval '5 minutes')
    ON CONFLICT (id) DO UPDATE SET holder = 'slow-builder', expires_at = now() + interval '5 minutes'`);
  await db.execute(sql`UPDATE schema_migrations SET version = 1 WHERE id = 1`);
  const rtStarted = Date.now();
  const rt = await reconcileSchema({ lockWaitMs: 1500, onLockTimeout: "skip" });
  const rtWaited = Date.now() - rtStarted;
  check("the runtime path gives up after its cap", rtWaited >= 1500 && rtWaited < 6000, `${rtWaited}ms`);
  check("and serves without sweeping", rt.applied === false && rt.lockTimedOut === true, JSON.stringify(rt));
  const version = (rowsOf(await db.execute(sql`SELECT version FROM schema_migrations WHERE id = 1`))[0] as { version: number }).version;
  check("leaving the version for the holder to record", Number(version) === 1, String(version));
  check("the runtime cap is at most 20 s and below the build wait",
    RUNTIME_MIGRATION_LOCK_WAIT_MS <= 20_000 && RUNTIME_MIGRATION_LOCK_WAIT_MS < BUILD_MIGRATION_LOCK_WAIT_MS);
  check("getDb() uses the runtime options",
    readFileSync("src/db/index.ts", "utf8").includes(
      'reconcileSchema({ lockWaitMs: RUNTIME_MIGRATION_LOCK_WAIT_MS, onLockTimeout: "skip" })'));
  await db.execute(sql`DELETE FROM schema_migration_lock WHERE holder = 'slow-builder'`);
  const restored = await reconcileSchema();
  check("after the holder is gone the next reconcile sweeps", restored.applied === true && restored.failed.length === 0);
```

- [ ] **Step 2: Run, expect failure.** `npx tsx scripts/smoke-migration-guards.ts` → `FAIL the runtime path gives up after its cap` (it waits the full 3 minutes, then sweeps) — kill it after ~10 s if you like; the constants import is also `undefined`.
- [ ] **Step 3: Constants.** Replace `const MIGRATION_LOCK_WAIT_MS = 3 * 60 * 1000;` (and its comment) with:

```ts
/** How long `scripts/migrate.ts` waits for another builder's lease before sweeping anyway. */
export const BUILD_MIGRATION_LOCK_WAIT_MS = 3 * 60 * 1000;
/**
 * How long a runtime cold start (`getDb()`) waits. Pages stop at 60 s, so the build wait
 * would kill the request; on timeout the runtime path does NOT sweep — the holder is
 * migrating, and racing it is what the lease prevents.
 */
export const RUNTIME_MIGRATION_LOCK_WAIT_MS = 20 * 1000;
```

- [ ] **Step 4: `withMigrationLock`.** Change its signature to `async function withMigrationLock<T>(run: StatementRunner, body: () => Promise<T>, options: { waitMs: number; onTimeout: () => Promise<T> }): Promise<T>`; change `const deadline = Date.now() + MIGRATION_LOCK_WAIT_MS;` to `const deadline = Date.now() + options.waitMs;`; replace the whole `if (!held) { console.warn(…); return body(); }` block with `if (!held) return options.onTimeout();`. In its doc comment replace the paragraph starting "Never fails the caller." with: "Never fails the caller. If the lease is not won within `options.waitMs`, `options.onTimeout` decides: the build sweeps anyway (the pre-lease behaviour), a runtime cold start serves without sweeping."
- [ ] **Step 5: `reconcileSchema` + `getDb`.** Add `/** True when a runtime caller gave up on another holder's lease and did not sweep. */ lockTimedOut?: boolean;` to `SchemaReconcileResult`. Replace `reconcileSchema` from its signature to its end with:

```ts
export type ReconcileOptions = {
  /** Default BUILD_MIGRATION_LOCK_WAIT_MS. */
  lockWaitMs?: number;
  /** When another holder keeps the lease past `lockWaitMs`: "sweep" (build, default) or "skip" (runtime). */
  onLockTimeout?: "sweep" | "skip";
};

export async function reconcileSchema(options: ReconcileOptions = {}): Promise<SchemaReconcileResult> {
  await ready();
  const neonSql = globalForDb.orbitNeonSql;
  const run: StatementRunner = neonSql
    ? (statement) => neonSql.query(statement)
    : (statement) => globalForDb.orbitPglite!.query(statement);

  if (await schemaIsCurrent(run)) {
    // pgvector/pg_trgm availability lives in module state, not in the database.
    await detectExtensions(run);
    return { version: SCHEMA_VERSION, applied: false, failed: [] };
  }

  const lockWaitMs = options.lockWaitMs ?? BUILD_MIGRATION_LOCK_WAIT_MS;
  const sweep = async (): Promise<SchemaReconcileResult> => {
    // Re-check inside the lock: the previous holder may have just finished this sweep.
    if (await schemaIsCurrent(run)) {
      await detectExtensions(run);
      return { version: SCHEMA_VERSION, applied: false, failed: [] };
    }
    const failed = neonSql ? await migrateNeon(neonSql) : await migratePglite(globalForDb.orbitPglite!);
    for (const f of failed) console.error(`[db] DDL statement failed: ${f.statement}\n`, f.message);
    if (failed.length === 0) await recordSchemaVersion(run);
    return { version: SCHEMA_VERSION, applied: true, failed };
  };

  return withMigrationLock(run, sweep, {
    waitMs: lockWaitMs,
    onTimeout: async () => {
      if ((options.onLockTimeout ?? "sweep") === "sweep") {
        console.warn(`[db] another builder has held the migration lease for ${lockWaitMs}ms; sweeping anyway`);
        return sweep();
      }
      console.warn(`[db] migration lease busy for ${lockWaitMs}ms; serving without sweeping while the holder migrates`);
      await detectExtensions(run);
      return { version: SCHEMA_VERSION, applied: false, failed: [], lockTimedOut: true };
    },
  });
}
```

(Keep the existing doc comment above it; if Phase 0 changed the body, keep its additions inside `sweep`.) In `getDb` change `schemaReconciled = reconcileSchema()` to `schemaReconciled = reconcileSchema({ lockWaitMs: RUNTIME_MIGRATION_LOCK_WAIT_MS, onLockTimeout: "skip" })`. In `scripts/migrate.ts` import `BUILD_MIGRATION_LOCK_WAIT_MS` and call `reconcileSchema({ lockWaitMs: BUILD_MIGRATION_LOCK_WAIT_MS, onLockTimeout: "sweep" })`.
- [ ] **Step 6: Pass + commit.** `smoke-migration-guards` (existing wait-then-sweep and steal checks still pass: they use the default build options), `smoke-schema-upgrade`, `smoke-schema-fingerprint` pass; `npm run typecheck && npm run lint`. `git add src/db/index.ts scripts/migrate.ts scripts/smoke-migration-guards.ts && git commit -m "Cap the runtime migration-lease wait at 20 s and never sweep past it" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 14: Connector sync — 4 at a time, 20 per run, a lag metric (B13)

`runSyncPass` claims `CONNECTIONS_PER_RUN = 5` (`src/lib/sync-scheduler.ts:62-63`) and syncs them serially (`:263-308`), so continuous sync saturates near ten calendars with no lag signal. No new dependency: a ten-line pool.

**Files**
- Modify: `src/lib/sync-scheduler.ts` — constants (`:62-63`), `SyncRunStats`/`emptyRunStats` (`:95-145`), the claimed-connection loop in `runSyncPass` (`:260-308`)
- Modify: `src/lib/provider-connections.ts` — append `oldestDueAgeMs` after `claimDueConnections` (`:98-131`)
- Modify: `src/app/api/sync/run/route.ts` — stats (`:43-52`)
- Create: `scripts/smoke-sync-concurrency.ts` (pglite); modify `scripts/run-smoke.ts`

**Interfaces**
- Consumes: `claimDueConnections`, `markSyncResult`, `disarmSync`, `PER_CONNECTION_BUDGET_MS`, `deadlineAfter/deadlineReached` (existing); `getValidAccessToken` from `@/lib/gmail` stays an import only (3a owns the file).
- Produces: `CONNECTIONS_PER_RUN = 20`; `SYNC_CONCURRENCY = 4`; `runSettledPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void>` (never rejects; a throwing worker never stops the pool); `oldestDueAgeMs(provider: SyncProvider, now?: Date): Promise<number | null>`; `SyncRunStats.oldestDueAgeMs: number | null` (measured before the claim); `cron_runs.stats.oldestDueAgeMs` for `sync.run`. A connection only STARTS while at least `PER_CONNECTION_BUDGET_MS` of the run budget remains, so four lanes cannot overrun `maxDuration`; later ones are released immediately due, as today.

- [ ] **Step 1: Failing test.** Create `scripts/smoke-sync-concurrency.ts`:

```ts
/**
 * Connector sync throughput: claimed connections run four at a time, a run claims twenty,
 * one failure never stops the pool, and the run reports how overdue the oldest connection was.
 *
 * Run: npx tsx scripts/smoke-sync-concurrency.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { oldestDueAgeMs } from "../src/lib/provider-connections";
import { CONNECTIONS_PER_RUN, SYNC_CONCURRENCY, runSettledPool, runSyncPass, type SyncDeps } from "../src/lib/sync-scheduler";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

async function seed(userId: string, dueMsAgo = 60_000) {
  const db = await getDb();
  await db.execute(sql`
    INSERT INTO gmail_connections
      (user_id, email_address, access_token_encrypted, status, scopes, next_sync_at, sync_failures)
    VALUES (${userId}, ${userId + "@example.com"}, 'enc', 'active', ${CALENDAR_SCOPE},
            ${new Date(Date.now() - dueMsAgo)}, 0)`);
}

/** This script is the scheduler's only tenant: foreign rows are disarmed, never deleted. */
async function clearAll() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id LIKE 'conc-%'`);
  await db.execute(sql`UPDATE gmail_connections SET next_sync_at = NULL WHERE user_id NOT LIKE 'conc-%'`);
}

function slowDeps(failFor = new Set<string>()): { deps: SyncDeps; maxInFlight: () => number } {
  let inFlight = 0;
  let max = 0;
  const deps: SyncDeps = {
    getAccessToken: async (userId: string) => `stub-token:${userId}`,
    fetchPage: async ({ accessToken }) => {
      const userId = String(accessToken).replace(/^stub-token:/, "");
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 150));
      inFlight--;
      if (failFor.has(userId)) throw new Error("Google Calendar 503: upstream unavailable");
      return { events: [], nextSyncToken: "fresh", nextPageToken: null, tombstones: 0, selfEmails: [] };
    },
  };
  return { deps, maxInFlight: () => max };
}

run(async () => {
  console.log("The pool...");
  let seen = 0;
  await runSettledPool([1, 2, 3, 4, 5], 2, async (n) => {
    seen++;
    if (n === 2) throw new Error("boom");
  });
  check("a throwing worker neither rejects the pool nor stops it", seen === 5, String(seen));

  console.log("\nConcurrency, isolation and lag...");
  await clearAll();
  for (let i = 0; i < 8; i++) await seed(`conc-${i}`, i === 0 ? 3 * 3_600_000 : 60_000);
  const { deps, maxInFlight } = slowDeps(new Set(["conc-3"]));
  const lagBefore = await oldestDueAgeMs("google", new Date());
  check("oldestDueAgeMs reads the most overdue armed connection", (lagBefore ?? 0) >= 3 * 3_600_000 - 60_000, String(lagBefore));
  const stats = await runSyncPass({ deps });
  check(`at most ${SYNC_CONCURRENCY} connections sync at once, and more than one does`,
    maxInFlight() === SYNC_CONCURRENCY, String(maxInFlight()));
  check("seven synced, the failing one counted, none dropped",
    stats.claimed === 8 && stats.synced === 7 && stats.failed === 1, JSON.stringify(stats));
  check("the run reports the lag it started with", (stats.oldestDueAgeMs ?? 0) >= 3 * 3_600_000 - 60_000, String(stats.oldestDueAgeMs));
  check("nothing is due once they are synced", (await oldestDueAgeMs("google", new Date())) === null);

  console.log("\nClaim size...");
  await clearAll();
  for (let i = 0; i < CONNECTIONS_PER_RUN + 2; i++) await seed(`conc-claim-${i}`);
  const big = await runSyncPass({ deps: slowDeps().deps });
  check(`a run claims ${CONNECTIONS_PER_RUN}`, CONNECTIONS_PER_RUN === 20 && big.claimed === 20, JSON.stringify(big));
  const db = await getDb();
  const left = rowsOf<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM gmail_connections
     WHERE user_id LIKE 'conc-claim-%' AND next_sync_at <= now() AND sync_status IS DISTINCT FROM 'syncing'`))[0]?.n;
  check("the rest stay due for the next run", left === 2, String(left));

  await clearAll();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll sync-concurrency checks passed.");
});
```

Add `"smoke-sync-concurrency": "pglite",` to `MANIFEST`.
- [ ] **Step 2: Run, expect failure.** → `TypeError: runSettledPool is not a function` (and `oldestDueAgeMs` is undefined).
- [ ] **Step 3: Lag query.** Append to `src/lib/provider-connections.ts`:

```ts
/**
 * How long the most overdue armed connection has waited past its `next_sync_at`, in ms, or
 * null when nothing is due. The scheduler's lag metric; the ops sweep alerts on it.
 */
export async function oldestDueAgeMs(provider: SyncProvider, now: Date = new Date()): Promise<number | null> {
  const db = await getDb();
  const table = sql.raw(PROVIDER_TABLES[provider]);
  const result = await db.execute(sql`
    SELECT min(next_sync_at) AS oldest FROM ${table}
     WHERE status = 'active' AND next_sync_at IS NOT NULL AND next_sync_at <= ${now}
  `);
  const oldest = rowsOf<{ oldest: string | Date | null }>(result)[0]?.oldest ?? null;
  return oldest ? Math.max(0, now.getTime() - new Date(oldest).getTime()) : null;
}
```

- [ ] **Step 4: Scheduler.** In `src/lib/sync-scheduler.ts`: add `oldestDueAgeMs` to the `@/lib/provider-connections` import. Replace `/** Claimed per run. Small because each one can take up to a minute. */ export const CONNECTIONS_PER_RUN = 5;` with:

```ts
/** Claimed per run. Four run at once, each bounded by PER_CONNECTION_BUDGET_MS. */
export const CONNECTIONS_PER_RUN = 20;

/** Connections synced in parallel. Each is a different user's calendar and ingest context. */
export const SYNC_CONCURRENCY = 4;

/**
 * Runs `worker` over `items` with at most `limit` in flight, settling every item — the
 * Promise.allSettled guarantee without starting all twenty at once. Never rejects.
 */
export async function runSettledPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item).catch(() => undefined);
    }
  });
  await Promise.allSettled(lanes);
}
```

Add `/** How overdue the oldest due connection was when the run started; null when none. */ oldestDueAgeMs: number | null;` to `SyncRunStats` and `oldestDueAgeMs: null,` to `emptyRunStats()`. In `runSyncPass` replace from `const claimed = await claimDueConnections("google", CONNECTIONS_PER_RUN, now);` through the closing `}` of the `for (const conn of claimed)` loop with:

```ts
  // Measured before claiming: after the claim, the rows it took are no longer "due".
  stats.oldestDueAgeMs = await oldestDueAgeMs("google", now).catch(() => null);
  const claimed = await claimDueConnections("google", CONNECTIONS_PER_RUN, now);
  stats.claimed = claimed.length;

  // A connection may START only while a full per-connection budget remains, so four lanes
  // cannot carry the run past the function ceiling. Checked before each item, never after.
  const startCutoff = deadline - PER_CONNECTION_BUDGET_MS;

  await runSettledPool(claimed, SYNC_CONCURRENCY, async (conn) => {
    if (deadlineReached(startCutoff)) {
      stats.budgetExhausted = true;
      // Released immediately due, so the next run (or the continuation kick) picks it up.
      await markSyncResult(conn.provider, conn.id, { ok: true, cursor: conn.syncCursor, nextSyncAt: now }).catch(() => null);
      return;
    }
    // A token minted before the calendar scope shipped still works for Gmail and Contacts but
    // every Calendar call 403s. Only the user reconnecting can fix it, so disarm.
    if (!hasCalendarScope(conn.scopes)) {
      stats.skippedNoScope++;
      await disarmSync(conn.provider, conn.id, "Calendar access not granted — reconnect Google to enable calendar sync", now).catch(() => null);
      return;
    }
    try {
      await syncGoogleCalendar(conn, stats, now, deps);
      stats.synced++;
    } catch (err) {
      stats.failed++;
      // A dead grant is permanent until the user reconnects; anything else is worth retrying.
      const retryable = !(err instanceof ReauthRequiredError);
      await markSyncResult(conn.provider, conn.id, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        retryable,
      }).catch(() => null);
    }
  });
```

(`stats` counters are mutated only between awaits, so lanes cannot lose an increment.) In `src/app/api/sync/run/route.ts` add `oldestDueAgeMs: stats.oldestDueAgeMs ?? 0,` to the `stats` object passed to `finishCronRun` (the ledger's values are `number | boolean`; 0 means nothing was due).
- [ ] **Step 5: Pass + commit.** New smoke and `npx tsx scripts/smoke-sync-scheduler.ts` (its `budgetMs: -1` case still releases everything) pass; `npm run typecheck && npm run lint`. `git add src/lib/sync-scheduler.ts src/lib/provider-connections.ts src/app/api/sync/run/route.ts scripts/smoke-sync-concurrency.ts scripts/run-smoke.ts && git commit -m "Sync four connections at a time, twenty per run, and record the lag" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 15: `sync.lagging` (B13)

**Files**
- Modify: `src/lib/ops-alerts.ts` (after the sync `if/else if` chain, `:162-182`), `src/lib/ops-sweep.ts`
- Modify: `scripts/smoke-ops-alerts.ts`, `scripts/smoke-ops-snapshot.ts`, `scripts/smoke-ops-sweep.ts`, `docs/RUNBOOK.md`

**Interfaces**
- Consumes: `oldestDueAgeMs("google", now)` from Task 14.
- Produces: `OpsSnapshot.syncOldestDueAgeMs: number | null`; `export const SYNC_LAG_ALERT_MS = 2 * 60 * 60 * 1000;`; condition `sync.lagging` (warning) when older than that while the schedule itself is alive (a dead schedule is `sync.schedule_missed`, which already fires).

- [ ] **Step 1: Failing tests.** `scripts/smoke-ops-alerts.ts`: `HEALTHY` gains `syncOldestDueAgeMs: null,`; add:

```ts
  check("a connection overdue by 3h while sync runs → sync.lagging (warning)",
    find({ ...HEALTHY, syncOldestDueAgeMs: 3 * 3_600_000 }, "sync.lagging")?.severity === "warning");
  check("an hour overdue is just the schedule's lag", !find({ ...HEALTHY, syncOldestDueAgeMs: 3_600_000 }, "sync.lagging"));
  check("a dead schedule says sync.schedule_missed, not also sync.lagging",
    !find({ ...HEALTHY, syncOldestDueAgeMs: 5 * 3_600_000, cron: { ...HEALTHY.cron, syncRun: { lastStartedAt: hoursAgo(4), lastState: "ok" } } }, "sync.lagging"));
```

`scripts/smoke-ops-snapshot.ts` — import `sql` from drizzle-orm (merge) and, above the marker:

```ts
  console.log("\nSync lag...");
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = 'snap-lag'`);
  await db.execute(sql`INSERT INTO gmail_connections
    (user_id, email_address, access_token_encrypted, status, scopes, next_sync_at, sync_failures)
    VALUES ('snap-lag', 'snap-lag@example.com', 'enc', 'active', 'https://www.googleapis.com/auth/calendar.readonly',
            ${new Date(Date.now() - 3 * 3_600_000)}, 0)`);
  await cronRun("sync.run", "ok", 5);
  const lag = (await loadOpsSnapshot(new Date(), null)).syncOldestDueAgeMs;
  check("the snapshot reads the oldest due connection", (lag ?? 0) >= 3 * 3_600_000 - 60_000, String(lag));
  check("which opens sync.lagging", (await idsNow()).includes("sync.lagging"));
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = 'snap-lag'`);
  await db.delete(cronRuns).where(inArray(cronRuns.job, [...JOBS]));
```

- [ ] **Step 2: Run, expect failure.** ops-alerts → `FAIL a connection overdue by 3h …`; ops-snapshot → `FAIL the snapshot reads the oldest due connection` (`undefined`).
- [ ] **Step 3: Catalogue.** `OpsSnapshot` add `/** How long the most overdue armed connection has waited; null when none is due. */ syncOldestDueAgeMs: number | null;`. Export the constant below `SYNC_SCHEDULE_SILENT_MS`. Directly after the sync chain's closing `}` add:

```ts
  // More connections due than one run can take. Only while the schedule itself is alive —
  // a dead schedule makes every connection overdue and is already sync.schedule_missed.
  if (
    syncSilentFor !== null &&
    syncSilentFor <= SYNC_SCHEDULE_SILENT_MS &&
    (s.syncOldestDueAgeMs ?? 0) > SYNC_LAG_ALERT_MS
  ) {
    out.push({
      id: "sync.lagging",
      severity: "warning",
      title: "Connector sync is falling behind",
      detail: `The most overdue connection has waited ${((s.syncOldestDueAgeMs ?? 0) / 3_600_000).toFixed(1)} h — more accounts are due than a run can sync.`,
      href: "/admin/health",
    });
  }
```

- [ ] **Step 4: Loader.** In `src/lib/ops-sweep.ts` add `import { oldestDueAgeMs } from "@/lib/provider-connections";`; beside the Task 5 `statementTimeout` line add `const syncOldestDueAgeMs = await oldestDueAgeMs("google", now).catch(() => null);` and return `syncOldestDueAgeMs,`.
- [ ] **Step 5: Sweep isolation + runbook.** `scripts/smoke-ops-sweep.ts` `reset()`: ``await db.execute(sql`UPDATE gmail_connections SET next_sync_at = NULL WHERE next_sync_at < now() - interval '1 hour'`);``. Runbook row:

```md
| `sync.lagging` | More connections are due than a run syncs (20 per run, 4 at a time). `sync.run` stats: `budgetExhausted` true on every run means the budget is the limit — raise `CONNECTIONS_PER_RUN` in `src/lib/sync-scheduler.ts` or schedule more often (Vercel Pro crons); many `failed` means a provider problem. |
```

- [ ] **Step 6: Pass + commit.** Ops smokes pass; `npm run typecheck && npm run lint`. `git add src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts scripts/smoke-ops-snapshot.ts scripts/smoke-ops-sweep.ts docs/RUNBOOK.md && git commit -m "Alert when connector sync falls two hours behind" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 16: `/admin` reuses its aggregates for ten minutes (B13)

`loadAdminUserRows` (`src/lib/admin-metrics.ts:174-265`) runs five whole-table `GROUP BY user_id` scans plus the `user_settings` read on every `/admin` load, and `OverviewLiveProvider` re-polls `/api/admin/overview/live` every 30 s (`src/components/admin/overview-live.tsx:29`) — ten whole-table scans a minute per open tab, on the compute users share.

**Decision.** Neither literal option. *Bounding to 90 days* changes what the numbers mean: `counts.*` feed the all-time totals, the funnel ("First contact", "10+ contacts") and `firstContactAt` (the activation clock), so they would be wrong. *A nightly table* is a new user-keyed table and a `SCHEMA_VERSION` bump in a phase whose schema budget is the fingerprint column, it would still need live deltas to show today's signups, and it would have to join the purge registry (`scripts/smoke-purge.ts` requires every `user_id` table to empty). The smaller change that keeps every number's meaning: memoise the five aggregate scans in process for ten minutes for the overview only, while `user_settings` (signups, plans, suspensions) stays live. Counts are at most ten minutes old; `loadAdminUserRows()` itself stays live by default, so billing pages, the roster and every existing smoke are unchanged. No UI change.

**Files**
- Modify: `src/lib/admin-metrics.ts` — `loadAdminUserRows` (`:174-265`), `getAdminOverview` (`:556-589`)
- Create: `scripts/smoke-admin-aggregates.ts` (pglite); modify `scripts/run-smoke.ts`

**Interfaces**
- Produces: `ADMIN_AGGREGATES_TTL_MS = 10 * 60 * 1000`; `loadAdminUserRows(options?: { aggregatesMaxAgeMs?: number })` (default 0 = live); `getAdminOverview(now?: Date, options?: { aggregatesMaxAgeMs?: number })` (default `ADMIN_AGGREGATES_TTL_MS`). Callers `admin/page.tsx` and `api/admin/overview/live/route.ts` need no change.

- [ ] **Step 1: Failing test.** Create `scripts/smoke-admin-aggregates.ts`:

```ts
/**
 * The /admin overview reuses its five whole-table aggregates for ten minutes; the account
 * list itself (user_settings) is always live, and loadAdminUserRows() stays live by default.
 *
 * Run: npx tsx scripts/smoke-admin-aggregates.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, userSettings } from "../src/db/schema";
import { ADMIN_AGGREGATES_TTL_MS, getAdminOverview, loadAdminUserRows, type AdminUserRow } from "../src/lib/admin-metrics";
import { startQueryCount, stopQueryCount } from "../src/lib/query-counter";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "smoke-admin-agg-user";
const LATE = "smoke-admin-agg-late";
const contactsOf = (rows: AdminUserRow[], id: string) => rows.find((r) => r.userId === id)?.counts.contacts;

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, [USER, LATE]));
  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, LATE]));
  await db.insert(userSettings).values({ userId: USER, email: `${USER}@example.test` });
  await db.insert(contacts).values([{ userId: USER, fullName: "One" }, { userId: USER, fullName: "Two" }]);

  const primed = await getAdminOverview(new Date(), { aggregatesMaxAgeMs: 0 });
  check("a fresh overview counts both contacts", contactsOf(primed.rows, USER) === 2);

  await db.insert(contacts).values({ userId: USER, fullName: "Three" });
  await db.insert(userSettings).values({ userId: LATE, email: `${LATE}@example.test` });

  startQueryCount();
  const memo = await getAdminOverview();
  const statements = stopQueryCount();
  check("the default overview reuses the aggregates inside the TTL", contactsOf(memo.rows, USER) === 2, String(contactsOf(memo.rows, USER)));
  check("and costs one statement (user_settings), not six", statements === 1, String(statements));
  check("an account created since is listed at once, with zero counts", contactsOf(memo.rows, LATE) === 0);
  check("the TTL is ten minutes", ADMIN_AGGREGATES_TTL_MS === 10 * 60 * 1000);

  check("loadAdminUserRows() stays live by default", contactsOf(await loadAdminUserRows(), USER) === 3);
  check("an overview asked for fresh numbers reads live",
    contactsOf((await getAdminOverview(new Date(), { aggregatesMaxAgeMs: 0 })).rows, USER) === 3);

  await db.delete(contacts).where(inArray(contacts.userId, [USER, LATE]));
  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, LATE]));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll admin-aggregate checks passed.");
});
```

Add `"smoke-admin-aggregates": "pglite",` to `MANIFEST`.
- [ ] **Step 2: Run, expect failure.** → `FAIL the default overview reuses the aggregates …` (3), `FAIL and costs one statement … (6)`, `FAIL the TTL is ten minutes`.
- [ ] **Step 3: Implement.** In `src/lib/admin-metrics.ts`, above `loadAdminUserRows`, add a function holding the five aggregate queries moved verbatim from the current `Promise.all` (everything after the `user_settings` select):

```ts
/** The five whole-table GROUP BY user_id scans — the expensive half of the rollup. */
async function queryAggregates() {
  const db = await getDb();
  const [contactAgg, interactionAgg, importAgg, chatAgg, usageAgg] = await Promise.all([
    /* the contacts, interactions, imports, chat_messages and usage_events selects, unchanged */
  ]);
  return { contactAgg, interactionAgg, importAgg, chatAgg, usageAgg };
}

/**
 * How long the /admin overview reuses one set of aggregates. The overview re-polls every
 * 30 s; live, that is ten whole-table scans a minute per open tab on compute users share.
 * Counts may lag by up to this long; user_settings — signups, plans, suspensions — never does.
 */
export const ADMIN_AGGREGATES_TTL_MS = 10 * 60 * 1000;

let aggregateMemo: { at: number; value: ReturnType<typeof queryAggregates> } | null = null;

function aggregatesWithin(maxAgeMs: number): ReturnType<typeof queryAggregates> {
  const now = Date.now();
  if (maxAgeMs > 0 && aggregateMemo && now - aggregateMemo.at <= maxAgeMs) return aggregateMemo.value;
  const value = queryAggregates();
  aggregateMemo = { at: now, value };
  // A failed read must not be served for ten minutes.
  value.catch(() => {
    if (aggregateMemo?.value === value) aggregateMemo = null;
  });
  return value;
}
```

(The comment inside `Promise.all([...])` stands for the five `db.select(...)...groupBy(...)` expressions cut from the current code — move them, do not rewrite them.) Then change `loadAdminUserRows` to:

```ts
export async function loadAdminUserRows(
  options: { aggregatesMaxAgeMs?: number } = {}
): Promise<AdminUserRow[]> {
  const db = await getDb();

  const [settingsRows, { contactAgg, interactionAgg, importAgg, chatAgg, usageAgg }] = await Promise.all([
    /* the existing user_settings select, unchanged */,
    aggregatesWithin(options.aggregatesMaxAgeMs ?? 0),
  ]);
```

keeping the rest of its body as is. Change `getAdminOverview`'s head to

```ts
export async function getAdminOverview(
  now = new Date(),
  options: { aggregatesMaxAgeMs?: number } = {}
): Promise<AdminOverview> {
  const rows = await loadAdminUserRows({ aggregatesMaxAgeMs: options.aggregatesMaxAgeMs ?? ADMIN_AGGREGATES_TTL_MS });
```

and add one sentence to the module doc comment: "The overview reuses the five aggregate scans for `ADMIN_AGGREGATES_TTL_MS`; everything else reads live."
- [ ] **Step 4: Pass + commit.** New smoke plus `smoke-admin`, `smoke-admin-roster`, `smoke-instrumentation`, `smoke-admin-render` pass; `npm run typecheck && npm run lint`. `git add src/lib/admin-metrics.ts scripts/smoke-admin-aggregates.ts scripts/run-smoke.ts && git commit -m "Reuse the admin overview's whole-table aggregates for ten minutes" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 17: `internalFetch` times out after 10 s (B13 scheduler resilience)

`internalFetch` (`src/lib/internal-auth.ts:51-55`) has no timeout, so a hung self-kick holds the kicking invocation until its own `maxDuration`. Every callee answers as soon as it has queued work in `after()` — except `/api/sync/run`, which runs inline; its self-kick is already best-effort by design ("if it is lost, the next scheduled run picks the connections up", `src/app/api/sync/run/route.ts:30-32`).

**Files**
- Modify: `src/lib/internal-auth.ts` (`:45-55`), `scripts/smoke-internal-auth.ts` (after the `internalFetch targets …` check, `:81`)

**Interfaces**
- Produces: `INTERNAL_FETCH_TIMEOUT_MS = 10_000`; `internalFetch(path, init)` passes `signal: init.signal ?? AbortSignal.timeout(INTERNAL_FETCH_TIMEOUT_MS)` (a caller's own signal wins).

- [ ] **Step 1: Failing test.** Change the import to `import { INTERNAL_FETCH_TIMEOUT_MS, internalAuthHeaders, internalFetch, isInternalRequest } from "../src/lib/internal-auth";` and add after the `internalFetch targets the app base URL with the bearer` check:

```ts
  let seenSignal: AbortSignal | null | undefined;
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenSignal = init?.signal;
    return new Response("{}");
  }) as typeof fetch;
  const own = new AbortController();
  let ownSeen: AbortSignal | null | undefined;
  try {
    await internalFetch("/api/embeddings/backfill", { method: "POST" });
    const defaulted = seenSignal;
    await internalFetch("/api/embeddings/backfill", { method: "POST", signal: own.signal });
    ownSeen = seenSignal;
    check("internalFetch always carries an abort signal", defaulted instanceof AbortSignal && !defaulted.aborted);
  } finally {
    globalThis.fetch = realFetch2;
  }
  check("a caller's own signal wins", ownSeen === own.signal);
  check("the default timeout is ten seconds", INTERNAL_FETCH_TIMEOUT_MS === 10_000);
```

- [ ] **Step 2: Run, expect failure.** `npx tsx scripts/smoke-internal-auth.ts` → throws `internalFetch always carries an abort signal FAILED`.
- [ ] **Step 3: Implement.** Replace `internalFetch` and its doc comment with:

```ts
/**
 * How long a self-kick may take. Every internal route answers as soon as it has queued its
 * work in `after()`, so ten seconds is generous — except `/api/sync/run`, which runs inline;
 * its continuation kick is best-effort by design (a lost one is picked up by the next run).
 */
export const INTERNAL_FETCH_TIMEOUT_MS = 10_000;

/**
 * `fetch` against this app's own internal routes, with the bearer attached and a timeout.
 *
 * Targets `getAppBaseUrl()` rather than the per-deployment `VERCEL_URL` so a preview build
 * does not kick a job on itself and then vanish; in production that is `APP_BASE_URL`.
 * Without the timeout, one hung kick held the kicking invocation to its own maxDuration.
 */
export function internalFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(internalAuthHeaders())) headers.set(k, v);
  return fetch(`${getAppBaseUrl()}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(INTERNAL_FETCH_TIMEOUT_MS),
  });
}
```

- [ ] **Step 4: Pass + commit.** `npx tsx scripts/smoke-internal-auth.ts`; `npm run typecheck && npm run lint`. `git add src/lib/internal-auth.ts scripts/smoke-internal-auth.ts && git commit -m "Time out internal self-kicks after ten seconds" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 18: One schedule for process-stalled; the GitHub 60-day runbook (B13, B8)

process-stalled runs hourly from GitHub (`.github/workflows/ops.yml:23,85-93`) **and** daily from Vercel (`vercel.json:4-9`), while its own doc says "Runs once/day" (`src/app/api/imports/process-stalled/route.ts:92-101`).

**Decision: hourly, from GitHub; the Vercel cron is removed.** Hourly is what bounds a lost import or capture continuation to an hour (the reason the prior plan added it), and Phase 2's purge re-runs ride this job. Keeping Vercel's daily run as a backstop protects nothing the heartbeat does not already cover: if GitHub's schedules die (the 60-day rule), the sweep, drain and sync die with them and Better Stack pages within 30 minutes; the fix is the runbook below. When decision D1 (Vercel Pro) lands, move all four schedules into `vercel.json` and delete them from `ops.yml` in one change.

**Files**
- Modify: `vercel.json`, `.github/workflows/ops.yml` (header comment `:1-17`), `src/app/api/imports/process-stalled/route.ts` (doc `:92-101`), `src/app/api/webhooks/outbound/drain/route.ts` (`:9-10`), `src/app/api/sync/run/route.ts` (`:4-7`), `docs/RUNBOOK.md` (`:27-34` and a new section)
- Create: `scripts/smoke-schedules.ts` (pure); modify `scripts/run-smoke.ts`

**Interfaces**
- Produces: a pure guard that `vercel.json` schedules nothing, `ops.yml` runs process-stalled from exactly one step on the hourly cron, the route doc no longer says once a day, and the runbook carries the re-enable commands.

- [ ] **Step 1: Failing test.** Create `scripts/smoke-schedules.ts`:

```ts
/**
 * One scheduler per job. process-stalled ran hourly from GitHub AND daily from Vercel while
 * its own comment said daily. GitHub Actions is the one scheduler until Vercel Pro crons.
 *
 * Pure: reads files. Run: npx tsx scripts/smoke-schedules.ts
 */
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: unknown[] };
const ops = readFileSync(".github/workflows/ops.yml", "utf8");
const route = readFileSync("src/app/api/imports/process-stalled/route.ts", "utf8");
const runbook = readFileSync("docs/RUNBOOK.md", "utf8");

check("vercel.json schedules nothing", !vercel.crons || vercel.crons.length === 0, JSON.stringify(vercel.crons));
check("ops.yml keeps the hourly schedule", ops.includes(`- cron: "7 * * * *"`));
check("process-stalled is called from exactly one step",
  (ops.match(/\/api\/imports\/process-stalled/g) ?? []).length === 1);
check("that step is gated on the hourly schedule",
  /if: github\.event\.schedule == '7 \* \* \* \*'[\s\S]{0,400}\/api\/imports\/process-stalled/.test(ops));
check("the route no longer says it runs once a day", !/once\/day|Runs once/i.test(route));
check("the runbook carries the 60-day re-enable steps",
  runbook.includes("gh workflow enable ops.yml") && runbook.includes("disabled_inactivity"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll schedule checks passed.");
```

Add `"smoke-schedules": "pure",` to `MANIFEST`.
- [ ] **Step 2: Run, expect failure.** → `FAIL vercel.json schedules nothing`, `FAIL the route no longer says …`, `FAIL the runbook carries …`.
- [ ] **Step 3: Schedules and comments.** `vercel.json` becomes:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "npm run check:env && npm run db:migrate && next build"
}
```

`ops.yml` header, replace the first paragraph (lines 1-5) with:

```yaml
# The scheduler for everything Orbit runs on a clock — the only one. Vercel Hobby crons are
# daily at best, so this drives the ops sweep (every ten minutes), process-stalled (hourly,
# so a lost import continuation stalls for an hour, not a day), the webhook drain and
# connector sync. vercel.json schedules nothing; when Vercel Pro lands, move all four there
# and delete them here in one change.
```

and change the caveat sentence ending "If the heartbeat goes quiet, look here first." to "If the heartbeat goes quiet, follow docs/RUNBOOK.md → Scheduled workflows were disabled." process-stalled route, replace the doc comment above `export async function GET` with:

```ts
/**
 * The hourly backstop, scheduled by `.github/workflows/ops.yml` (the only scheduler):
 * resumes server-owned import and capture jobs whose invocation died mid-run. The primary
 * resumption path is still each job's own self-continuation; this is the last resort.
 *
 * Housekeeping rides along and every run is recorded in `cron_runs`. A job that loses
 * self-continuation can sit stalled for up to an hour.
 */
```

Drain route: `Driven by the existing ten-minute GitHub Actions schedule. Vercel Hobby's single cron slot belongs to \`/api/imports/process-stalled\`.` → `Driven by the ten-minute GitHub Actions schedule in .github/workflows/ops.yml, the only scheduler.` Sync route: replace `Driven by GitHub Actions rather than Vercel Cron: Hobby allows one cron and it belongs to \`/api/imports/process-stalled\`, so \`.github/workflows/ops.yml\` is already the real scheduler for everything else.` with `Driven by GitHub Actions (.github/workflows/ops.yml), the only scheduler.` (backslashes here only escape the plan's markdown).
- [ ] **Step 4: Runbook.** Replace the "The nightly job or the sweep stopped" section with:

````md
## The nightly job or the sweep stopped

1. `/admin/health` → "Ops sweep" tile. Quiet for over 30 min means the GitHub schedule is not
   firing — see "Scheduled workflows were disabled" below.
2. "Nightly job" tile red (it runs hourly, from `ops.yml` only): trigger it by hand —
   `curl -H "Authorization: Bearer $CRON_SECRET" https://orbit.jasonpereira.live/api/imports/process-stalled`
   A 401 means `CRON_SECRET` differs between Vercel and GitHub.

## Scheduled workflows were disabled (GitHub's 60-day rule)

GitHub disables a public repository's scheduled workflows after 60 days without repository
activity. That stops `ops` (sweep, process-stalled, drain, connector sync) and `backup` at once;
the Better Stack heartbeat goes quiet within 30 minutes.

```bash
gh api repos/jasonpereira518/orbit/actions/workflows --jq '.workflows[] | [.name, .state] | @tsv'
# a disabled one reads "disabled_inactivity"
gh workflow enable ops.yml --repo jasonpereira518/orbit
gh workflow enable backup.yml --repo jasonpereira518/orbit
gh workflow run ops.yml --repo jasonpereira518/orbit
gh workflow run backup.yml --repo jasonpereira518/orbit
```

Or GitHub → Actions → the workflow → **Enable workflow**, then **Run workflow**. Any push to
`main` resets the timer; a recurring calendar reminder every 45 days runs the `gh api` line
above. Vercel Pro crons remove the rule entirely.
````

- [ ] **Step 5: Pass + commit.** `npx tsx scripts/smoke-schedules.ts`, `npx tsx scripts/smoke-env-documented.ts` (runbook `npm run` references) pass; `npm run typecheck && npm run lint`. `git add vercel.json .github/workflows/ops.yml src/app/api/imports/process-stalled/route.ts src/app/api/webhooks/outbound/drain/route.ts src/app/api/sync/run/route.ts docs/RUNBOOK.md scripts/smoke-schedules.ts scripts/run-smoke.ts && git commit -m "Run process-stalled hourly from one scheduler; document GitHub's 60-day rule" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 19: `/api/health?token=<wrong>` answers 401 (C6)

`GET /api/health` computes `deep: isHealthTokenValid(request)` (`src/app/api/health/route.ts:12-21`, `src/lib/internal-auth.ts:61-70`), so a mistyped monitor token silently gets the shallow 200 and looks healthy. Only a present `token` query parameter changes behaviour: no parameter keeps the shallow view, and a bearer header keeps today's semantics (valid → deep, anything else → shallow).

**Files**
- Modify: `src/lib/internal-auth.ts` (append after `isHealthTokenValid`), `src/app/api/health/route.ts`, `docs/RUNBOOK.md` ("Deep probe" row, `:13`)
- Create: `scripts/smoke-health-token.ts` (pglite — the route reaches `@/db`); modify `scripts/run-smoke.ts`

**Interfaces**
- Produces: `type HealthTokenState = "absent" | "valid" | "invalid"`; `healthTokenState(request: Request): HealthTokenState` — `"invalid"` exactly when `?token=` is present and does not match `HEALTH_TOKEN` (including when `HEALTH_TOKEN` is unset: a monitor configured with a token against a deployment that lost it must go red). The route answers `401 { error: "invalid token" }` for `"invalid"`.

- [ ] **Step 1: Failing test.** Create `scripts/smoke-health-token.ts`. Read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` first.

```ts
/**
 * A wrong `?token=` on /api/health is a 401, not a shallow 200 that looks healthy.
 *
 * Run: npx tsx scripts/smoke-health-token.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { GET } from "../src/app/api/health/route";
import { healthTokenState } from "../src/lib/internal-auth";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const TOKEN = "smoke-health-token-value-0123456789";
const req = (qs = "", authorization?: string) =>
  new Request(`http://localhost/api/health${qs}`, { headers: authorization ? { authorization } : {} });

run(async () => {
  process.env.HEALTH_TOKEN = TOKEN;
  console.log("healthTokenState...");
  check("no token → absent", healthTokenState(req()) === "absent");
  check("right ?token → valid", healthTokenState(req(`?token=${TOKEN}`)) === "valid");
  check("wrong ?token → invalid", healthTokenState(req("?token=wrong")) === "invalid");
  check("empty ?token= → invalid", healthTokenState(req("?token=")) === "invalid");
  check("right bearer, no param → valid", healthTokenState(req("", `Bearer ${TOKEN}`)) === "valid");
  check("wrong bearer, no param → absent (unchanged)", healthTokenState(req("", "Bearer nope")) === "absent");

  console.log("\nThe route...");
  const wrong = await GET(req("?token=wrong"));
  const wrongBody = (await wrong.json()) as Record<string, unknown>;
  check("wrong token → 401", wrong.status === 401, String(wrong.status));
  check("the 401 says nothing about the system", !("schema" in wrongBody) && !("db" in wrongBody), JSON.stringify(wrongBody));
  const shallow = await GET(req());
  const shallowBody = (await shallow.json()) as Record<string, unknown>;
  check("no token → shallow 200", shallow.status === 200 && !("config" in shallowBody), JSON.stringify(shallowBody));
  const deep = await GET(req(`?token=${TOKEN}`));
  check("right token → the deep view", deep.status === 200 && "config" in ((await deep.json()) as Record<string, unknown>));

  delete process.env.HEALTH_TOKEN;
  check("a token presented while HEALTH_TOKEN is unset → 401", (await GET(req("?token=anything"))).status === 401);
  check("no token while unset → shallow 200", (await GET(req())).status === 200);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll health-token checks passed.");
});
```

Add `"smoke-health-token": "pglite",` to `MANIFEST`.
- [ ] **Step 2: Run, expect failure.** → `TypeError: healthTokenState is not a function`.
- [ ] **Step 3: Implement.** Append to `src/lib/internal-auth.ts`:

```ts
export type HealthTokenState = "absent" | "valid" | "invalid";

/**
 * What the caller of /api/health presented. A `?token=` that does not match is `invalid`
 * — a 401, so a mistyped monitor token goes red instead of reading as a healthy shallow 200.
 * With no parameter a valid bearer still opens the deep view; anything else is `absent`.
 */
export function healthTokenState(request: Request): HealthTokenState {
  if (isHealthTokenValid(request)) return "valid";
  return new URL(request.url).searchParams.has("token") ? "invalid" : "absent";
}
```

Replace the body of `GET` in `src/app/api/health/route.ts` (and its import) with:

```ts
import { NextResponse } from "next/server";
import { checkHealth } from "@/lib/health";
import { healthTokenState } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

/**
 * Liveness for the uptime monitor (shallow) and a diagnostic view for operators (deep,
 * with `?token=HEALTH_TOKEN` or a bearer). A wrong `?token=` is a 401. See
 * `src/lib/health.ts` for what each view says.
 */
export async function GET(request: Request) {
  const token = healthTokenState(request);
  if (token === "invalid") {
    return NextResponse.json({ error: "invalid token" }, { status: 401, headers: HEADERS });
  }
  const report = await checkHealth({ deep: token === "valid" });
  return NextResponse.json(report, { status: report.httpStatus, headers: HEADERS });
}
```

(If Phase 0 changed this route, keep its changes and add only the `token === "invalid"` branch.) Runbook "Deep probe" row becomes: `| Deep probe | \`GET /api/health?token=$HEALTH_TOKEN\` — a wrong token answers 401 |`.
- [ ] **Step 4: Pass + commit.** New smoke, `smoke-health`, `smoke-internal-auth`, `smoke-public-routes` pass; `npm run typecheck && npm run lint`. `git add src/lib/internal-auth.ts src/app/api/health/route.ts docs/RUNBOOK.md scripts/smoke-health-token.ts scripts/run-smoke.ts && git commit -m "Answer 401 to a wrong health token instead of a shallow 200" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 20: Playwright harness, Gemini stub, CI job, and the onboarding flow (B13)

The suite drives `next dev` in demo mode (no Clerk keys → every request is `demo-user`, `src/lib/auth.ts:81-85`), on a throwaway PGlite, with `ORBIT_DEMO_DATA=off` so the account starts empty. It runs in CI on every PR, not against Vercel previews: previews run Clerk, and demo mode exists only under `next dev` (`src/lib/demo-account.ts:17-24`).

**AI seam — no app code changes.** The capture parse runs server-side in `after()` (`src/actions/capture-jobs.ts:97-152` → `runCaptureParse` → `completeJson`), so `page.route` cannot fake it. Instead of an `ORBIT_AI_FIXTURES` flag in `src/lib/ai.ts` (3a's file), the dev server gets `GEMINI_API_KEY=e2e-stub-key` (env keys are honoured only when `VERCEL` is unset, `ai.ts:265-274`) and `GOOGLE_GEMINI_BASE_URL` pointing at a 60-line local stub: `ai.ts` builds `new GoogleGenAI({ apiKey })` with no `httpOptions.baseUrl` (`:605`), and `@google/genai` 2.12.0 then reads that variable (`node_modules/@google/genai/dist/node/index.cjs:25798`). This exercises the real provider client and touches nothing 3a owns. **Coordination note for 3a:** keep constructing the Gemini client without `httpOptions.baseUrl` (a `timeout` is fine), or the stub is bypassed.

**Dependency added:** `@playwright/test`, exact version pinned at execution time.

**Files**
- Modify: `package.json` (devDependency, `test:e2e` script), `package-lock.json`, `.gitignore`, `.github/workflows/ci.yml` (new `e2e` job)
- Create: `playwright.config.ts`, `e2e/ai-stub-server.mjs`, `e2e/helpers.ts`, `e2e/01-onboarding.spec.ts`

**Interfaces**
- Produces: `ensureOnboarded(page: Page): Promise<void>`, `createContact(page: Page, fullName: string): Promise<void>` in `e2e/helpers.ts`; the stub answers `POST …:generateContent` — the capture prompt ("You extract structured contact data") with one participant named after the first "First Last" pair in the note, the dates prompt ("You extract dated commitments") with `{"commitments":[]}`, anything else with `{}` — and 404s everything else (embeddings, streaming), which every caller already tolerates. Specs run one at a time in file order against one shared account.

- [ ] **Step 1: Install.** Read `node_modules/next/dist/docs/01-app/02-guides/testing/playwright.md`. Then `V=$(npm view @playwright/test version) && npm install --save-dev --save-exact "@playwright/test@$V" && npx playwright install chromium`. Add `"test:e2e": "playwright test",` to `package.json` scripts. Append to `.gitignore`:

```
# Playwright
/test-results/
/playwright-report/
/blob-report/
```

- [ ] **Step 2: Stub.** Create `e2e/ai-stub-server.mjs`:

```js
/**
 * A stand-in for the Gemini REST API during Playwright runs. The dev server reaches it via
 * GOOGLE_GEMINI_BASE_URL (read by @google/genai), so the app's real provider code runs and
 * only the network answer is canned. Dependency-free on purpose.
 */
import { createServer } from "node:http";

const port = Number(process.env.AI_STUB_PORT ?? 3999);

/** The first "First Last" pair in the note: the person the flow under test wrote about. */
const personNameIn = (text) => text.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/)?.[1] ?? "Ada Lovelace";

const userTextOf = (body) =>
  (Array.isArray(body?.contents) ? body.contents : [])
    .flatMap((c) => (Array.isArray(c?.parts) ? c.parts : []))
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("\n");

function answerFor(body) {
  // Everything but the user's text, wherever the SDK put the system instruction.
  const rest = JSON.stringify({ ...body, contents: undefined });
  const user = userTextOf(body);
  if (rest.includes("You extract structured contact data")) {
    const name = personNameIn(user);
    return {
      shared_notes: [], interaction_date: null, mentions: [],
      people: [{
        name, company: null, role: null, presence: "participant", location: null, email: null,
        linkedin_url: null, met_at: null, topics: [], action_items: [], follow_up_recommendation: null,
        follow_up_days: null, relationship_score_suggestion: 3, relevance: null, tags: [],
        summary: `${name} came up in these notes.`, key_facts: [], opportunities: [], shared_interests: [],
        suggested_next_message: null, confidence: 0.9, interaction_date: null, low_confidence_fields: [],
        source_excerpt: user.slice(0, 280),
      }],
    };
  }
  if (rest.includes("You extract dated commitments")) return { commitments: [] };
  return {};
}

function reply(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return reply(res, 200, { ok: true });
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    if (req.method === "POST" && /:generateContent(?:\?|$)/.test(req.url ?? "")) {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* an unreadable body gets the empty answer */ }
      return reply(res, 200, {
        candidates: [{ index: 0, finishReason: "STOP",
          content: { role: "model", parts: [{ text: JSON.stringify(answerFor(body)) }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
    }
    return reply(res, 404, { error: { code: 404, message: `Not stubbed: ${req.method} ${req.url}`, status: "NOT_FOUND" } });
  });
}).listen(port, "127.0.0.1", () => console.log(`[ai-stub] listening on http://127.0.0.1:${port}`));
```

- [ ] **Step 3: Config.** Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Browser flows against `next dev` in demo mode: no Clerk keys (every request is demo-user),
 * a throwaway PGlite, an empty account (ORBIT_DEMO_DATA=off) and a local Gemini stub.
 * Stop any dev server in this worktree first — two `next dev`s sharing one `.next` wedge.
 */
const PORT = Number(process.env.E2E_PORT ?? 3001);
const AI_STUB_PORT = Number(process.env.E2E_AI_STUB_PORT ?? 3999);
// The config is evaluated by the runner and every worker; the env var makes them agree.
const PGLITE_DIR: string = process.env.E2E_PGLITE_DIR || mkdtempSync(join(tmpdir(), "orbit-e2e-"));
process.env.E2E_PGLITE_DIR = PGLITE_DIR;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  // One account and one single-writer PGlite behind one server: flows share state, so they
  // run one at a time, in file-name order.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", navigationTimeout: 120_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/ai-stub-server.mjs",
      url: `http://127.0.0.1:${AI_STUB_PORT}/health`,
      env: { AI_STUB_PORT: String(AI_STUB_PORT) },
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: `./node_modules/.bin/next dev --port ${PORT}`,
      // 200 only once the schema is reconciled on the fresh PGlite.
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        DATABASE_URL: "",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
        CLERK_SECRET_KEY: "",
        ORBIT_DEMO_DATA: "off",
        ORBIT_PGLITE_DIR: PGLITE_DIR,
        GEMINI_API_KEY: "e2e-stub-key",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${AI_STUB_PORT}`,
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
```

Real environment variables beat `.env.local` in Next, so the empty Clerk keys force demo mode even in a checkout that has them (the same trick as `.claude/preview-demo.sh`).
- [ ] **Step 4: Helpers + first spec.** Create `e2e/helpers.ts`:

```ts
import { expect, type Page } from "@playwright/test";

/** Past the onboarding gate: a new account is redirected from /dashboard to /onboarding. */
export async function ensureOnboarded(page: Page): Promise<void> {
  await page.goto("/dashboard");
  if (new URL(page.url()).pathname.startsWith("/onboarding")) {
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.waitForURL(/\/dashboard$/);
  }
}

/** Creates a contact through /contacts/new and waits on its profile. */
export async function createContact(page: Page, fullName: string): Promise<void> {
  await page.goto("/contacts/new");
  // The form's labels have no htmlFor; the placeholder is the stable handle.
  await page.getByPlaceholder("Jason Pereira").fill(fullName);
  await page.getByRole("button", { name: "Create contact" }).click();
  await page.waitForURL((url) => /^\/contacts\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/new"));
  await expect(page.getByRole("heading", { level: 1, name: fullName })).toBeVisible();
}
```

Create `e2e/01-onboarding.spec.ts` (strings: `src/components/onboarding/tour-config.ts:66`, `src/components/onboarding/onboarding-flow.tsx:288-297`, `src/components/dashboard/dashboard-sections.tsx:89-106`):

```ts
import { expect, test } from "@playwright/test";

test("an empty account goes through onboarding and lands on the empty dashboard", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByRole("heading", { name: "Welcome to Orbit" })).toBeVisible();
  await page.getByRole("button", { name: "Skip tour" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Your orbit is empty" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Capture notes" })).toBeVisible();
});
```

- [ ] **Step 5: Run — first failure, then pass.** Before Step 4's files exist, `npm run test:e2e` → `Error: No tests found`. After: `npm run test:e2e` → `1 passed`. If the webServer never becomes ready, read its output (port 3001 in use by another preview → stop it; memory: a `.next` shared with a running dev server wedges it).
- [ ] **Step 6: CI job.** Append to `.github/workflows/ci.yml` under `jobs:`:

```yaml
  e2e:
    name: browser flows (Playwright)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci --no-audit --no-fund
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
        env:
          SENTRY_AUTH_TOKEN: ""
      - name: Keep the report when a flow breaks
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: |
            playwright-report/
            test-results/
          retention-days: 7
```

Also add "and the Playwright browser flows" to the first comment line of `ci.yml`.
- [ ] **Step 7: Checks + commit.** `npm run typecheck && npm run lint` (`tsconfig.json` includes `**/*.ts`, so specs and config are typechecked). `git add package.json package-lock.json .gitignore .github/workflows/ci.yml playwright.config.ts e2e/ai-stub-server.mjs e2e/helpers.ts e2e/01-onboarding.spec.ts && git commit -m "Add a Playwright suite in demo mode with a local Gemini stub; onboarding flow" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 21: Browser flow — capture → review → contact (B13)

**Files**
- Create: `e2e/02-capture.spec.ts`

**Interfaces**
- Consumes: `ensureOnboarded` (Task 20); the stub names the participant after the first "First Last" pair, so the note starts with the name. Strings: label "Your notes" (`src/components/capture/messy-notes-capture.tsx:133`), "Extract people" (`:183`), card group `"1 of 1: <name>"` (`src/components/capture/review/person-deck.tsx:332-334`), "Keep this person" (`:277`) — a single card saves immediately (`capture-flow.tsx:219-224`), "<name> is in your orbit" (`src/components/capture/capture-saved.tsx:54`).

- [ ] **Step 1: Write the spec.** Create `e2e/02-capture.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { ensureOnboarded } from "./helpers";

// Starts with the name: the Gemini stub returns the first "First Last" pair as the person.
const NOTE =
  "Ada Lovelace runs analytics at Babbage Labs. We met at the AWS Summit afterparty and talked about difference engines.";

test("a pasted note becomes a review card, and keeping it adds the contact", async ({ page }) => {
  await ensureOnboarded(page);
  await page.goto("/capture");
  // Playwright's fill() dispatches real input events, which React's controlled textarea reads.
  await page.getByLabel("Your notes").fill(NOTE);
  await page.getByRole("button", { name: "Extract people" }).click();

  await expect(page.getByRole("group", { name: "1 of 1: Ada Lovelace" })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Keep this person" }).click();
  await expect(page.getByRole("heading", { name: "Ada Lovelace is in your orbit" })).toBeVisible({ timeout: 60_000 });

  await page.goto("/contacts");
  await expect(page.getByText("Ada Lovelace").first()).toBeVisible();
});
```

- [ ] **Step 2: Run, expect failure first.** Temporarily set `GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:1"` in `playwright.config.ts` and run `npx playwright test e2e/02-capture.spec.ts` → the card never appears (the parse cannot reach a provider; the page shows the capture error state) — this proves the spec depends on the stub, not on a real key. Restore the config line.
- [ ] **Step 3: Pass.** `npm run test:e2e` → `2 passed`. If the card does not appear, open the trace (`npx playwright show-trace test-results/…/trace.zip`) and the stub's console output: an unexpected request path means the SDK's REST path changed, so adjust only the regex in `e2e/ai-stub-server.mjs`.
- [ ] **Step 4: Checks + commit.** `npm run typecheck && npm run lint`. `git add e2e/02-capture.spec.ts && git commit -m "Browser flow: capture a note, keep the card, find the contact" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 22: Browser flow — log an interaction on a contact (B13)

**Files**
- Create: `e2e/03-contact-profile.spec.ts`

**Interfaces**
- Consumes: `ensureOnboarded`, `createContact` (Task 20). Strings: header button "Log interaction" (`src/components/contacts/contact-timeline.tsx:519`), empty state "Nothing logged yet" (`:531`), sheet title "Log an interaction" and label "Notes" (`src/components/contacts/log-interaction-sheet.tsx:262,340`), submit "Log interaction" (`:363-367`), rows `li#interaction-{id}` with a "Today" day label (`contact-timeline.tsx:715-719`). With the stub key present the sheet takes the AI path: the stub names "Grace Hopper" from the note, `pickLockedParticipant` locks it to this contact, and `confirmBulkCapture` merges into it; had it not matched, `savePlain` still logs the note — either way one row.

- [ ] **Step 1: Write the spec.** Create `e2e/03-contact-profile.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { createContact, ensureOnboarded } from "./helpers";

test("logging an interaction on a contact puts it on the timeline", async ({ page }) => {
  await ensureOnboarded(page);
  await createContact(page, "Grace Hopper");
  await expect(page.getByText("Nothing logged yet")).toBeVisible();

  await page.getByRole("button", { name: "Log interaction", exact: true }).first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Log an interaction")).toBeVisible();
  await sheet.getByLabel("Notes").fill("Grace Hopper walked me through compilers over coffee; she will send the COBOL paper.");
  await sheet.getByRole("button", { name: "Log interaction", exact: true }).click();

  await expect(page.getByText("Nothing logged yet")).toBeHidden({ timeout: 60_000 });
  const rows = page.locator('li[id^="interaction-"]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Today");
  await expect(page.getByRole("heading", { level: 1, name: "Grace Hopper" })).toBeVisible();
});
```

- [ ] **Step 2: Run, expect failure first.** Before the file exists `npx playwright test e2e/03-contact-profile.spec.ts` → `No tests found`; with it, temporarily change the expected row count to `2` → fails with `Expected: 2 Received: 1`, proving the locator counts real rows. Restore `1`.
- [ ] **Step 3: Pass.** `npm run test:e2e` → `3 passed`. The final heading check guards the merge: if the h1 became another name, the stub's person was merged into the wrong contact — a real bug to report, not a spec to loosen.
- [ ] **Step 4: Checks + commit.** `npm run typecheck && npm run lint`. `git add e2e/03-contact-profile.spec.ts && git commit -m "Browser flow: log an interaction and see it on the timeline" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 23: Browser flow — Settings → Delete data (B13)

**Files**
- Create: `e2e/04-delete-data.spec.ts`

**Interfaces**
- Consumes: `ensureOnboarded`, `createContact`. Strings: opener "Delete data…" with a real ellipsis (`src/components/settings/data-settings.tsx:79`); dialog "Delete your Orbit data"; per-category counts render as `N record`/`N records` only when above zero (`src/components/settings/delete-data-dialog.tsx:197-202`); confirmation input placeholder `delete` (`:224-230`); "Delete everything" when all categories are ticked (the default) (`:247-251`); toast "All data deleted"; the Plan card's server-rendered `Unlimited contacts — N in your orbit.` (`src/components/settings/plan-settings.tsx:182`; demo accounts get unrestricted entitlements, `src/lib/entitlements.ts:152-157`, so `usage.limit` is null). The dialog keeps its last counts in state until the refetch lands, so the Plan card after a reload is the authoritative zero; the dialog assertion auto-waits for the refetch.

- [ ] **Step 1: Write the spec.** Create `e2e/04-delete-data.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { createContact, ensureOnboarded } from "./helpers";

const RECORD_COUNT = /^\d[\d,]* records?$/;

test("Settings → Delete data empties the account", async ({ page }) => {
  await ensureOnboarded(page);
  await createContact(page, "Katherine Johnson");

  await page.goto("/settings");
  const plan = page.getByText(/Unlimited contacts — \d+ in your orbit\./);
  await expect(plan).toBeVisible();
  await expect(plan).not.toHaveText("Unlimited contacts — 0 in your orbit.");

  await page.getByRole("button", { name: "Delete data…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your Orbit data" });
  await expect(dialog.getByText(RECORD_COUNT).first()).toBeVisible();
  await dialog.getByPlaceholder("delete").fill("delete");
  await dialog.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.getByText("All data deleted")).toBeVisible({ timeout: 60_000 });

  await page.reload();
  await expect(page.getByText("Unlimited contacts — 0 in your orbit.")).toBeVisible();
  await page.getByRole("button", { name: "Delete data…" }).click();
  await expect(page.getByRole("dialog", { name: "Delete your Orbit data" }).getByText(RECORD_COUNT)).toHaveCount(0);
});
```

- [ ] **Step 2: Run, expect failure first.** Temporarily assert `"Unlimited contacts — 1 in your orbit."` after the reload → fails with the received text `… 0 in your orbit.`, proving the count is read after the delete. Restore.
- [ ] **Step 3: Pass.** `npm run test:e2e` → `4 passed`. A category still showing records after the reload (for example "Usage and diagnostics") means a background write landed after the purge — report it; do not delete that assertion.
- [ ] **Step 4: Checks + commit.** `npm run typecheck && npm run lint`. `git add e2e/04-delete-data.spec.ts && git commit -m "Browser flow: Settings → Delete data leaves nothing behind" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 24: Browser flow — `/upgrade` → Stripe Checkout (B13)

**Files**
- Create: `e2e/05-upgrade.spec.ts`

**Interfaces**
- Strings: heading "Pick how you'd like to pay." for a free account (`src/app/(clerk)/(checkout)/upgrade/page.tsx:123`; `/upgrade` sits outside the onboarding gate); card names "Orbit Pro" / "Orbit Lifetime" (`src/lib/plan-copy.ts:110,132`); buttons `Start Pro — $5/month` (`src/components/pricing/pro-checkout-button.tsx:28-29`) and `Get Orbit Lifetime — $<price>` (`src/components/pricing/lifetime-checkout-button.tsx:51`); clicking Lifetime runs `startLifetimeCheckout` and sets `window.location.href` to the Checkout Session URL (`src/actions/billing.ts:34-85`, `lifetime-checkout-button.tsx:36-39`). Without Stripe configured the cards render "Not on sale yet" and "Subscription checkout is unavailable in this environment." (`src/components/pricing/upgrade-plan-cards.tsx:172,190`), so the checkout test is skipped unless the test-mode keys are exported in the shell that runs Playwright (the dev server inherits them).

- [ ] **Step 1: Write the spec.** Create `e2e/05-upgrade.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

const STRIPE_READY = ["STRIPE_SECRET_KEY", "STRIPE_LIFETIME_PRICE_ID", "STRIPE_PRO_MONTHLY_PRICE_ID", "STRIPE_PRO_ANNUAL_PRICE_ID"]
  .every((name) => Boolean(process.env[name]?.trim()));

test("the upgrade page offers both plans", async ({ page }) => {
  await page.goto("/upgrade");
  await expect(page.getByRole("heading", { name: /Pick how you.d like to pay/ })).toBeVisible();
  await expect(page.getByText("Orbit Pro", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Orbit Lifetime", { exact: true }).first()).toBeVisible();
});

test("Lifetime opens Stripe Checkout", async ({ page }) => {
  test.skip(!STRIPE_READY, "export test-mode STRIPE_SECRET_KEY and the three price ids to run this");
  await page.goto("/upgrade");
  await expect(page.getByRole("button", { name: /^Start Pro — / })).toBeVisible();
  const lifetime = page.getByRole("button", { name: /^Get Orbit Lifetime — \$/ });
  await expect(lifetime).toBeVisible();
  await lifetime.click();
  await page.waitForURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 60_000 });
});
```

- [ ] **Step 2: Run, expect failure first.** With no Stripe keys: temporarily remove the `test.skip` line → the Lifetime button is not found ("Not on sale yet"), proving the skip guards a real dependency. Restore it. Then with test-mode keys exported (`STRIPE_SECRET_KEY=sk_test_… STRIPE_LIFETIME_PRICE_ID=price_… STRIPE_PRO_MONTHLY_PRICE_ID=price_… STRIPE_PRO_ANNUAL_PRICE_ID=price_… npx playwright test e2e/05-upgrade.spec.ts`) the second test reaches `checkout.stripe.com`.
- [ ] **Step 3: Pass.** `npm run test:e2e` → `5 passed, 1 skipped` without keys; `6 passed` with them.
- [ ] **Step 4: Checks + commit.** `npm run typecheck && npm run lint`. `git add e2e/05-upgrade.spec.ts && git commit -m "Browser flow: /upgrade offers both plans and Lifetime reaches Stripe Checkout" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`
- [ ] **Step 5: Whole branch.** `npm test`, `npm run test:e2e`, `npm run typecheck`, `npm run lint`, `npm run build` all green. Confirm no `SCHEMA_VERSION` change: `git diff origin/main -- src/db/index.ts | grep -c "SCHEMA_VERSION ="` prints `0`. Merge `origin/main` once more (re-run everything) before opening the PR.

---

### Task 25: `embedding.unembeddable` and `ai.quota_failures` (Phase 3a handoff)

Two provider-refusal signals Phase 3a creates and hands over: rows in its new `embedding_failures` table (3a Task 12, columns `user_id`, `source_type`, `source_id`, `error_kind`, `failed_at`) and `usage_events.error_kind = 'quota'` (3a Task 4). One statement reads both.

**Precondition:** Phase 3a is merged into this branch (`git merge origin/main`; `grep -n "embedding_failures" src/db/schema.ts` finds the table; `grep -n '"quota"' src/lib/errors.ts` finds the kind). Until then skip to Task 26.

**Files**
- Modify: `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts`
- Modify: `scripts/smoke-ops-alerts.ts`, `scripts/smoke-ops-snapshot.ts`, `scripts/smoke-ops-sweep.ts`, `docs/RUNBOOK.md`

**Interfaces**
- Consumes: `embeddingFailures` (3a) from `@/db/schema`; `usageEvents.errorKind`.
- Produces: `OpsSnapshot.aiRefusals24h: { unembeddable: number; quotaAccounts: number }`; `export const UNEMBEDDABLE_SPIKE = 10;` (a starting value — one odd row is noise, a spike means the provider refuses a content shape); conditions `embedding.unembeddable` (warning, `unembeddable >= UNEMBEDDABLE_SPIKE`) and `ai.quota_failures` (info, `quotaAccounts >= 1`; info is said once per opening, never reminded).

- [ ] **Step 1: Failing tests.** `scripts/smoke-ops-alerts.ts`: `HEALTHY` gains `aiRefusals24h: { unembeddable: 0, quotaAccounts: 0 },`; add:

```ts
  check("a spike of unembeddable rows → embedding.unembeddable (warning)",
    find({ ...HEALTHY, aiRefusals24h: { unembeddable: 10, quotaAccounts: 0 } }, "embedding.unembeddable")?.severity === "warning");
  check("a few odd rows are not a spike",
    !find({ ...HEALTHY, aiRefusals24h: { unembeddable: 3, quotaAccounts: 0 } }, "embedding.unembeddable"));
  check("an account out of provider credit → ai.quota_failures (info)",
    find({ ...HEALTHY, aiRefusals24h: { unembeddable: 0, quotaAccounts: 2 } }, "ai.quota_failures")?.severity === "info");
```

`scripts/smoke-ops-snapshot.ts`: import `embeddingFailures, usageEvents` from the schema; above the marker:

```ts
  console.log("\nProvider refusals...");
  await db.delete(embeddingFailures).where(eq(embeddingFailures.userId, "snap-unembeddable"));
  await db.delete(usageEvents).where(inArray(usageEvents.userId, ["snap-quota-a", "snap-quota-b"]));
  const before = (await loadOpsSnapshot(new Date(), null)).aiRefusals24h;
  await db.insert(embeddingFailures).values(
    Array.from({ length: 10 }, (_, i) => ({ userId: "snap-unembeddable", sourceType: "profile" as const, sourceId: `c-${i}`, errorKind: "other" }))
  );
  const quotaRow = { operation: "capture.parse", provider: "gemini" as const, model: "gemini-3.5-flash",
    kind: "completion" as const, keyOwner: "user" as const, success: 0, errorKind: "quota" };
  await db.insert(usageEvents).values([
    { ...quotaRow, userId: "snap-quota-a" },
    { ...quotaRow, userId: "snap-quota-a" },
    { ...quotaRow, userId: "snap-quota-b" },
  ]);
  const after = (await loadOpsSnapshot(new Date(), null)).aiRefusals24h;
  check("unembeddable rows in the last day are counted", after.unembeddable === before.unembeddable + 10, JSON.stringify(after));
  check("quota failures are counted per account, not per call", after.quotaAccounts === before.quotaAccounts + 2, JSON.stringify(after));
  const refusalIds = await idsNow();
  check("which open both conditions", refusalIds.includes("embedding.unembeddable") && refusalIds.includes("ai.quota_failures"), refusalIds.join(","));
  await db.delete(embeddingFailures).where(eq(embeddingFailures.userId, "snap-unembeddable"));
  await db.delete(usageEvents).where(inArray(usageEvents.userId, ["snap-quota-a", "snap-quota-b"]));
```

- [ ] **Step 2: Run, expect failure.** ops-alerts → `FAIL a spike of unembeddable rows …`; ops-snapshot → `TypeError: Cannot read properties of undefined (reading 'unembeddable')`.
- [ ] **Step 3: Catalogue.** `OpsSnapshot` add:

```ts
  /** Last 24 h: embedding_failures rows, and accounts with a `quota` usage failure. */
  aiRefusals24h: { unembeddable: number; quotaAccounts: number };
```

Below `BACKFILL_FAILING_ACCOUNTS` add `export const UNEMBEDDABLE_SPIKE = 10;`. After the `embedding.backlog` block add:

```ts
  if (s.aiRefusals24h.unembeddable >= UNEMBEDDABLE_SPIKE) {
    out.push({
      id: "embedding.unembeddable",
      severity: "warning",
      title: "The embedding provider is refusing content",
      detail: `${s.aiRefusals24h.unembeddable} contacts or meetings were marked unembeddable in the last day — a spike means the provider started refusing a content shape, not one odd row.`,
      href: "/admin/health",
    });
  }
  if (s.aiRefusals24h.quotaAccounts >= 1) {
    out.push({
      id: "ai.quota_failures",
      severity: "info",
      title: "Accounts are out of AI provider credit",
      detail: `${s.aiRefusals24h.quotaAccounts} account(s) hit a quota or empty-balance error in the last day. Each already sees a "top up" alert; this is the count.`,
      href: "/admin/health",
    });
  }
```

- [ ] **Step 4: Loader.** One statement for both. Append (last) with destructured name `refusalRes`:

```ts
      db.execute(sql`
        SELECT
          (SELECT count(*) FROM embedding_failures WHERE failed_at > now() - interval '24 hours')::int AS unembeddable,
          (SELECT count(DISTINCT user_id) FROM usage_events
            WHERE error_kind = 'quota' AND created_at > now() - interval '24 hours')::int AS quota_accounts
      `),
```

Import `rowsOf` from `@/db` (merge into `import { getDb } from "@/db";`). Before the return: `const refusals = rowsOf<{ unembeddable: number; quota_accounts: number }>(refusalRes)[0];` and return `aiRefusals24h: { unembeddable: Number(refusals?.unembeddable ?? 0), quotaAccounts: Number(refusals?.quota_accounts ?? 0) },`.
- [ ] **Step 5: Sweep isolation.** `scripts/smoke-ops-sweep.ts` `reset()` (the table is shared by 3a's embedding smokes):

```ts
  await db.execute(sql`DELETE FROM embedding_failures WHERE failed_at > now() - interval '24 hours'`);
  await db.execute(sql`DELETE FROM usage_events WHERE error_kind = 'quota'`);
```

- [ ] **Step 6: Runbook rows.**

```md
| `embedding.unembeddable` | `SELECT error_kind, source_type, count(*) FROM embedding_failures WHERE failed_at > now() - interval '1 day' GROUP BY 1, 2;`. One kind on one provider across users is a provider change (check its status page and changelog); the rows retry once the bisect in `src/lib/embedding-backfill.ts` can embed them. |
| `ai.quota_failures` | Informational. Users with an empty provider balance already see a "top up" account alert. Many at once on Orbit's own key (`key_owner = 'orbit'`, local dev only) means topping up that account. |
```

- [ ] **Step 7: Pass + commit.** Ops smokes pass; `npm run typecheck && npm run lint`. `git add src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts scripts/smoke-ops-snapshot.ts scripts/smoke-ops-sweep.ts docs/RUNBOOK.md && git commit -m "Alert on unembeddable spikes and count accounts out of AI credit" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 26: `calendar.disarmed` (Phase 3a handoff)

3a's handoff: many calendar connections disarmed at once means a Google-side change, not user churn. It overlaps the existing `sync.failing` (warning when any connection has `sync_status = 'error' AND next_sync_at IS NULL`, `src/lib/admin-system.ts:402-407`). They stay separate on purpose: `sync.failing` is "we gave up on an account"; `calendar.disarmed` is info and fires only at a burst, which is the only thing 3a's reason is about. After 3a Task 2, `disarmSync` records `sync_error` for both scope and failure disarms, which is what this reads; the query runs before 3a lands too (the columns already exist), just with fewer rows.

**Files**
- Modify: `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts`
- Modify: `scripts/smoke-ops-alerts.ts`, `scripts/smoke-ops-snapshot.ts`, `scripts/smoke-ops-sweep.ts`, `docs/RUNBOOK.md`

**Interfaces**
- Produces: `OpsSnapshot.calendarDisarmed: number` (active Google connections with the calendar scope, disarmed with a recorded error); `export const CALENDAR_DISARM_BURST = 5;`; condition `calendar.disarmed` (info) at `>= CALENDAR_DISARM_BURST`.

- [ ] **Step 1: Failing tests.** `scripts/smoke-ops-alerts.ts`: `HEALTHY` gains `calendarDisarmed: 0,`; add:

```ts
  check("five disarmed calendars → calendar.disarmed (info)",
    find({ ...HEALTHY, calendarDisarmed: 5 }, "calendar.disarmed")?.severity === "info");
  check("one or two disarmed calendars is user churn, not an alert", !find({ ...HEALTHY, calendarDisarmed: 2 }, "calendar.disarmed"));
```

`scripts/smoke-ops-snapshot.ts`, above the marker:

```ts
  console.log("\nDisarmed calendars...");
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id LIKE 'snap-disarmed-%'`);
  const disarmedBefore = (await loadOpsSnapshot(new Date(), null)).calendarDisarmed;
  for (let i = 0; i < 5; i++) {
    await db.execute(sql`INSERT INTO gmail_connections
      (user_id, email_address, access_token_encrypted, status, scopes, next_sync_at, sync_failures, sync_error)
      VALUES (${`snap-disarmed-${i}`}, ${`snap-disarmed-${i}@example.com`}, 'enc', 'active',
              'https://www.googleapis.com/auth/calendar.readonly', NULL, 6, 'Google Calendar 403: forbidden')`);
  }
  // Disarmed without the calendar scope is a Gmail-only account: not counted.
  await db.execute(sql`INSERT INTO gmail_connections
    (user_id, email_address, access_token_encrypted, status, scopes, next_sync_at, sync_failures, sync_error)
    VALUES ('snap-disarmed-mail', 'snap-disarmed-mail@example.com', 'enc', 'active',
            'https://www.googleapis.com/auth/gmail.readonly', NULL, 0, 'Calendar access not granted')`);
  const disarmedAfter = (await loadOpsSnapshot(new Date(), null)).calendarDisarmed;
  check("disarmed calendar connections are counted, mail-only ones are not",
    disarmedAfter === disarmedBefore + 5, `${disarmedBefore} → ${disarmedAfter}`);
  check("five at once open calendar.disarmed", (await idsNow()).includes("calendar.disarmed"));
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id LIKE 'snap-disarmed-%'`);
```

- [ ] **Step 2: Run, expect failure.** ops-alerts → `FAIL five disarmed calendars …`; ops-snapshot → `FAIL disarmed calendar connections are counted …` (`undefined → undefined`).
- [ ] **Step 3: Catalogue.** `OpsSnapshot` add `/** Active calendar-scoped Google connections disarmed with an error. */ calendarDisarmed: number;`. Below `SYNC_LAG_ALERT_MS` add `export const CALENDAR_DISARM_BURST = 5;`. After the `sync.failing` block add:

```ts
  // `sync.failing` above already says "we gave up on an account". This is the burst: many
  // calendars disarmed at once is a Google-side change (a scope, an API, a quota), not churn.
  if (s.calendarDisarmed >= CALENDAR_DISARM_BURST) {
    out.push({
      id: "calendar.disarmed",
      severity: "info",
      title: "Many calendar syncs are disarmed",
      detail: `${s.calendarDisarmed} Google calendar connections are disarmed with an error — check for a Google-side change before blaming users.`,
      href: "/admin/health",
    });
  }
```

- [ ] **Step 4: Loader.** Append (last) with destructured name `disarmedRes`:

```ts
      db.execute(sql`
        SELECT count(*)::int AS n FROM gmail_connections
         WHERE status = 'active' AND next_sync_at IS NULL AND sync_error IS NOT NULL
           AND scopes LIKE '%calendar.readonly%'
      `),
```

Return `calendarDisarmed: Number(rowsOf<{ n: number }>(disarmedRes)[0]?.n ?? 0),` (`rowsOf` is imported since Task 25; if Task 25 was skipped, add it to the `@/db` import here).
- [ ] **Step 5: Sweep isolation.** `scripts/smoke-ops-sweep.ts` `reset()`: ``await db.execute(sql`UPDATE gmail_connections SET sync_error = NULL WHERE next_sync_at IS NULL AND sync_error IS NOT NULL`);`` (other scripts' disarmed rows would otherwise add up to a burst).
- [ ] **Step 6: Runbook row.**

```md
| `calendar.disarmed` | `SELECT sync_error, count(*) FROM gmail_connections WHERE next_sync_at IS NULL AND sync_error IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;` One error string across many accounts is Google's side (API change, consent-screen or scope change, project quota in Google Cloud Console). Users reconnect from the Integrations dialog once it is fixed. |
```

- [ ] **Step 7: Pass + commit.** Ops smokes and `smoke-sync-scheduler` pass; `npm run typecheck && npm run lint`. `git add src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts scripts/smoke-ops-snapshot.ts scripts/smoke-ops-sweep.ts docs/RUNBOOK.md && git commit -m "Flag a burst of disarmed calendar syncs" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 27: `avatar.source_exhausted` and `apollo.hosted_cap_hits` (Phase 3a handoff)

Both read `rate_limit_buckets`, which 3a Tasks 18–19 now use for shared third-party budgets: `avatarSource.shared:<source>` (app-wide photo lookups) and `apollo.search:<userId>` / `apollo.enrich:<userId>` (hosted Apollo per account). `consumeBucket` (`src/lib/rate-limit.ts:128-157`) increments before it refuses, so `count > limit` inside the window means at least one request was refused. Thresholds come from `RATE_LIMITS`, not literals, so a budget change moves the alert with it.

**Precondition:** Phase 3a is merged (`RATE_LIMITS.avatarSourceShared`, `apolloSearch`, `apolloEnrich` exist in `src/lib/rate-limit.ts`).

**Files**
- Modify: `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts`
- Modify: `scripts/smoke-ops-alerts.ts`, `scripts/smoke-ops-snapshot.ts`, `scripts/smoke-ops-sweep.ts`, `docs/RUNBOOK.md`

**Interfaces**
- Consumes: `rateLimitBuckets` (schema), `RATE_LIMITS` (3a's keys).
- Produces: `OpsSnapshot.sharedBudgets: { avatarSourcesExhausted: string[]; apolloCapHits: number }` from one query; conditions `avatar.source_exhausted` (info, any source exhausted today — the source name is in the detail) and `apollo.hosted_cap_hits` (info, `apolloCapHits >= 1`).

- [ ] **Step 1: Failing tests.** `scripts/smoke-ops-alerts.ts`: `HEALTHY` gains `sharedBudgets: { avatarSourcesExhausted: [], apolloCapHits: 0 },`; add:

```ts
  const exhausted = find({ ...HEALTHY, sharedBudgets: { avatarSourcesExhausted: ["unavatar"], apolloCapHits: 0 } }, "avatar.source_exhausted");
  check("an exhausted photo source → avatar.source_exhausted (info), naming it",
    exhausted?.severity === "info" && exhausted.detail.includes("unavatar"), exhausted?.detail);
  check("accounts hitting the hosted Apollo cap → apollo.hosted_cap_hits (info)",
    find({ ...HEALTHY, sharedBudgets: { avatarSourcesExhausted: [], apolloCapHits: 3 } }, "apollo.hosted_cap_hits")?.severity === "info");
```

`scripts/smoke-ops-snapshot.ts`: import `rateLimitBuckets` from the schema, `like, or` from drizzle-orm (merge), and `RATE_LIMITS` from `../src/lib/rate-limit`; above the marker:

```ts
  console.log("\nShared third-party budgets...");
  const budgetRows = or(like(rateLimitBuckets.bucket, "avatarSource.shared:%"), like(rateLimitBuckets.bucket, "apollo.%"));
  await db.delete(rateLimitBuckets).where(budgetRows);
  const now2 = new Date();
  await db.insert(rateLimitBuckets).values([
    { bucket: "avatarSource.shared:unavatar", windowStartedAt: now2, count: RATE_LIMITS.avatarSourceShared.limit + 1 },
    { bucket: "avatarSource.shared:microlink", windowStartedAt: now2, count: 3 },
    { bucket: "apollo.search:snap-a", windowStartedAt: now2, count: RATE_LIMITS.apolloSearch.limit + 1 },
    { bucket: "apollo.enrich:snap-b", windowStartedAt: now2, count: RATE_LIMITS.apolloEnrich.limit + 4 },
    { bucket: "apollo.enrich:snap-c", windowStartedAt: now2, count: 2 },
    // Refused, but in a window that ended over a day ago: yesterday's news.
    { bucket: "apollo.search:snap-old", windowStartedAt: new Date(Date.now() - 30 * 3_600_000), count: 99 },
  ]);
  const budgets = (await loadOpsSnapshot(new Date(), null)).sharedBudgets;
  check("only the source that went over its budget is exhausted",
    JSON.stringify(budgets.avatarSourcesExhausted) === JSON.stringify(["unavatar"]), JSON.stringify(budgets));
  check("each account over a hosted Apollo cap today is one hit", budgets.apolloCapHits === 2, JSON.stringify(budgets));
  const budgetIds = await idsNow();
  check("which open both conditions",
    budgetIds.includes("avatar.source_exhausted") && budgetIds.includes("apollo.hosted_cap_hits"), budgetIds.join(","));
  await db.delete(rateLimitBuckets).where(budgetRows);
```

- [ ] **Step 2: Run, expect failure.** ops-alerts → `FAIL an exhausted photo source …`; ops-snapshot → `TypeError: Cannot read properties of undefined (reading 'avatarSourcesExhausted')`.
- [ ] **Step 3: Catalogue.** `OpsSnapshot` add:

```ts
  /** Shared third-party budgets refused today: photo sources out, accounts at the hosted Apollo cap. */
  sharedBudgets: { avatarSourcesExhausted: string[]; apolloCapHits: number };
```

After the `ai.quota_failures` block add:

```ts
  if (s.sharedBudgets.avatarSourcesExhausted.length > 0) {
    out.push({
      id: "avatar.source_exhausted",
      severity: "info",
      title: "A shared photo source is out for today",
      detail: `${s.sharedBudgets.avatarSourcesExhausted.join(" and ")} used its whole daily allowance; photo lookups defer until the window resets.`,
      href: "/admin/health",
    });
  }
  if (s.sharedBudgets.apolloCapHits >= 1) {
    out.push({
      id: "apollo.hosted_cap_hits",
      severity: "info",
      title: "Accounts are hitting the hosted Apollo cap",
      detail: `${s.sharedBudgets.apolloCapHits} account budget(s) for hosted Apollo search or enrichment ran out today — demand against the Apollo plan.`,
      href: "/admin/health",
    });
  }
```

- [ ] **Step 4: Loader.** In `src/lib/ops-sweep.ts` add `like, or` to the drizzle import, `rateLimitBuckets` to the schema import, `import { RATE_LIMITS } from "@/lib/rate-limit";`. Append (last) with destructured name `budgetAgg`:

```ts
      db
        .select({ bucket: rateLimitBuckets.bucket, count: rateLimitBuckets.count })
        .from(rateLimitBuckets)
        .where(
          and(
            or(like(rateLimitBuckets.bucket, "avatarSource.shared:%"), like(rateLimitBuckets.bucket, "apollo.%")),
            gt(rateLimitBuckets.windowStartedAt, dayAgo)
          )
        ),
```

Return field:

```ts
    sharedBudgets: {
      avatarSourcesExhausted: budgetAgg
        .filter((r) => r.bucket.startsWith("avatarSource.shared:") && r.count > RATE_LIMITS.avatarSourceShared.limit)
        .map((r) => r.bucket.slice("avatarSource.shared:".length))
        .sort(),
      apolloCapHits: budgetAgg.filter(
        (r) =>
          (r.bucket.startsWith("apollo.search:") && r.count > RATE_LIMITS.apolloSearch.limit) ||
          (r.bucket.startsWith("apollo.enrich:") && r.count > RATE_LIMITS.apolloEnrich.limit)
      ).length,
    },
```

`rate-limit.ts` imports only `drizzle-orm`, `@/db` and the schema, so no `next/server` reaches the sweep.
- [ ] **Step 5: Sweep isolation.** `scripts/smoke-ops-sweep.ts` `reset()`: ``await db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket LIKE 'avatarSource.shared:%' OR bucket LIKE 'apollo.%'`);``
- [ ] **Step 6: Runbook rows.**

```md
| `avatar.source_exhausted` | Informational: that source's shared daily allowance (`RATE_LIMITS.avatarSourceShared`) is gone and photo lookups wait for tomorrow. Daily before noon means raising the budget or buying the source's paid plan (`MICROLINK_API_KEY` skips the shared Microlink budget). |
| `apollo.hosted_cap_hits` | Informational: accounts used their daily hosted Apollo allowance (`RATE_LIMITS.apolloSearch` / `apolloEnrich`). Compare with the Apollo plan's credits before raising either. |
```

- [ ] **Step 7: Pass + commit.** Ops smokes and 3a's `smoke-avatar-source-budget`, `smoke-apollo-hosted-budget` pass; `npm run typecheck && npm run lint`. `git add src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts scripts/smoke-ops-snapshot.ts scripts/smoke-ops-sweep.ts docs/RUNBOOK.md && git commit -m "Report exhausted shared photo budgets and hosted Apollo cap hits" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

### Task 28: `backup.stale` — a Better Stack heartbeat after each stored backup (deferred from Phase 0)

Phase 0 made `.github/workflows/backup.yml` fail loudly (guard, `pipefail`, a Slack page on `failure()`), but a workflow that stops running — the 60-day rule, a disabled workflow, an Actions outage — fails nothing and pages nobody. As with the sweep, "it stopped" is owned by an external monitor, because a process cannot report its own absence (the header of `src/lib/ops-alerts.ts` says so). So there is no `ops-alerts.ts` entry and no GitHub API call: the job's last step pings a second Better Stack heartbeat after the artifact upload succeeds, and Better Stack alerts when no ping arrives for 36 h (a 24 h period plus 12 h grace, set up in Manual steps).

**Files**
- Modify: `.github/workflows/backup.yml` (as Phase 0 Task 7 left it: add one step between `- uses: actions/upload-artifact@v4` and `- name: Page on a failed backup`; extend the `# Secrets:` header comment)
- Modify: `scripts/smoke-backup-workflow.ts` (Phase 0's; add a section before `console.log("\nThe schedule is unchanged");`)
- Modify: `docs/RUNBOOK.md` ("Where to look" table)

**Interfaces**
- Consumes: Phase 0's `stepAt(at)`, `uploadAt`, `pageAt` in the smoke.
- Produces: a step named `Tell Better Stack the backup landed`, running only on success (no `if:`), after the upload, before the failure page; reads repo secret `BETTERSTACK_BACKUP_HEARTBEAT_URL`; skips when unset; never fails the job (a heartbeat outage must not trigger the "backup failed" page).

- [ ] **Step 1: Failing test.** In `scripts/smoke-backup-workflow.ts`, before `console.log("\nThe schedule is unchanged");`, add:

```ts
console.log("\nA stored backup pings its own heartbeat (backup.stale is Better Stack's job)");
const beatAt = src.indexOf("- name: Tell Better Stack the backup landed");
const beat = stepAt(beatAt);
check("a heartbeat step exists", beatAt !== -1);
check("…after the upload, so it means a dump was stored", uploadAt !== -1 && beatAt > uploadAt, `${uploadAt} ${beatAt}`);
check("…before the failure page, which stays last", pageAt > beatAt);
check("…runs only on success (no if: always()/failure())", !/\bif:/.test(beat));
check("…reads BETTERSTACK_BACKUP_HEARTBEAT_URL from secrets",
  beat.includes("secrets.BETTERSTACK_BACKUP_HEARTBEAT_URL") && beat.includes('"$BETTERSTACK_BACKUP_HEARTBEAT_URL"'));
check("…skips quietly when the secret is unset",
  beat.includes('[ -z "$BETTERSTACK_BACKUP_HEARTBEAT_URL" ]') && beat.includes("exit 0"));
check("…and can never fail the job (a Better Stack outage is not a failed backup)",
  beat.includes("--max-time") && beat.includes("|| echo"));
check("the header names the secret", src.slice(0, src.indexOf("name: backup")).includes("BETTERSTACK_BACKUP_HEARTBEAT_URL"));
```

- [ ] **Step 2: Run, expect failure.** `npx tsx scripts/smoke-backup-workflow.ts` → `FAIL a heartbeat step exists` and the checks under it; exit 1.
- [ ] **Step 3: Implement.** In `.github/workflows/backup.yml` insert, directly after the `upload-artifact` step's `if-no-files-found: error` line and before `- name: Page on a failed backup`:

```yaml
      # Only reached when every step above succeeded, so a ping means a dump was stored.
      # Better Stack alerts when none arrives for 36 h: that is `backup.stale`, and it is the
      # one signal that still works when this workflow stops running altogether.
      - name: Tell Better Stack the backup landed
        run: |
          if [ -z "$BETTERSTACK_BACKUP_HEARTBEAT_URL" ]; then
            echo "BETTERSTACK_BACKUP_HEARTBEAT_URL not set, skipping"
            exit 0
          fi
          curl -sS --max-time 10 "$BETTERSTACK_BACKUP_HEARTBEAT_URL" > /dev/null || echo "heartbeat ping did not go through; Better Stack will notice the gap"
        env:
          BETTERSTACK_BACKUP_HEARTBEAT_URL: ${{ secrets.BETTERSTACK_BACKUP_HEARTBEAT_URL }}
```

In the header comment, change `SLACK_OPS_CRITICAL_WEBHOOK_URL (optional; pages on failure).` to `SLACK_OPS_CRITICAL_WEBHOOK_URL (optional; pages on failure), BETTERSTACK_BACKUP_HEARTBEAT_URL (optional; pinged after each stored dump — Better Stack pages when none arrives for 36 h).` In `docs/RUNBOOK.md` "Where to look", add a row after "Something is down":

```md
| Backups stopped (`backup.stale`) | Better Stack heartbeat "orbit backup" (36 h without a ping) → `#orbit-ops-critical`; then GitHub → Actions → `backup` |
```

- [ ] **Step 4: Pass.** `npx tsx scripts/smoke-backup-workflow.ts` → all `ok`; `npx tsx scripts/smoke-schedules.ts` (Task 18) still passes; `npm run typecheck && npm run lint && npx tsx scripts/run-smoke.ts --check`. If `actionlint` is installed, `actionlint .github/workflows/backup.yml` prints nothing.
- [ ] **Step 5: Commit.** `git add .github/workflows/backup.yml scripts/smoke-backup-workflow.ts docs/RUNBOOK.md && git commit -m "Ping a Better Stack heartbeat after every stored backup" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`

---

## Manual steps (not code)

1. **Production variables (Task 8).** `vercel env ls production` and check that these exist: `SLACK_OPS_WEBHOOK_URL`, `SLACK_OPS_CRITICAL_WEBHOOK_URL`, `BETTERSTACK_HEARTBEAT_URL`, `RESEND_WEBHOOK_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`. Add any that are missing with `vercel env add <NAME> production` (or Vercel → Project → Settings → Environment Variables → Production only), then Deployments → the latest → Redeploy. The build log's `check-env` warnings must not list any of them.
2. **Neon statement timeout (Task 5).** Neon console → SQL Editor on the production branch: `ALTER ROLE <app role> SET statement_timeout = '20s';`. Verify: `curl -s "https://orbit.jasonpereira.live/api/health?token=$HEALTH_TOKEN" | jq .config.statementTimeout` prints `"20s"`; `config.statement_timeout_unbounded` recovers on the next sweep.
3. **First deploy after Task 11.** Expect the build's `db:migrate` to print `schema version N applied` once (the fingerprint column forces one full sweep). With Task 10 in place that sweep does not rewrite `contacts`. The next deploy prints `already current`.
4. **Vercel cron removed (Task 18).** After the production deploy, Vercel → Project → Settings → Cron Jobs lists nothing. GitHub → Actions → `ops` shows the hourly `7 * * * *` run of "Run the stalled-import backstop".
5. **60-day reminder (Task 18).** Create a calendar event repeating every 45 days: "Orbit: run `gh api repos/jasonpereira518/orbit/actions/workflows --jq '.workflows[] | [.name, .state] | @tsv'`; if anything says `disabled_inactivity`, follow docs/RUNBOOK.md → Scheduled workflows were disabled."
6. **Better Stack monitor (Task 19).** If the monitor URL carries `?token=`, open it once after deploy: a 401 means the monitor's token is wrong — fix it in Better Stack now, because it used to pass silently.
7. **drizzle push locally (Task 12).** In the main checkout's `.env.local` add `PRODUCTION_DB_HOST=<production Neon hostname>` so the guard can tell a branch from production. Never put `ALLOW_DRIZZLE_PUSH` in a file.
8. **Required check (Task 20).** After the `browser flows (Playwright)` job is green on three consecutive PRs: GitHub → Settings → Branches → `main` → require it alongside `typecheck · lint · build`, `smoke suite (PGlite)` and the extension job.
9. **Stripe flow locally (Task 24).** Once per release, run `npm run test:e2e` with test-mode `STRIPE_SECRET_KEY` and the three price ids exported, so the Lifetime → Checkout flow actually runs (CI skips it).
10. **Phase 3a coordination (Task 20).** Tell whoever executes Phase 3a: keep `new GoogleGenAI({ apiKey })` free of `httpOptions.baseUrl` in `src/lib/ai.ts`, or the e2e Gemini stub is bypassed and the capture flows call the real API.

11. **Backup heartbeat (Task 28).** Better Stack → Uptime → Heartbeats → **Create heartbeat**: name `orbit backup`, *Expect a heartbeat every* 1 day, *with a grace period of* 12 hours (so it alerts after 36 h of silence), escalate to the same on-call as the `/api/health` monitor (the `#orbit-ops-critical` Slack integration). Copy its URL. GitHub → `jasonpereira518/orbit` → Settings → Secrets and variables → Actions → **New repository secret** `BETTERSTACK_BACKUP_HEARTBEAT_URL` = that URL. Then Actions → `backup` → **Run workflow**; when it is green the heartbeat shows *Up* with a fresh ping. Record the date in the runbook's restore drill log notes.

## Self-review

**Audit item → task**

| Item (from the brief) | Tasks |
|---|---|
| 1. B6 alert state persisted before delivery; missing Slack URL surfaced on /admin/health | 1, 2 |
| 2. B6 conditions: `cron.partial_streak`, `drain.failed` (+ drain read in the sweep), `backfill.failed` (throttled source, both backfill routes), `config.statement_timeout_unbounded`, `stripe.unattributed`, `embedding.backlog` | 3, 4, 5, 6, 7 |
| 3. B6/B11 env contract, `.env.example` coverage with a pure smoke, README env table and quick start, `DEMO_ACCOUNT_USER_ID` comments, `docs/performance.md` | 8, 9 (README Database row for `db:push:DANGEROUS` in 12) |
| 4a. `linkedin_slug` guard via `pg_get_expr` | 10 |
| 4b. DDL fingerprint beside the version (`schema_migrations.fingerprint`) | 11 |
| 4c. `drizzle.config.ts` refuses without `ALLOW_DRIZZLE_PUSH=1` or at `PRODUCTION_DB_HOST` | 12 |
| 4d. Runtime lease wait capped at 20 s; `scripts/migrate.ts` keeps the long wait | 13 |
| 5. B13 sync concurrency 4, 20 per run, `oldestDueAgeMs` in `cron_runs`, `sync.lagging` at 2 h | 14, 15 |
| 6. B13 admin aggregates | 16 (decision recorded there) |
| 7. B13 Playwright, CI job, five flows | 20, 21, 22, 23, 24 |
| 8. 60-day runbook, `internalFetch` timeout, one process-stalled schedule | 17, 18 |
| 9. `/api/health?token=<wrong>` → 401 | 19 |
| 3a handoff: `embedding.backlog` (reconciled with the old `ai.embedding_backlog`: one id, 3a's name and six-hour rule) | 7 |
| 3a handoff: `embedding.unembeddable`, `ai.quota_failures` (one read) | 25 |
| 3a handoff: `calendar.disarmed` (a burst of 5, kept apart from the existing per-account `sync.failing`) | 26 |
| 3a handoff: `avatar.source_exhausted`, `apollo.hosted_cap_hits` (one `rate_limit_buckets` read, thresholds from `RATE_LIMITS`) | 27 |
| `backup.stale` (deferred from Phase 0): heartbeat step after the upload, smoke asserts the order, secret documented, monitor in Manual step 11 | 28 |

**Deliberate departures from the brief, with reasons**
- Item 6: neither "bound to 90 days" (changes the meaning of all-time totals, the funnel and the activation date) nor "a nightly table" (a second schema change plus a purge-registry entry plus live deltas for new signups). Task 16 memoises the five aggregate scans for ten minutes for the overview only; every number keeps its meaning and is at most ten minutes old.
- Item 7: no `src/lib/ai-fixtures.ts` and no edit to `src/lib/ai.ts`. A local Gemini stub reached through `GOOGLE_GEMINI_BASE_URL` gives the same seam with zero app changes and nothing in 3a's files.
- Item 7: the suite gates PRs in CI (demo mode under `next dev`), not Vercel previews, because previews run Clerk and demo mode is dev-only.
- Item 9: only a present `?token=` changes behaviour; a wrong bearer header still gets the shallow view, as the brief specified.
- 3a's `embedding.backlog` replaces this plan's earlier `ai.embedding_backlog` (Task 7 now uses 3a's id and six-hour rule; the oldest age stays in the detail), so there is one condition, not two.
- `calendar.disarmed` overlaps the existing `sync.failing`. Both stay: `sync.failing` is the per-account warning, `calendar.disarmed` is info at a burst of five (`CALENDAR_DISARM_BURST`), which is the only case 3a's reason covers. `UNEMBEDDABLE_SPIKE = 10` and the burst of five are starting values; 3a gave no number.
- `backup.stale` is not an ops-sweep condition: a workflow that stops running cannot report itself, so Better Stack owns it, the same split as the sweep's own heartbeat.
- Not in this plan: B7's "pgvector smoke against a Neon branch in CI" (needs a Neon API key in CI and was not in the brief's list); B11's `logging.serverFunctions: false` (Phase 0 owns "B11 dev logging").

**Unverified in code (checked at execution by the task's own run)**
- The brief refers to a runtime `schemaFingerprint()`; none exists at `33a213c`. Task 11 creates it.
- Postgres's rendering of the `linkedin_slug` expression is verified only on PGlite (Task 10's smoke). If Neon renders it differently the guard falls back to today's rewrite — safe, but the lock-free win would be lost; check the first production migrate log for the absence of a long `contacts` rewrite.
- The Gemini stub's request path and response shape are inferred from `@google/genai` 2.12.0 source, not exercised in this repo; Task 21 is the proof.
- Playwright's `webServer.env` is assumed to merge over `process.env` (Stripe keys reaching the dev server in Task 24).
- Whether Vercel keeps running `/api/sync/run` after the kicking side aborts at 10 s (Task 17). The kick is best-effort by design either way.
- `/admin` UI is unreachable in demo mode (404 without Clerk), so no admin UI was changed; the new conditions appear in the existing "Open alerts" panel.
- Tasks 25 and 27 are written against Phase 3a's plan text (table `embedding_failures`, error kind `quota`, bucket names `avatarSource.shared:<source>` and `apollo.<kind>:<userId>`, `RATE_LIMITS` keys), not merged code. If 3a renames any of them, follow its code.
- Task 28 is written against Phase 0 Task 7's `backup.yml` and `scripts/smoke-backup-workflow.ts` as that plan defines them (`stepAt`, `uploadAt`, `pageAt`).
- Phases 0–2 and 3a were not merged when this was written; their edits to `schemaIsCurrent`, `recordSchemaVersion`, the Stripe route, the health route and the ops snapshot must be kept when these tasks land.

**Placeholder and name check.** No TBD or "similar to Task N" steps. Names used across tasks: `PARTIAL_STREAK`, `processStalledRecent`, `cron.drain`, `missingExpectedEnv`/`missingExpected`, `backfillFailures24h`, `statementTimeout`, `stripeUnattributed24h`, `syncOldestDueAgeMs`, `recordBackfillFailure`, `oldestDueAgeMs`, `runSettledPool`, `SYNC_CONCURRENCY`, `schemaFingerprint`, `isSchemaCurrent`, `checkDrizzleCommand`, `BUILD_MIGRATION_LOCK_WAIT_MS`, `RUNTIME_MIGRATION_LOCK_WAIT_MS`, `ReconcileOptions`, `ADMIN_AGGREGATES_TTL_MS`, `INTERNAL_FETCH_TIMEOUT_MS`, `healthTokenState`, `ensureOnboarded`, `createContact`, `embeddingBacklog`, `EMBEDDING_BACKLOG_STALE_HOURS`, `aiRefusals24h`, `UNEMBEDDABLE_SPIKE`, `calendarDisarmed`, `CALENDAR_DISARM_BURST`, `sharedBudgets` — each is defined in the task that introduces it and spelled the same wherever it is used. Task 16's code block marks where the existing five `select` expressions are moved verbatim; that is a move, not missing code.
