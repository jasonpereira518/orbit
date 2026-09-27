# Launch Phase 2 — Trust the Money and the Deletes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paying user is never left on the free plan or re-granted by a stale Stripe event, and every deletion Orbit promises (account, category, contact, connection, photo, recruiter details) finishes, is revoked upstream where possible, and can be exported first.
**Architecture:** Stripe fulfilment splits into the existing pure decision (`decideStripeEvent`) and one shared apply module (`src/lib/stripe-fulfilment.ts`). The webhook and a new verify-on-return server action both use that module, protected by a processed-event ledger and a per-account subscription clock. Deletion becomes a recorded run (`data_purge_runs`) that the nightly job resumes. The same category registry in `src/lib/user-data.ts` also drives a streamed export, contact deletion cleans every structured row tied to the person, and recruiter contact details move onto each user's own link.
**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle over Neon (neon-http) / PGlite, Clerk, Stripe, tsx smoke scripts
**Spec:** docs/production-readiness-audit-2026-09-15.md (items: B2 verify-on-return, B2 ordering + dedupe + MRR retry safety + customer-id uniqueness, B3 resumable purge, B3 missed-webhook reconciliation, B3 revoke on disconnect, B3 avatar cleanup, A8 proper + B3 recruiter cleanup, B10 export, B10 per-contact deletion)
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

- **Branch `claude/launch-p2`, cut after Phase 1 merges.** This plan assumes Phases 0–1 landed: refunds and lost disputes revoke entitlement through new `MirrorInstruction` returns from `decideStripeEvent`; the Clerk `user.deleted` webhook calls `purgeUserData(userId, { keepSettings: false })`; a self-service "Delete my account" action exists; `toPublicRecruiter` unlocks PII only for pooled rows (A8 short-term). Line numbers below were verified on `33a213c`. Phases 0–1 edited some of these files, so **re-read every file before editing it** and anchor edits on the quoted code, not on the line number.
- **One schema bump for the whole phase, in Task 1.** No later task changes DDL or `SCHEMA_VERSION`. If a later task seems to need DDL, stop and raise it.
- `data_purge_runs` names its user column `target_user_id`, never `user_id`: `scripts/smoke-purge.ts` sweeps every table whose Drizzle columns include a `userId` property and requires zero rows after a purge, and the ledger must outlive the purge it records (the same convention as `admin_audit_log.target_user_id` and `webhook_deliveries.target_user_id`).
- External calls made during a deletion (Google token revoke, Vercel Blob `del`) are best-effort, time out within 5 s, and never throw into the delete path.
- PGlite is single-writer: stop this worktree's dev server before `npm run db:setup` or any script that writes `.data/pglite`. Smoke scripts use their own temp directory and are safe.

---

### Task 1: One schema bump for the whole phase

Adds every column, table and index Phase 2 needs, plus the one-time recruiter PII backfill.

**Decision on `user_settings.stripe_customer_id` uniqueness:** add a **partial** unique index `WHERE stripe_customer_id IS NOT NULL`, guarded by a production pre-flight query (Manual steps, M1). Justification from the code: `startProCheckout` passes `customer_email`, never `customer`, so Stripe creates a new Customer per subscription checkout and each id is born attached to one Orbit user; payment-mode Lifetime sessions carry no customer unless `customer_creation` is set, so many rows are legitimately NULL; dashboard-created subscriptions are attributed *through* `findUserIdByStripeCustomerId`, which resolves to the account that already holds the id. The code cannot produce a duplicate, but hand edits or a dashboard subscription carrying another user's `orbit_user_id` metadata could have. If one exists, `CREATE UNIQUE INDEX` fails, `reconcileSchema` records a failure, and `scripts/migrate.ts` refuses the deploy, which is loud but blocks every deploy. So the pre-flight query must return zero rows before this merges. Partial rather than plain because NULL is the common value and the index only needs to cover real ids. Once the index is live, a write that would link a second account to a customer throws, the webhook answers 500, and the `webhook.invalid_streak:stripe` alert fires. Misattributed money becomes visible instead of silent.

**Files:**
- Modify: `src/db/schema.ts` — `userSettings` (starts line 88; add a column after `subscriptionInterval` near line 240; add an index callback at the table's closing `});` after `suspendedBy`, line ~297), `recruiters` (1676–1701), `userRecruiterLinks` (1704–1760), append two tables after the last line (3883).
- Modify: `src/db/index.ts` — DDL template `user_settings` (line 65 `subscription_interval text,`), `recruiters` (501–517), `user_recruiter_links` (522–541), after line 768 (`webhook_deliveries_type_created_idx`), end of `alters` (line 2662, the `target_companies_user_company_uidx` entry), `SCHEMA_VERSION` changelog (lines 1394–1406).
- Modify: `scripts/setup-db.ts` — `EXPECTED_TABLES` (line 12).
- Modify (generated): `scripts/schema-ddl.lock.json`.
- Create: `scripts/smoke-launch-p2-schema.ts`.
- Modify: `scripts/run-smoke.ts` — `MANIFEST` (line 29).

**Interfaces**
- Consumes: nothing.
- Produces (Drizzle, `@/db/schema`):
  - `userSettings.subscriptionEventAt: Date | null` (column `subscription_event_at timestamptz`).
  - Index `user_settings_stripe_customer_uidx` on `user_settings(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL`.
  - `stripeProcessedEvents` → `{ eventId: string; eventType: string; processedAt: Date }`; type `StripeProcessedEventRow`.
  - `dataPurgeRuns` → `{ id: string; targetUserId: string; categories: string[]; keepSettings: boolean; fullPurge: boolean; completedSteps: string[]; status: "running" | "done" | "failed"; attempts: number; lastError: string | null; requestedAt: Date; lastAttemptAt: Date; finishedAt: Date | null }`; type `DataPurgeRunRow`.
  - `recruiters.createdByUserId: string | null`.
  - `userRecruiterLinks.email / phone / linkedinUrl: string | null`.

- [ ] **Step 1: Compute the version number**

```bash
git fetch -q --all && for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do git show "${b}:src/db/index.ts" 2>/dev/null | grep -oE 'export const SCHEMA_VERSION = [0-9]+'; done | grep -oE '[0-9]+$' | sort -n | tail -1
```

Write down **N = printed value + 1**. Every `<N>` below means that literal integer. (Expect at least 57.)

- [ ] **Step 2: Write the failing smoke test**

Create `scripts/smoke-launch-p2-schema.ts`:

```ts
/**
 * Pins the launch Phase 2 schema: the Stripe ordering clock and processed-event ledger, the
 * one-customer-one-account index, the purge-run ledger, per-link recruiter PII, and the
 * one-time recruiter PII backfill.
 *
 * The backfill is exercised the only way it ever runs for real: rows written in the old
 * shape, the recorded version rewound by one, and the sweep re-run.
 *
 * Run: npx tsx scripts/smoke-launch-p2-schema.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { SCHEMA_VERSION, getDb, reconcileSchema, rowsOf } from "../src/db";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function columnsOf(table: string): Promise<Set<string>> {
  const db = await getDb();
  const res = await db.execute(
    sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`
  );
  return new Set(rowsOf<{ column_name: string }>(res).map((r) => r.column_name));
}

type LinkPii = { email: string | null; phone: string | null; linkedin_url: string | null };

async function linkPii(recruiterId: string, userId: string): Promise<LinkPii | undefined> {
  const db = await getDb();
  const res = await db.execute(
    sql`SELECT email, phone, linkedin_url FROM user_recruiter_links WHERE recruiter_id = ${recruiterId}::uuid AND user_id = ${userId}`
  );
  return rowsOf<LinkPii>(res)[0];
}

async function creatorOf(recruiterId: string): Promise<string | null> {
  const db = await getDb();
  const res = await db.execute(
    sql`SELECT created_by_user_id FROM recruiters WHERE id = ${recruiterId}::uuid`
  );
  return rowsOf<{ created_by_user_id: string | null }>(res)[0]?.created_by_user_id ?? null;
}

async function rerunSweep() {
  const db = await getDb();
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`);
  const result = await reconcileSchema();
  check("the sweep re-ran", result.applied === true, JSON.stringify(result));
  check(
    "no DDL statement failed",
    result.failed.length === 0,
    result.failed.map((f) => `${f.statement} -> ${f.message}`).join("; ")
  );
}

async function main() {
  const db = await getDb();

  console.log("New columns and tables");
  check("user_settings.subscription_event_at", (await columnsOf("user_settings")).has("subscription_event_at"));
  const processed = await columnsOf("stripe_processed_events");
  for (const c of ["event_id", "event_type", "processed_at"]) {
    check(`stripe_processed_events.${c}`, processed.has(c));
  }
  const runs = await columnsOf("data_purge_runs");
  for (const c of [
    "id",
    "target_user_id",
    "categories",
    "keep_settings",
    "full_purge",
    "completed_steps",
    "status",
    "attempts",
    "last_error",
    "requested_at",
    "last_attempt_at",
    "finished_at",
  ]) {
    check(`data_purge_runs.${c}`, runs.has(c));
  }
  check("data_purge_runs has no user_id column (smoke-purge would sweep it)", !runs.has("user_id"));
  check("recruiters.created_by_user_id", (await columnsOf("recruiters")).has("created_by_user_id"));
  const links = await columnsOf("user_recruiter_links");
  for (const c of ["email", "phone", "linkedin_url"]) {
    check(`user_recruiter_links.${c}`, links.has(c));
  }

  console.log("\nOne Stripe customer, one account");
  await db.execute(
    sql`INSERT INTO user_settings (user_id, stripe_customer_id) VALUES ('smoke-p2-a', 'cus_smoke_p2_dupe'), ('smoke-p2-n1', NULL), ('smoke-p2-n2', NULL)`
  );
  check("any number of accounts can have no Stripe customer", true);
  let rejected = false;
  try {
    await db.execute(
      sql`INSERT INTO user_settings (user_id, stripe_customer_id) VALUES ('smoke-p2-b', 'cus_smoke_p2_dupe')`
    );
  } catch {
    rejected = true;
  }
  check("a second account cannot claim the same Stripe customer", rejected);

  console.log("\nRecruiter PII backfill");
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  const at = (ms: number) => new Date(base + ms).toISOString();
  const sole = randomUUID();
  const shared = randomUUID();
  const gmail = randomUUID();
  await db.execute(
    sql`INSERT INTO recruiters (id, full_name, name_normalized, email, email_normalized, created_at) VALUES (${sole}::uuid, 'Sole Smoke', 'sole smoke', 'sole@p2.test', 'sole@p2.test', ${at(0)}::timestamptz)`
  );
  await db.execute(
    sql`INSERT INTO recruiters (id, full_name, name_normalized, email, email_normalized, phone, linkedin_url, created_at) VALUES (${shared}::uuid, 'Shared Smoke', 'shared smoke', 'shared@p2.test', 'shared@p2.test', '+1 555 0100', 'https://www.linkedin.com/in/shared-smoke', ${at(0)}::timestamptz)`
  );
  await db.execute(
    sql`INSERT INTO recruiters (id, full_name, name_normalized, email, email_normalized, created_at) VALUES (${gmail}::uuid, 'Gmail Smoke', 'gmail smoke', 'gmail@p2.test', 'gmail@p2.test', ${at(0)}::timestamptz)`
  );
  const link = (recruiterId: string, userId: string, source: string, offsetMs: number) =>
    db.execute(
      sql`INSERT INTO user_recruiter_links (user_id, recruiter_id, source, created_at) VALUES (${userId}, ${recruiterId}::uuid, ${source}, ${at(offsetMs)}::timestamptz)`
    );
  await link(sole, "smoke-p2-u1", "manual", 60_000);
  await link(shared, "smoke-p2-u2", "manual", 30_000);
  await link(shared, "smoke-p2-u3", "manual", 2 * 86_400_000);
  await link(gmail, "smoke-p2-u4", "manual", 60_000);
  await link(gmail, "smoke-p2-u5", "gmail", 3 * 86_400_000);

  await rerunSweep();

  check("the sole linker is recorded as the creator", (await creatorOf(sole)) === "smoke-p2-u1");
  check("...and gets the email on their own link", (await linkPii(sole, "smoke-p2-u1"))?.email === "sole@p2.test");
  check("the earliest linker within 120 seconds is the creator", (await creatorOf(shared)) === "smoke-p2-u2");
  const creatorLink = await linkPii(shared, "smoke-p2-u2");
  check(
    "...and gets every shared field",
    creatorLink?.email === "shared@p2.test" &&
      creatorLink?.phone === "+1 555 0100" &&
      creatorLink?.linkedin_url === "https://www.linkedin.com/in/shared-smoke",
    JSON.stringify(creatorLink)
  );
  const laterLink = await linkPii(shared, "smoke-p2-u3");
  check(
    "a later manual linker gets nothing they did not contribute",
    laterLink?.email === null && laterLink?.phone === null && laterLink?.linkedin_url === null,
    JSON.stringify(laterLink)
  );
  const gmailLink = await linkPii(gmail, "smoke-p2-u5");
  check("a Gmail-scan linker gets the address it matched on", gmailLink?.email === "gmail@p2.test");
  check("...and nothing else", gmailLink?.phone === null && gmailLink?.linkedin_url === null);
  const sharedRow = rowsOf<{ email: string | null }>(
    await db.execute(sql`SELECT email FROM recruiters WHERE id = ${shared}::uuid`)
  )[0];
  check("the shared value itself is left in place", sharedRow?.email === "shared@p2.test");

  await db.execute(
    sql`UPDATE user_recruiter_links SET email = 'mine@p2.test' WHERE recruiter_id = ${sole}::uuid AND user_id = 'smoke-p2-u1'`
  );
  await rerunSweep();
  check(
    "a re-run never overwrites what a user put on their own link",
    (await linkPii(sole, "smoke-p2-u1"))?.email === "mine@p2.test"
  );

  await db.execute(sql`DELETE FROM recruiters WHERE id IN (${sole}::uuid, ${shared}::uuid, ${gmail}::uuid)`);
  await db.execute(sql`DELETE FROM user_settings WHERE user_id IN ('smoke-p2-a', 'smoke-p2-n1', 'smoke-p2-n2')`);
  console.log("\nAll Phase 2 schema checks passed.");
}

run(main);
```

- [ ] **Step 3: Register it and watch it fail**

In `scripts/run-smoke.ts`, add to `MANIFEST` in the pglite section (next to `"smoke-schema-upgrade": "pglite",`):

```ts
  "smoke-launch-p2-schema": "pglite",
```

Run: `npx tsx scripts/smoke-launch-p2-schema.ts`
Expected: exits 1 with `user_settings.subscription_event_at failed`.

- [ ] **Step 4: Declare the columns and tables in `src/db/schema.ts`**

4a. In `userSettings`, directly after the `subscriptionInterval: text("subscription_interval").$type<"month" | "year">(),` line, add:

```ts
  /**
   * `created` of the newest Stripe subscription event whose mirror write has been applied.
   *
   * Stripe does not deliver in order, and a retried `customer.subscription.updated` from
   * before a cancellation would otherwise re-grant Pro. `decideStripeEvent` ignores any
   * subscription-mirror event older than this (see `isStaleSubscriptionEvent`). Checkout
   * completions are gated by it but never advance it: Stripe stamps the subscription's own
   * events a second either side of the checkout, so letting checkout advance the clock would
   * make the real `customer.subscription.created` look stale.
   */
  subscriptionEventAt: timestamp("subscription_event_at", { withTimezone: true }),
```

4b. Replace the end of the `userSettings` table — this exact text:

```ts
  suspendedBy: text("suspended_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

with:

```ts
  suspendedBy: text("suspended_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  /**
   * One Stripe customer belongs to one account. Partial because NULL is the common value
   * (every free account, and Lifetime sessions that created no Customer). Checkout never
   * reuses a customer across accounts, so a violation means a hand edit or a dashboard
   * subscription carrying the wrong `orbit_user_id` — the webhook then 500s loudly instead
   * of `findUserIdByStripeCustomerId` silently picking one of two accounts.
   */
  uniqueIndex("user_settings_stripe_customer_uidx")
    .on(t.stripeCustomerId)
    .where(sql`${t.stripeCustomerId} is not null`),
]);
```

4c. In `recruiters`, replace:

```ts
    linkedinUrl: text("linkedin_url"),
    phone: text("phone"),
    avgRating: integer("avg_rating").default(0).notNull(),
```

with:

```ts
    linkedinUrl: text("linkedin_url"),
    phone: text("phone"),
    /**
     * Who created this canonical row. Backfilled from the earliest link written within 120
     * seconds of the row (Phase 0's `CREATOR_LINK_WINDOW_SECONDS`); null means the creator could not be determined (legacy rows).
     * `rederiveSharedRecruiterPii` treats a non-null creator as "every shared contact field
     * must be vouched for by a pooled link". Set to `deleted-account` when the creator's data
     * is purged, so the strict rule keeps applying.
     */
    createdByUserId: text("created_by_user_id"),
    avgRating: integer("avg_rating").default(0).notNull(),
```

4d. In `userRecruiterLinks`, directly after `gmailThreadId: text("gmail_thread_id"),`, add:

```ts
    /**
     * This user's own contact details for the recruiter. Contact details live HERE, per link:
     * the canonical `recruiters` row carries only what sharing users contributed to the pool.
     * `toPublicRecruiter` reads these first, then pooled values (audit A8).
     */
    email: text("email"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
```

4e. Append at the very end of the file:

```ts
/**
 * Stripe event ids whose effects have been applied — the webhook's dedupe ledger.
 *
 * Separate from `webhook_deliveries` on purpose: that table deliberately has NO unique index
 * on (source, event_id), because the retry count is the most useful thing it records.
 * Only `handled` outcomes are written here, so an event that was ignored for a reason that
 * can change (an unattributed customer) is still re-evaluated when Stripe retries it. No user
 * column: nothing here identifies a person.
 */
export const stripeProcessedEvents = pgTable("stripe_processed_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * One row per `purgeUserData` call: the ledger that makes a deletion resumable.
 *
 * `completed_steps` grows as each step lands, so the nightly job re-runs only what is left
 * (every step is an idempotent WHERE-user delete). After `PURGE_MAX_ATTEMPTS` the run is
 * marked `failed` and the ops sweep raises `purge.stuck`.
 *
 * `target_user_id`, not `user_id`: `scripts/smoke-purge.ts` sweeps every table with a
 * `userId` column and requires zero rows after a purge, and this record must outlive the
 * purge it describes — the same convention as `admin_audit_log.target_user_id`. A Clerk id
 * is inert once the account is gone; finished runs are pruned after 30 days.
 */
export const dataPurgeRuns = pgTable(
  "data_purge_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    targetUserId: text("target_user_id").notNull(),
    categories: jsonb("categories").$type<string[]>().default([]).notNull(),
    keepSettings: boolean("keep_settings").default(true).notNull(),
    fullPurge: boolean("full_purge").default(false).notNull(),
    completedSteps: jsonb("completed_steps").$type<string[]>().default([]).notNull(),
    status: text("status").$type<"running" | "done" | "failed">().default("running").notNull(),
    attempts: integer("attempts").default(1).notNull(),
    lastError: text("last_error"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("data_purge_runs_status_attempt_idx").on(t.status, t.lastAttemptAt),
    index("data_purge_runs_target_idx").on(t.targetUserId),
  ]
);

export type StripeProcessedEventRow = typeof stripeProcessedEvents.$inferSelect;
export type DataPurgeRunRow = typeof dataPurgeRuns.$inferSelect;
```

- [ ] **Step 5: Add the DDL in `src/db/index.ts`**

5a. In the `DDL` template's `CREATE TABLE IF NOT EXISTS user_settings`, replace `  subscription_interval text,` (line 65) with:

```sql
  subscription_interval text,
  subscription_event_at timestamptz,
```

5b. In `CREATE TABLE IF NOT EXISTS recruiters`, replace `  phone text,\n  avg_rating integer NOT NULL DEFAULT 0,` (lines 511–512) with:

```sql
  phone text,
  created_by_user_id text,
  avg_rating integer NOT NULL DEFAULT 0,
```

5c. In `CREATE TABLE IF NOT EXISTS user_recruiter_links`, replace `  gmail_thread_id text,` (line 538) with:

```sql
  gmail_thread_id text,
  email text,
  phone text,
  linkedin_url text,
```

5d. Directly after line 768 (`CREATE INDEX IF NOT EXISTS webhook_deliveries_type_created_idx ON webhook_deliveries(event_type, created_at);`), insert:

```sql
CREATE TABLE IF NOT EXISTS stripe_processed_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS data_purge_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id text NOT NULL,
  categories jsonb NOT NULL DEFAULT '[]',
  keep_settings boolean NOT NULL DEFAULT true,
  full_purge boolean NOT NULL DEFAULT false,
  completed_steps jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'running',
  attempts integer NOT NULL DEFAULT 1,
  last_error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS data_purge_runs_status_attempt_idx ON data_purge_runs(status, last_attempt_at);
CREATE INDEX IF NOT EXISTS data_purge_runs_target_idx ON data_purge_runs(target_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_settings_stripe_customer_uidx ON user_settings(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
```

(The template's index statements run after `alters` on every sweep, so the unique index needs no `alters` twin; `stripe_customer_id` exists on every database since long before this version.)

- [ ] **Step 6: Add the columns and the backfill to `alters`**

Replace the last entry of `alters` (line 2662):

```ts
  `CREATE UNIQUE INDEX IF NOT EXISTS target_companies_user_company_uidx ON target_companies(user_id, company_id)`,
];
```

with:

```ts
  `CREATE UNIQUE INDEX IF NOT EXISTS target_companies_user_company_uidx ON target_companies(user_id, company_id)`,
  // Launch Phase 2. Columns first, then the one-time recruiter PII backfill, whose statements
  // read the columns they fill. Each backfill statement only fills what is still null, so a
  // re-run on any later version bump changes nothing.
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS subscription_event_at timestamptz`,
  `ALTER TABLE recruiters ADD COLUMN IF NOT EXISTS created_by_user_id text`,
  `ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS email text`,
  `ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS phone text`,
  `ALTER TABLE user_recruiter_links ADD COLUMN IF NOT EXISTS linkedin_url text`,
  // The creator is the earliest link written within 120 seconds of the canonical row (the same window as the Phase 0 runtime rule), since
  // upsertCanonicalRecruiter and ensureUserLink run back to back in one request.
  `UPDATE recruiters r SET created_by_user_id = f.user_id FROM (SELECT DISTINCT ON (l.recruiter_id) l.recruiter_id, l.user_id FROM user_recruiter_links l JOIN recruiters r2 ON r2.id = l.recruiter_id WHERE l.created_at <= r2.created_at + interval '120 seconds' ORDER BY l.recruiter_id, l.created_at) f WHERE r.id = f.recruiter_id AND r.created_by_user_id IS NULL`,
  // The creator, or the only linker, is who put the shared details there, so they go onto that link.
  // Anything else stays on the shared row only: its contributor cannot be determined.
  `UPDATE user_recruiter_links l SET email = COALESCE(l.email, r.email), phone = COALESCE(l.phone, r.phone), linkedin_url = COALESCE(l.linkedin_url, r.linkedin_url) FROM recruiters r WHERE r.id = l.recruiter_id AND (r.email IS NOT NULL OR r.phone IS NOT NULL OR r.linkedin_url IS NOT NULL) AND (l.user_id = r.created_by_user_id OR NOT EXISTS (SELECT 1 FROM user_recruiter_links o WHERE o.recruiter_id = l.recruiter_id AND o.id <> l.id))`,
  // A Gmail-scan link matched this row by the sender address first, so that address is almost
  // always the one in this user's own mailbox.
  `UPDATE user_recruiter_links l SET email = r.email FROM recruiters r WHERE r.id = l.recruiter_id AND l.source = 'gmail' AND l.email IS NULL AND r.email IS NOT NULL`,
];
```

- [ ] **Step 7: Bump `SCHEMA_VERSION`**

Replace `export const SCHEMA_VERSION = 55;` (or whatever main now carries) together with nothing else, by:

```ts
//
// <N> = launch Phase 2: user_settings.subscription_event_at (the Stripe ordering clock) and
// the partial unique index on user_settings.stripe_customer_id, stripe_processed_events
// (webhook dedupe), data_purge_runs (the resumable deletion ledger), and
// recruiters.created_by_user_id plus user_recruiter_links.email/phone/linkedin_url with
// their one-time PII backfill in alters.
export const SCHEMA_VERSION = <N>;
```

- [ ] **Step 8: Expect the tables in setup**

In `scripts/setup-db.ts`, add to the `EXPECTED_TABLES` array directly after `"user_settings",`:

```ts
  "stripe_processed_events",
  "data_purge_runs",
```

- [ ] **Step 9: Regenerate the DDL fingerprint and run everything**

```bash
npx tsx scripts/smoke-schema-ddl.ts --update
npx tsx scripts/smoke-schema-ddl.ts
npx tsx scripts/smoke-schema-upgrade.ts
npx tsx scripts/smoke-launch-p2-schema.ts
npx tsx scripts/smoke-purge.ts
npm run db:setup
npm run typecheck
npm run lint
```

Expected: every smoke prints its `ok` lines and exits 0 (`smoke-schema-upgrade` confirms every index declared in `schema.ts` exists, which covers the three new indexes). `npm run db:setup` prints a table list that includes `stripe_processed_events` and `data_purge_runs`. Typecheck and lint show 0 errors.

- [ ] **Step 10: Commit**

```bash
git add src/db/schema.ts src/db/index.ts scripts/setup-db.ts scripts/schema-ddl.lock.json scripts/smoke-launch-p2-schema.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Add the launch Phase 2 schema: Stripe clock and dedupe, purge ledger, per-link recruiter PII

One version bump for the phase. Backfills each recruiter's creator and copies shared
contact details onto the links of the users who contributed them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Shared Stripe apply module, event dedupe, and bookings before the mirror

The webhook's apply half moves into `src/lib/stripe-fulfilment.ts` so the verify-on-return path (Task 4) can reuse it. Two correctness fixes land with it:

- **Dedupe.** A handled event id goes into `stripe_processed_events`. A later delivery of the same id answers 200 and is recorded as `ignored / duplicate_event`, without touching anything.
- **MRR retry safety.** Today the route writes the mirror first and then books with `recordBillingEvent`, which swallows errors. A lost booking is lost forever, because the retry reads the new mirror as "before" and computes no movement. Now bookings are written first with the throwing `recordBillingEventStrict`, and only then the mirror. A failure leaves the mirror untouched, so Stripe's retry re-derives the same `beforeCents` and the same keyed bookings, and the unique `(source, event_id)` index drops whichever already landed. No processed-events lookup is needed to get `beforeCents` right.

**Files:**
- Create: `src/lib/stripe-fulfilment.ts`
- Modify: `src/app/api/webhooks/stripe/route.ts` (whole file, lines 1–203)
- Modify: `src/lib/webhook-deliveries.ts` (`WEBHOOK_REASONS`, lines 17–34)
- Modify: `scripts/smoke-stripe-webhook.ts` (`reset()` lines 258–273; `proSession` lines 356–362; final cleanup lines 757–761)
- Create: `scripts/smoke-stripe-dedupe.ts`
- Modify: `scripts/run-smoke.ts`

**Interfaces**
- Consumes: `stripeProcessedEvents` (Task 1); `decideStripeEvent`, `stripeEventSubject`, `Booking`, `DecideContext`, `StripeDecision` from `src/lib/billing-stripe.ts`; `recordBillingEventStrict`, `monthlyValueCents`, `hasPriorRevenue` from `src/lib/billing-events.ts`; `setLifetimePurchase`, `setSubscriptionState`, `findUserIdByStripeCustomerId` from `src/lib/user-settings.ts`.
- Produces (`src/lib/stripe-fulfilment.ts`):
  - `attributeStripeEvent(event: Stripe.Event): Promise<string | null>`
  - `readDecideContext(event: Stripe.Event, now: Date): Promise<DecideContext>`
  - `type StripeApplyDeps = { book: (booking: Booking) => Promise<unknown>; setLifetime: typeof setLifetimePurchase; setSubscription: typeof setSubscriptionState }`
  - `defaultStripeApplyDeps: StripeApplyDeps`
  - `applyStripeDecision(decision: StripeDecision, deps?: StripeApplyDeps): Promise<void>`
  - `isStripeEventProcessed(eventId: string): Promise<boolean>`
  - `markStripeEventProcessed(eventId: string, eventType: string): Promise<void>`
  - `WEBHOOK_REASONS.duplicateEvent = "duplicate_event"`.

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-stripe-dedupe.ts`:

```ts
/**
 * Stripe webhook dedupe and the bookings-before-mirror order (launch Phase 2, audit B2).
 *
 *   - A handled event id is recorded once; a redelivery answers 200 and changes nothing.
 *   - An ignored event is NOT recorded, so a retry after the cause is fixed still applies.
 *   - A booking that cannot be written leaves the mirror untouched, so the retry computes
 *     the same "before" and books exactly once.
 *
 * Run: npx tsx scripts/smoke-stripe-dedupe.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const TEST_SECRET = "whsec_test_smoke_dedupe_only";
process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
process.env.STRIPE_SECRET_KEY ||= "sk_test_smoke_only_not_a_real_key";

import Stripe from "stripe";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  billingEvents,
  stripeProcessedEvents,
  userSettings,
  webhookDeliveries,
} from "../src/db/schema";
import { POST } from "../src/app/api/webhooks/stripe/route";
import { decideStripeEvent } from "../src/lib/billing-stripe";
import {
  applyStripeDecision,
  defaultStripeApplyDeps,
  readDecideContext,
} from "../src/lib/stripe-fulfilment";
import { ensureUserSettings } from "../src/lib/user-settings";
import {
  LIFETIME_METADATA_KEY,
  PRO_METADATA_VALUE,
  SUBSCRIPTION_USER_METADATA_KEY,
} from "../src/lib/stripe";

const USER = "smoke-dedupe-user";
const TEAR_USER = "smoke-dedupe-tear-user";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function signed(event: unknown) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_SECRET });
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

const post = (req: Request) => POST(req as unknown as Parameters<typeof POST>[0]);

let seq = 0;
function subEvent(
  type: string,
  userId: string,
  over: Record<string, unknown> = {},
  created?: number
) {
  seq += 1;
  return {
    id: `evt_smoke_dedupe_${seq}`,
    object: "event",
    type,
    ...(created !== undefined ? { created } : {}),
    data: {
      object: {
        id: `sub_${userId}`,
        object: "subscription",
        status: "active",
        customer: `cus_${userId}`,
        metadata: {
          [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE,
          [SUBSCRIPTION_USER_METADATA_KEY]: userId,
        },
        items: {
          data: [
            {
              id: `si_${userId}`,
              quantity: 1,
              current_period_end: Math.floor(Date.now() / 1000) + 20 * 86400,
              price: { id: "price_smoke", unit_amount: 500, recurring: { interval: "month", interval_count: 1 } },
            },
          ],
        },
        ...over,
      },
    },
  };
}

async function settingsFor(userId: string) {
  const db = await getDb();
  return db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
}

async function ledgerFor(userId: string) {
  const db = await getDb();
  return db.select().from(billingEvents).where(eq(billingEvents.userId, userId));
}

async function lastDelivery() {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.source, "stripe"))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(1);
  return row;
}

async function reset() {
  const db = await getDb();
  for (const u of [USER, TEAR_USER]) {
    await db.delete(billingEvents).where(eq(billingEvents.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
    await ensureUserSettings(u);
  }
  await db.delete(stripeProcessedEvents);
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.source, "stripe"));
}

async function main() {
  await reset();
  const db = await getDb();

  console.log("A handled event is applied once");
  const first = subEvent("customer.subscription.updated", USER);
  check("first delivery -> 200", (await post(signed(first))).status === 200);
  check("the plan was granted", (await settingsFor(USER))?.subscriptionStatus === "active");
  const processed = await db
    .select()
    .from(stripeProcessedEvents)
    .where(eq(stripeProcessedEvents.eventId, first.id));
  check("the event id was recorded as processed", processed.length === 1);
  const ledgerAfterFirst = (await ledgerFor(USER)).length;
  check("the new subscription booked one movement", ledgerAfterFirst === 1, String(ledgerAfterFirst));

  // Cancel in between, so a re-applied first event WOULD visibly re-grant.
  await post(signed(subEvent("customer.subscription.deleted", USER, { status: "canceled" })));
  check("the cancellation applied", (await settingsFor(USER))?.subscriptionStatus === "canceled");

  const again = await post(signed(first));
  check("a redelivery of a handled event -> 200", again.status === 200);
  check("...and does not re-grant", (await settingsFor(USER))?.subscriptionStatus === "canceled");
  const dup = await lastDelivery();
  check("...recorded as ignored / duplicate_event", dup?.outcome === "ignored" && dup?.reason === "duplicate_event", JSON.stringify(dup));

  console.log("\nAn ignored event stays retryable");
  const other = subEvent("customer.subscription.updated", USER, {
    metadata: { [LIFETIME_METADATA_KEY]: "something-else", [SUBSCRIPTION_USER_METADATA_KEY]: USER },
  });
  await post(signed(other));
  const otherProcessed = await db
    .select()
    .from(stripeProcessedEvents)
    .where(eq(stripeProcessedEvents.eventId, other.id));
  check("an ignored event is not recorded as processed", otherProcessed.length === 0);

  console.log("\nA booking that cannot be written leaves the mirror alone");
  const tearEvent = subEvent("customer.subscription.updated", TEAR_USER) as unknown as Stripe.Event;
  const ctx1 = await readDecideContext(tearEvent, new Date());
  const decision1 = decideStripeEvent(tearEvent, ctx1);
  check("the decision books a movement and writes a mirror", decision1.bookings.length === 1 && decision1.mirror !== null);
  let threw = false;
  try {
    await applyStripeDecision(decision1, {
      ...defaultStripeApplyDeps,
      book: async () => {
        throw new Error("ledger unavailable");
      },
    });
  } catch {
    threw = true;
  }
  check("the apply throws (so the webhook answers 500 and Stripe retries)", threw);
  check("the mirror was not written", (await settingsFor(TEAR_USER))?.subscriptionPlan === null);

  const ctx2 = await readDecideContext(tearEvent, new Date());
  check("the retry sees the same 'before'", ctx2.beforeCents === ctx1.beforeCents, `${ctx1.beforeCents} vs ${ctx2.beforeCents}`);
  await applyStripeDecision(decideStripeEvent(tearEvent, ctx2));
  const tearLedger = await ledgerFor(TEAR_USER);
  check("the retry books exactly one movement", tearLedger.length === 1 && tearLedger[0]?.mrrDeltaCents === 500, JSON.stringify(tearLedger.map((r) => r.mrrDeltaCents)));
  check("...and then writes the mirror", (await settingsFor(TEAR_USER))?.subscriptionStatus === "active");

  await reset();
  console.log("\nAll Stripe dedupe checks passed.");
}

run(main);
```

- [ ] **Step 2: Register and watch it fail**

Add to `MANIFEST` in `scripts/run-smoke.ts` (pglite section, next to `"smoke-stripe-webhook": "pglite",`):

```ts
  "smoke-stripe-dedupe": "pglite",
```

Run: `npx tsx scripts/smoke-stripe-dedupe.ts`
Expected: fails at import time with `Cannot find module '../src/lib/stripe-fulfilment'`.

- [ ] **Step 3: Add the new delivery reason**

In `src/lib/webhook-deliveries.ts`, inside `WEBHOOK_REASONS`, directly after `handlerThrew: "handler_threw",` add:

```ts
  /** A Stripe event id already in `stripe_processed_events`; answered 200, nothing touched. */
  duplicateEvent: "duplicate_event",
```

- [ ] **Step 4: Create `src/lib/stripe-fulfilment.ts`**

Before writing, re-read `src/app/api/webhooks/stripe/route.ts` lines 145–167 on this branch. If Phase 0 added `if/else` branches for new `decision.mirror?.type` values (refund or dispute revocation), each must become a `case` in the `switch` below with its body copied verbatim. The `never` check in `default` fails typecheck until every variant is handled.

```ts
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { stripeProcessedEvents, userSettings } from "@/db/schema";
import {
  hasPriorRevenue,
  monthlyValueCents,
  recordBillingEventStrict,
} from "@/lib/billing-events";
import {
  stripeEventSubject,
  type Booking,
  type DecideContext,
  type StripeDecision,
} from "@/lib/billing-stripe";
import {
  findUserIdByStripeCustomerId,
  setLifetimePurchase,
  setSubscriptionState,
} from "@/lib/user-settings";

/**
 * The half of Stripe fulfilment that touches the database, shared by the webhook
 * (`src/app/api/webhooks/stripe/route.ts`) and the verify-on-return action
 * (`confirmCheckoutSession` in `src/actions/billing.ts`).
 *
 * What an event MEANS stays in the pure `decideStripeEvent`. This module only reads the
 * context that decision needs and applies what it says, so the two entry points cannot drift.
 *
 * ORDER IS LOAD-BEARING: bookings first, strictly, then the mirror. `beforeCents` is read
 * from the mirror, so a mirror written before a booking that then fails would make every
 * retry compute "no movement" and lose the ledger row forever. Written this way round, a
 * failure leaves the mirror untouched, the retry derives the same keyed bookings, and the
 * unique (source, event_id) index drops whichever of them already landed.
 *
 * No `next/server` import: tsx smoke scripts load this module.
 */

/** Resolve an event to an account: payload hints first, then the stored customer link. */
export async function attributeStripeEvent(event: Stripe.Event): Promise<string | null> {
  const { userIdHint, customerId } = stripeEventSubject(event);
  if (userIdHint) return userIdHint;
  if (!customerId) return null;
  return findUserIdByStripeCustomerId(customerId);
}

/**
 * Everything `decideStripeEvent` needs to know about the present, read once and before
 * anything is written — the only moment both sides of a transition are knowable.
 */
export async function readDecideContext(
  event: Stripe.Event,
  now: Date
): Promise<DecideContext> {
  const userId = await attributeStripeEvent(event);
  if (!userId) return { userId: null, beforeCents: 0, hadPriorRevenue: false, now };

  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: {
      subscriptionPlan: true,
      subscriptionStatus: true,
      subscriptionPeriodEnd: true,
      subscriptionMonthlyCents: true,
    },
  });
  const beforeCents =
    row?.subscriptionPlan === "orbit"
      ? monthlyValueCents(
          row.subscriptionStatus,
          row.subscriptionPeriodEnd,
          now,
          row.subscriptionMonthlyCents
        )
      : 0;

  return {
    userId,
    beforeCents,
    // Only consulted when there is nothing to lose by asking: a 0-to-positive move is the
    // sole case where new and reactivation differ.
    hadPriorRevenue: beforeCents === 0 ? await hasPriorRevenue(userId) : false,
    now,
  };
}

export type StripeApplyDeps = {
  book: (booking: Booking) => Promise<unknown>;
  setLifetime: typeof setLifetimePurchase;
  setSubscription: typeof setSubscriptionState;
};

export const defaultStripeApplyDeps: StripeApplyDeps = {
  book: (booking) => recordBillingEventStrict({ source: "stripe", ...booking }),
  setLifetime: setLifetimePurchase,
  setSubscription: setSubscriptionState,
};

/** Apply a decision: every booking (throwing on failure), then the mirror. */
export async function applyStripeDecision(
  decision: StripeDecision,
  deps: StripeApplyDeps = defaultStripeApplyDeps
): Promise<void> {
  for (const booking of decision.bookings) {
    await deps.book(booking);
  }

  const mirror = decision.mirror;
  if (!mirror) return;

  switch (mirror.type) {
    case "lifetime":
      // Idempotent: `setLifetimePurchase` keeps the first timestamp.
      await deps.setLifetime(mirror.userId, { stripeCustomerId: mirror.stripeCustomerId });
      return;
    case "subscription":
      await deps.setSubscription(
        mirror.userId,
        {
          plan: mirror.plan,
          status: mirror.status,
          periodEnd: mirror.periodEnd,
          monthlyCents: mirror.monthlyCents,
          interval: mirror.interval,
        },
        { stripeCustomerId: mirror.stripeCustomerId }
      );
      return;
    default: {
      const unhandled: never = mirror;
      throw new Error(`Unhandled Stripe mirror instruction: ${JSON.stringify(unhandled)}`);
    }
  }
}

export async function isStripeEventProcessed(eventId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ eventId: stripeProcessedEvents.eventId })
    .from(stripeProcessedEvents)
    .where(eq(stripeProcessedEvents.eventId, eventId))
    .limit(1);
  return Boolean(row);
}

/** Called only after a `handled` decision has been fully applied. */
export async function markStripeEventProcessed(
  eventId: string,
  eventType: string
): Promise<void> {
  const db = await getDb();
  await db.insert(stripeProcessedEvents).values({ eventId, eventType }).onConflictDoNothing();
}
```

- [ ] **Step 5: Rewrite the route as a thin driver**

Replace the whole of `src/app/api/webhooks/stripe/route.ts` with the code below. Keep the existing header comment block (lines 28–51) verbatim where marked, and append the new paragraph shown.

```ts
import type { NextRequest } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { decideStripeEvent } from "@/lib/billing-stripe";
import { shouldRecordThrottled } from "@/lib/error-events";
import {
  applyStripeDecision,
  isStripeEventProcessed,
  markStripeEventProcessed,
  readDecideContext,
} from "@/lib/stripe-fulfilment";
import { WEBHOOK_REASONS, recordWebhookDelivery } from "@/lib/webhook-deliveries";

/**
 * (Existing header comment from lines 29–51 of 33a213c, unchanged, then:)
 *
 * DEDUPE, ORDER AND RETRIES. A delivery whose event id is already in
 * `stripe_processed_events` answers 200 and touches nothing. Only `handled` events are
 * recorded there, so an event ignored for a reason that can change is re-evaluated on
 * retry. Reading context and applying the decision live in `@/lib/stripe-fulfilment`,
 * which books before it mirrors: see that module for why a retry can never lose a row.
 */

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set; refusing webhook.");
    return new Response("Stripe webhook is not configured", { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  // Signature verification needs the exact bytes Stripe signed. Reading this as JSON and
  // re-serialising would change the payload and silently fail every signature, so the raw
  // text is read first and parsed only by the SDK.
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    // Includes replay attempts and stale secrets after a roll — both should be rejected.
    console.error("Stripe webhook verification failed:", err);
    // Recorded (once per hour, since this precedes authentication) so a rolled secret shows
    // up in the ledger the ops sweep reads. Stores nothing from the body.
    if (shouldRecordThrottled("webhook.stripe.invalid")) {
      await recordWebhookDelivery({
        source: "stripe",
        outcome: "invalid",
        reason: WEBHOOK_REASONS.signatureInvalid,
        error: err,
        durationMs: Date.now() - startedAt,
      });
    }
    return new Response("Verification failed", { status: 400 });
  }

  try {
    if (await isStripeEventProcessed(event.id)) {
      await recordWebhookDelivery({
        source: "stripe",
        eventId: event.id,
        eventType: event.type,
        outcome: "ignored",
        reason: WEBHOOK_REASONS.duplicateEvent,
        durationMs: Date.now() - startedAt,
      });
      return new Response("OK", { status: 200 });
    }

    const ctx = await readDecideContext(event, new Date());
    const decision = decideStripeEvent(event, ctx);
    await applyStripeDecision(decision);
    if (decision.outcome === "handled") {
      await markStripeEventProcessed(event.id, event.type);
    }

    if (decision.outcome === "ignored" && decision.reason === "missing_user_id") {
      console.error(
        `Stripe ${event.type} (${event.id}) could not be attributed to a user.`
      );
    }

    await recordWebhookDelivery({
      source: "stripe",
      eventId: event.id,
      eventType: event.type,
      outcome: decision.outcome,
      reason: decision.reason ?? null,
      targetUserId: decision.targetUserId,
      resourceId: decision.resourceId,
      detail: { bookings: decision.bookings.length },
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error(`Stripe webhook handler failed for ${event.id}:`, err);
    await recordWebhookDelivery({
      source: "stripe",
      eventId: event.id,
      eventType: event.type,
      outcome: "error",
      reason: WEBHOOK_REASONS.handlerThrew,
      error: err,
      durationMs: Date.now() - startedAt,
    });
    // Non-2xx so Stripe retries. Bookings are written before the mirror and are keyed, so the
    // retry derives the same rows and the unique index drops the ones that already landed.
    return new Response("Handler failed", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}
```

- [ ] **Step 6: Keep the existing webhook smoke honest about event ids**

`scripts/smoke-stripe-webhook.ts` reuses the event id `evt_smoke_1` for the Lifetime purchase and the Pro purchase (both built by `sessionEvent()`). Real Stripe event ids are unique, and with dedupe the Pro delivery would now be answered as a duplicate.

6a. Replace (lines 356–362):

```ts
  const proSession = sessionEvent({
    id: "cs_test_smoke_pro",
    client_reference_id: PRO_USER,
    customer: "cus_smoke_pro",
    mode: "subscription",
    metadata: { [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE },
  });
```

with:

```ts
  // Its own event id: real Stripe ids are unique, and the webhook now dedupes on them.
  const proSession = {
    ...sessionEvent({
      id: "cs_test_smoke_pro",
      client_reference_id: PRO_USER,
      customer: "cus_smoke_pro",
      mode: "subscription",
      metadata: { [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE },
    }),
    id: "evt_smoke_pro_checkout",
  };
```

6b. Add `stripeProcessedEvents` to the schema import on line 27 (`import { userSettings, billingEvents, webhookDeliveries, stripeProcessedEvents } from "../src/db/schema";`). In `reset()`, directly before `await ensureUserSettings(USER);`, add:

```ts
  await db.delete(stripeProcessedEvents);
```

6c. In the final cleanup, directly after `await db.delete(webhookDeliveries).where(eq(webhookDeliveries.source, "stripe"));` (line ~760), add:

```ts
  await db.delete(stripeProcessedEvents);
```

- [ ] **Step 7: Run and verify**

```bash
npx tsx scripts/smoke-stripe-dedupe.ts
npx tsx scripts/smoke-stripe-webhook.ts
npm run typecheck
npm run lint
```

Expected: both smokes exit 0. In `smoke-stripe-webhook`, "survives Stripe's retries" and "replaying checkout.session.completed adds no new ledger row" still pass, now through the dedupe short-circuit. 0 type or lint errors. If typecheck reports `Type '...' is not assignable to type 'never'` in `applyStripeDecision`, a Phase 0 mirror variant is unhandled: port its branch from the old route (Step 4 note).

- [ ] **Step 8: Commit**

```bash
git add src/lib/stripe-fulfilment.ts src/app/api/webhooks/stripe/route.ts src/lib/webhook-deliveries.ts scripts/smoke-stripe-webhook.ts scripts/smoke-stripe-dedupe.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Dedupe Stripe deliveries and book before mirroring so a retry cannot lose MRR

The apply half of the webhook moves to src/lib/stripe-fulfilment.ts for reuse by the
verify-on-return path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Ignore out-of-order subscription events

Adds a per-account clock, `user_settings.subscription_event_at`. A `customer.subscription.*` event whose `created` is older than the last applied one is ignored (`stale_subscription_event`), with no mirror write and no booking. A Pro checkout completion is gated by the clock but never advances it. At an equal second, a terminal (`deleted`) event beats a non-terminal one. Events with no `created` (only hand-built test fixtures) are never gated.

**Files:**
- Modify: `src/lib/billing-stripe.ts` — `MirrorInstruction` (68–80), `DecideContext` (91–99), `STRIPE_IGNORE_REASONS` (102–109), `decideStripeEvent` (301–504: checkout Pro branch 353–403, subscription branch 409–504)
- Modify: `src/lib/stripe-fulfilment.ts` (Task 2) — `readDecideContext`, `applyStripeDecision`
- Modify: `src/lib/user-settings.ts` — `setSubscriptionState` (217–264)
- Modify: `src/lib/user-data.ts` — `PRESERVED_SETTINGS_COLUMNS` (437–475)
- Modify: `src/lib/webhook-deliveries.ts` — `WEBHOOK_REASONS`
- Create: `scripts/smoke-stripe-ordering.ts` (pure); Modify: `scripts/smoke-stripe-dedupe.ts`; `scripts/run-smoke.ts`

**Interfaces**
- Consumes: `userSettings.subscriptionEventAt` (Task 1); `readDecideContext`, `applyStripeDecision` (Task 2).
- Produces: `DecideContext.lastSubscriptionEventAt?: Date | null`, `DecideContext.currentSubscriptionStatus?: "active" | "past_due" | "canceled" | null`; `isStaleSubscriptionEvent(ctx, createdAt: Date | null, terminal: boolean): boolean`; subscription `MirrorInstruction.eventAt?: Date | null`; `STRIPE_IGNORE_REASONS.staleSubscriptionEvent` / `WEBHOOK_REASONS.staleSubscriptionEvent = "stale_subscription_event"`; `setSubscriptionState(..., opts.eventAt?: Date)`.

- [ ] **Step 1: Write the failing pure smoke**

Create `scripts/smoke-stripe-ordering.ts`:

```ts
/**
 * Out-of-order Stripe subscription events (launch Phase 2, audit B2). Pure: drives
 * `decideStripeEvent` with a context, no database.
 *
 * Run: npx tsx scripts/smoke-stripe-ordering.ts
 */
import type Stripe from "stripe";
import {
  decideStripeEvent,
  isStaleSubscriptionEvent,
  type DecideContext,
} from "../src/lib/billing-stripe";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  PRO_METADATA_VALUE,
  SUBSCRIPTION_USER_METADATA_KEY,
} from "../src/lib/stripe";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "user_ordering";
const T1 = 1_800_000_000;
const T2 = T1 + 60;
const at = (s: number) => new Date(s * 1000);

function ctx(over: Partial<DecideContext> = {}): DecideContext {
  return { userId: USER, beforeCents: 500, hadPriorRevenue: true, now: at(T2 + 5), ...over };
}

function sub(type: string, created: number | undefined, status = "active") {
  return {
    id: `evt_${type}_${created ?? "none"}`,
    type,
    ...(created !== undefined ? { created } : {}),
    data: {
      object: {
        id: "sub_ordering",
        object: "subscription",
        status,
        customer: "cus_ordering",
        metadata: { [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE, [SUBSCRIPTION_USER_METADATA_KEY]: USER },
        items: { data: [{ id: "si_1", quantity: 1, current_period_end: T2 + 30 * 86400, price: { unit_amount: 500, recurring: { interval: "month", interval_count: 1 } } }] },
      },
    },
  } as unknown as Stripe.Event;
}

function checkout(plan: string, created: number) {
  return {
    id: `evt_checkout_${plan}_${created}`,
    type: "checkout.session.completed",
    created,
    data: {
      object: {
        id: `cs_${plan}`,
        object: "checkout.session",
        client_reference_id: USER,
        payment_status: "paid",
        amount_total: plan === "lifetime" ? 4900 : 500,
        customer: "cus_ordering",
        metadata: { [LIFETIME_METADATA_KEY]: plan === "lifetime" ? LIFETIME_METADATA_VALUE : PRO_METADATA_VALUE },
      },
    },
  } as unknown as Stripe.Event;
}

console.log("isStaleSubscriptionEvent");
check("never stale with no clock", !isStaleSubscriptionEvent({ lastSubscriptionEventAt: null }, at(T1), false));
check("never stale with no created", !isStaleSubscriptionEvent({ lastSubscriptionEventAt: at(T2) }, null, false));
check("older is stale", isStaleSubscriptionEvent({ lastSubscriptionEventAt: at(T2) }, at(T1), false));
check("newer is fresh", !isStaleSubscriptionEvent({ lastSubscriptionEventAt: at(T1) }, at(T2), false));
check(
  "same second after a cancellation: a non-terminal event loses",
  isStaleSubscriptionEvent({ lastSubscriptionEventAt: at(T2), currentSubscriptionStatus: "canceled" }, at(T2), false)
);
check(
  "same second: a terminal event wins",
  !isStaleSubscriptionEvent({ lastSubscriptionEventAt: at(T2), currentSubscriptionStatus: "active" }, at(T2), true)
);

console.log("\ndecideStripeEvent");
const stale = decideStripeEvent(sub("customer.subscription.updated", T1), ctx({ lastSubscriptionEventAt: at(T2), currentSubscriptionStatus: "canceled" }));
check("an updated older than the applied deleted is ignored", stale.outcome === "ignored" && stale.reason === "stale_subscription_event", JSON.stringify(stale));
check("...with no mirror and no booking", stale.mirror === null && stale.bookings.length === 0);

const fresh = decideStripeEvent(sub("customer.subscription.deleted", T2, "canceled"), ctx({ lastSubscriptionEventAt: at(T1) }));
check("a newer deleted is handled", fresh.outcome === "handled");
check(
  "...and carries its created time for the clock",
  fresh.mirror?.type === "subscription" && fresh.mirror.eventAt?.getTime() === at(T2).getTime(),
  JSON.stringify(fresh.mirror)
);

const undated = decideStripeEvent(sub("customer.subscription.updated", undefined), ctx({ lastSubscriptionEventAt: at(T2) }));
check("an event with no created is never gated", undated.outcome === "handled");
check("...and does not move the clock", undated.mirror?.type === "subscription" && (undated.mirror.eventAt ?? null) === null);

const staleCheckout = decideStripeEvent(checkout("pro", T1), ctx({ beforeCents: 0, lastSubscriptionEventAt: at(T2), currentSubscriptionStatus: "canceled" }));
check("a Pro checkout older than the clock is ignored", staleCheckout.reason === "stale_subscription_event", JSON.stringify(staleCheckout));
const freshCheckout = decideStripeEvent(checkout("pro", T2), ctx({ beforeCents: 0, lastSubscriptionEventAt: at(T1) }));
check(
  "a fresh Pro checkout grants without moving the clock",
  freshCheckout.mirror?.type === "subscription" && (freshCheckout.mirror.eventAt ?? null) === null
);
const lifetime = decideStripeEvent(checkout("lifetime", T1), ctx({ beforeCents: 0, lastSubscriptionEventAt: at(T2) }));
check("Lifetime is never gated by the subscription clock", lifetime.mirror?.type === "lifetime");

if (failures > 0) process.exit(1);
console.log("\nAll ordering checks passed.");
process.exit(0);
```

- [ ] **Step 2: Register and watch it fail**

Add `"smoke-stripe-ordering": "pure",` to the pure section of `MANIFEST`. Run `npx tsx scripts/smoke-stripe-ordering.ts`. Expected: a TypeScript/runtime error, because `isStaleSubscriptionEvent` is not exported.

- [ ] **Step 3: Extend the pure decision in `src/lib/billing-stripe.ts`**

3a. In `MirrorInstruction`'s subscription variant, after `stripeCustomerId: string | null;` add:

```ts
      /**
       * The event's `created`, when this write should advance
       * `user_settings.subscription_event_at`. Absent for checkout completions (gated by
       * the clock, never advancing it) and for events that carry no `created`.
       */
      eventAt?: Date | null;
```

3b. In `DecideContext`, after `now: Date;` add:

```ts
  /** `user_settings.subscription_event_at`: the newest subscription event already applied. */
  lastSubscriptionEventAt?: Date | null;
  /** The mirror's current status, for the same-second tie-break. */
  currentSubscriptionStatus?: "active" | "past_due" | "canceled" | null;
```

3c. In `STRIPE_IGNORE_REASONS`, after `noMovement: "no_movement",` add `staleSubscriptionEvent: "stale_subscription_event",`. In `src/lib/webhook-deliveries.ts` `WEBHOOK_REASONS`, after `noMovement: "no_movement",` add the same line.

3d. Directly above `export function decideStripeEvent(`, add:

```ts
/**
 * Whether a subscription-mirror event is older than what the mirror already reflects.
 *
 * Stripe does not order deliveries, and retries a failed one for three days, so an
 * `updated` (active) created before a `deleted` can arrive after it and re-grant Pro.
 * Comparing `created` against the last applied one closes that. Same second: a terminal
 * event wins, and a non-terminal one loses to a cancellation already recorded.
 */
export function isStaleSubscriptionEvent(
  ctx: Pick<DecideContext, "lastSubscriptionEventAt" | "currentSubscriptionStatus">,
  createdAt: Date | null,
  terminal: boolean
): boolean {
  const last = ctx.lastSubscriptionEventAt ?? null;
  if (!last || !createdAt) return false;
  if (createdAt.getTime() < last.getTime()) return true;
  if (createdAt.getTime() > last.getTime()) return false;
  return !terminal && ctx.currentSubscriptionStatus === "canceled";
}
```

3e. Inside `decideStripeEvent`, directly after `const { resourceId } = stripeEventSubject(event as Stripe.Event);`, add:

```ts
  // Only real Stripe events carry `created`; hand-built fixtures without it are never gated.
  const createdAt = typeof event.created === "number" ? new Date(event.created * 1000) : null;
```

3f. In the checkout branch, replace `      if (planMeta === PRO_METADATA_VALUE) {` with:

```ts
      if (planMeta === PRO_METADATA_VALUE) {
        if (isStaleSubscriptionEvent(ctx, createdAt, false)) {
          return ignored(STRIPE_IGNORE_REASONS.staleSubscriptionEvent, userId, resourceId);
        }
```

3g. In the subscription branch, replace:

```ts
      const terminal = event.type === "customer.subscription.deleted";
```

with:

```ts
      const terminal = event.type === "customer.subscription.deleted";
      if (isStaleSubscriptionEvent(ctx, createdAt, terminal)) {
        return ignored(STRIPE_IGNORE_REASONS.staleSubscriptionEvent, userId, resourceId);
      }
```

and in that branch's returned mirror, after `stripeCustomerId: customerIdOf(subscription),` add `eventAt: createdAt,`.

3h. Phase 0 revocations: if `decideStripeEvent` now returns other `type: "subscription"` mirrors (refunded subscription invoice, lost dispute), add `eventAt: createdAt,` to each, so a revocation also moves the clock and an older `updated` cannot undo it.

- [ ] **Step 4: Write and read the clock**

4a. `src/lib/user-settings.ts`: add `sql` to the drizzle import (`import { and, count, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";`). Change the `setSubscriptionState` opts type to `opts: { stripeCustomerId?: string | null; eventKey?: string; eventAt?: Date } = {}` and, inside `.set({ ... })`, after the `stripeCustomerId` spread, add:

```ts
      // GREATEST, not assignment: two deliveries racing must never move the clock backwards.
      ...(opts.eventAt
        ? {
            subscriptionEventAt: sql`GREATEST(${userSettings.subscriptionEventAt}, ${opts.eventAt.toISOString()}::timestamptz)`,
          }
        : {}),
```

4b. `src/lib/stripe-fulfilment.ts` → `readDecideContext`: add `subscriptionEventAt: true,` to `columns`, and replace the final `return { ... }` with:

```ts
  return {
    userId,
    beforeCents,
    hadPriorRevenue: beforeCents === 0 ? await hasPriorRevenue(userId) : false,
    now,
    lastSubscriptionEventAt: row?.subscriptionEventAt ?? null,
    currentSubscriptionStatus: row?.subscriptionStatus ?? null,
  };
```

4c. `applyStripeDecision`, `case "subscription"`: replace `{ stripeCustomerId: mirror.stripeCustomerId }` with:

```ts
        {
          stripeCustomerId: mirror.stripeCustomerId,
          ...(mirror.eventAt ? { eventAt: mirror.eventAt } : {}),
        }
```

4d. `src/lib/user-data.ts` → `PRESERVED_SETTINGS_COLUMNS`: after `subscriptionPeriodEnd: true,` add `subscriptionEventAt: true,`. A "Preferences" reset must not reset the clock under a live subscription.

- [ ] **Step 5: Prove it through the real route**

In `scripts/smoke-stripe-dedupe.ts`, directly before the final `await reset();` in `main`, add:

```ts
  console.log("\nAn older event delivered after a newer one is ignored");
  await reset();
  const base = Math.floor(Date.now() / 1000) - 3600;
  await post(signed(subEvent("customer.subscription.updated", USER, {}, base)));
  await post(signed(subEvent("customer.subscription.deleted", USER, { status: "canceled" }, base + 120)));
  const ledgerBeforeLate = (await ledgerFor(USER)).length;
  const lateUpdate = await post(signed(subEvent("customer.subscription.updated", USER, {}, base + 60)));
  check("the late event -> 200", lateUpdate.status === 200);
  const afterLate = await settingsFor(USER);
  check("...and the cancellation stands", afterLate?.subscriptionStatus === "canceled", String(afterLate?.subscriptionStatus));
  check("...recorded as stale", (await lastDelivery())?.reason === "stale_subscription_event");
  check(
    "the clock holds the newest applied event",
    afterLate?.subscriptionEventAt?.getTime() === (base + 120) * 1000,
    String(afterLate?.subscriptionEventAt)
  );
  check("the stale event booked nothing", (await ledgerFor(USER)).length === ledgerBeforeLate);
```

- [ ] **Step 6: Run and verify**

```bash
npx tsx scripts/smoke-stripe-ordering.ts
npx tsx scripts/smoke-stripe-dedupe.ts
npx tsx scripts/smoke-stripe-webhook.ts
npx tsx scripts/smoke-purge-selective.ts
npm run typecheck && npm run lint
```

Expected: all exit 0. `smoke-stripe-webhook` still passes because its fixtures carry no `created`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/billing-stripe.ts src/lib/stripe-fulfilment.ts src/lib/user-settings.ts src/lib/user-data.ts src/lib/webhook-deliveries.ts scripts/smoke-stripe-ordering.ts scripts/smoke-stripe-dedupe.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Ignore Stripe subscription events older than the last one applied

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Verify the checkout on return, so a paid user is never stuck on free

Both success URLs carry `session_id={CHECKOUT_SESSION_ID}`. On `/settings?upgraded=…&session_id=…` the celebration watcher calls `confirmCheckoutSession`. The action retrieves the session from Stripe, checks it belongs to the caller, is complete, is under 24 h old and has not been reversed, then replays it as a synthetic `checkout.session.completed` through the same `decideStripeEvent` → `applyStripeDecision` path as the webhook. It is idempotent with the later webhook. Lifetime cash is keyed `cs:<session>`, and `setLifetimePurchase` keeps the first timestamp. The Pro checkout MRR booking moves from `event.id` to `csm:<session>`, so the return path and the webhook, which can arrive in the same second and both read `before = 0`, collapse onto one row. A session produces at most one checkout movement, and the invariant still holds: the row carries MRR only, and no event books both kinds.

**Files:**
- Create: `src/lib/checkout-confirm.ts` (pure)
- Modify: `src/lib/billing-stripe.ts` — Pro checkout booking `eventId` (line 384)
- Modify: `src/lib/stripe-fulfilment.ts` — add `confirmCheckoutForUser`
- Modify: `src/actions/billing.ts` — success URLs (68, 143), new action after `getCurrentPlan` (179–183)
- Modify: `src/components/celebration/plan-celebration-watcher.tsx` — import (7), Feed 2 effect (180–216)
- Create: `scripts/smoke-checkout-confirm.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces**
- Consumes: `readDecideContext`, `applyStripeDecision` (Tasks 2–3); `decideStripeEvent`.
- Produces: `CONFIRM_WINDOW_SECONDS`, `type ConfirmableSession`, `type ConfirmVerdict`, `checkoutSessionVerdict(session, { userId, nowSeconds })`, `syntheticCheckoutEvent(session): Stripe.Event` (checkout-confirm.ts); `confirmCheckoutForUser(userId, sessionId, deps: { retrieve: (id: string) => Promise<Stripe.Checkout.Session>; now?: Date }): Promise<{ status: "applied" | "skipped"; reason?: string }>`; server action `confirmCheckoutSession(sessionId: string): Promise<{ status: "applied" | "skipped" | "unavailable" }>`.

- [ ] **Step 1: Write the failing smoke**

Read `node_modules/next/dist/docs/01-app/02-guides/server-actions.md` first. Then create `scripts/smoke-checkout-confirm.ts`:

```ts
/**
 * Verify-on-return (launch Phase 2, audit B2): the return path grants what the webhook would,
 * refuses sessions that are not the caller's or were reversed, and a late webhook is a no-op.
 *
 * Run: npx tsx scripts/smoke-checkout-confirm.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const TEST_SECRET = "whsec_test_smoke_confirm_only";
process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
process.env.STRIPE_SECRET_KEY ||= "sk_test_smoke_only_not_a_real_key";

import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { billingEvents, userSettings } from "../src/db/schema";
import { POST } from "../src/app/api/webhooks/stripe/route";
import { checkoutSessionVerdict } from "../src/lib/checkout-confirm";
import { confirmCheckoutForUser } from "../src/lib/stripe-fulfilment";
import { ensureUserSettings } from "../src/lib/user-settings";
import {
  LIFETIME_METADATA_KEY,
  LIFETIME_METADATA_VALUE,
  PRO_BILLING_PERIOD_METADATA_KEY,
  PRO_METADATA_VALUE,
} from "../src/lib/stripe";

const LIFE = "smoke-confirm-life";
const PRO = "smoke-confirm-pro";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const nowSec = () => Math.floor(Date.now() / 1000);

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function session(over: Record<string, unknown>): Stripe.Checkout.Session {
  return {
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    created: nowSec() - 60,
    currency: "usd",
    ...over,
  } as unknown as Stripe.Checkout.Session;
}

const lifetime = (over: Record<string, unknown> = {}) =>
  session({
    id: "cs_test_confirm_life",
    mode: "payment",
    client_reference_id: LIFE,
    customer: "cus_confirm_life",
    amount_total: 4900,
    metadata: { [LIFETIME_METADATA_KEY]: LIFETIME_METADATA_VALUE },
    payment_intent: { id: "pi_1", latest_charge: { id: "ch_1", refunded: false, amount_refunded: 0, disputed: false } },
    ...over,
  });

const pro = (over: Record<string, unknown> = {}) =>
  session({
    id: "cs_test_confirm_pro",
    mode: "subscription",
    client_reference_id: PRO,
    customer: "cus_confirm_pro",
    amount_total: 500,
    metadata: { [LIFETIME_METADATA_KEY]: PRO_METADATA_VALUE, [PRO_BILLING_PERIOD_METADATA_KEY]: "monthly" },
    subscription: { id: "sub_confirm", status: "active" },
    ...over,
  });

const retrieving = (s: Stripe.Checkout.Session) => ({ retrieve: async () => s });

function webhookFor(s: Stripe.Checkout.Session, eventId: string) {
  const payload = JSON.stringify({ id: eventId, object: "event", type: "checkout.session.completed", created: nowSec(), data: { object: s } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_SECRET });
  const req = new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": header }, body: payload });
  return POST(req as unknown as Parameters<typeof POST>[0]);
}

async function row(userId: string) {
  const db = await getDb();
  return db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
}
async function ledger(userId: string) {
  const db = await getDb();
  return db.select().from(billingEvents).where(eq(billingEvents.userId, userId));
}

async function main() {
  const db = await getDb();
  for (const u of [LIFE, PRO]) {
    await db.delete(billingEvents).where(eq(billingEvents.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
    await ensureUserSettings(u);
  }

  console.log("The verdict");
  const v = (s: Stripe.Checkout.Session, userId = LIFE) => checkoutSessionVerdict(s, { userId, nowSeconds: nowSec() });
  check("a paid, recent, own session passes", v(lifetime()).ok);
  check("someone else's session is refused", !v(lifetime(), "someone-else").ok);
  check("an open session is refused", !v(lifetime({ status: "open" })).ok);
  check("a session older than a day is refused", !v(lifetime({ created: nowSec() - 2 * 86400 })).ok);
  check("a refunded charge is refused", !v(lifetime({ payment_intent: { id: "pi", latest_charge: { refunded: true, amount_refunded: 4900, disputed: false } } })).ok);
  check("a disputed charge is refused", !v(lifetime({ payment_intent: { id: "pi", latest_charge: { refunded: false, amount_refunded: 0, disputed: true } } })).ok);
  check("an unexpanded charge is refused rather than trusted", !v(lifetime({ payment_intent: "pi_unexpanded" })).ok);
  check("a canceled subscription is refused", !v(pro({ subscription: { id: "s", status: "canceled" } }), PRO).ok);

  console.log("\nLifetime on return, then the late webhook");
  check("someone else cannot confirm it", (await confirmCheckoutForUser("someone-else", "cs_test_confirm_life", retrieving(lifetime()))).status === "skipped");
  const applied = await confirmCheckoutForUser(LIFE, "cs_test_confirm_life", retrieving(lifetime()));
  check("the return path applies", applied.status === "applied", JSON.stringify(applied));
  const granted = (await row(LIFE))?.lifetimePurchasedAt;
  check("Lifetime is granted without any webhook", Boolean(granted));
  check("its cash is booked once, on the session", (await ledger(LIFE)).filter((r) => r.eventId === "cs:cs_test_confirm_life").length === 1);
  check("the late webhook -> 200", (await webhookFor(lifetime(), "evt_confirm_life")).status === 200);
  check("...keeps the first timestamp", (await row(LIFE))?.lifetimePurchasedAt?.getTime() === granted?.getTime());
  check("...and books nothing new", (await ledger(LIFE)).length === 1);

  console.log("\nPro: return path and webhook racing");
  await Promise.all([
    confirmCheckoutForUser(PRO, "cs_test_confirm_pro", retrieving(pro())),
    webhookFor(pro(), "evt_confirm_pro"),
  ]);
  const proRow = await row(PRO);
  check("Pro is granted", proRow?.subscriptionPlan === "orbit" && proRow?.subscriptionStatus === "active");
  const movements = (await ledger(PRO)).filter((r) => r.mrrDeltaCents !== 0);
  check("exactly one MRR movement, keyed on the session", movements.length === 1 && movements[0]?.eventId === "csm:cs_test_confirm_pro", JSON.stringify(movements.map((m) => m.eventId)));

  for (const u of [LIFE, PRO]) {
    await db.delete(billingEvents).where(eq(billingEvents.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
  }
  console.log("\nAll checkout-confirm checks passed.");
}

run(main);
```

- [ ] **Step 2: Register and watch it fail**

Add `"smoke-checkout-confirm": "pglite",` to `MANIFEST`. Run it. Expected: `Cannot find module '../src/lib/checkout-confirm'`.

- [ ] **Step 3: Create `src/lib/checkout-confirm.ts`**

```ts
import type Stripe from "stripe";

/**
 * Pure checks for verify-on-return. Imports Stripe for types only.
 *
 * The return URL is not proof of payment: anyone can type `?session_id=`, and a session from
 * browser history may since have been refunded. So the retrieved session must belong to the
 * caller, be complete, be recent, and still hold its money. When any of that cannot be shown
 * (an unexpanded charge, a no-payment session), the answer is "skip": the webhook remains the
 * guarantee, and this path is only ever a shortcut.
 */
export const CONFIRM_WINDOW_SECONDS = 24 * 60 * 60;

type ChargeLike = { refunded?: boolean; amount_refunded?: number; disputed?: boolean };

export type ConfirmableSession = {
  id: string;
  client_reference_id: string | null;
  status: string | null;
  payment_status: string;
  mode: string;
  created: number;
  payment_intent?: string | { latest_charge?: string | ChargeLike | null } | null;
  subscription?: string | { status?: string } | null;
};

export type ConfirmVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "not_yours" | "incomplete" | "unpaid" | "too_old" | "unverifiable" | "reversed" | "subscription_inactive";
    };

export function checkoutSessionVerdict(
  session: ConfirmableSession,
  ctx: { userId: string; nowSeconds: number }
): ConfirmVerdict {
  if (session.client_reference_id !== ctx.userId) return { ok: false, reason: "not_yours" };
  if (session.status !== "complete") return { ok: false, reason: "incomplete" };
  if (session.payment_status === "unpaid") return { ok: false, reason: "unpaid" };
  if (ctx.nowSeconds - session.created > CONFIRM_WINDOW_SECONDS) return { ok: false, reason: "too_old" };

  if (session.mode === "payment") {
    const intent = session.payment_intent;
    const charge = intent && typeof intent === "object" ? intent.latest_charge : null;
    if (!charge || typeof charge !== "object") return { ok: false, reason: "unverifiable" };
    if (charge.refunded || (charge.amount_refunded ?? 0) > 0 || charge.disputed) {
      return { ok: false, reason: "reversed" };
    }
  }

  if (session.mode === "subscription") {
    const sub = session.subscription;
    const status = sub && typeof sub === "object" ? sub.status : null;
    if (status !== "active" && status !== "trialing") {
      return { ok: false, reason: "subscription_inactive" };
    }
  }

  return { ok: true };
}

/**
 * The session as the event the webhook would have delivered. `created` is the SESSION's,
 * which predates every subscription event it caused, so the ordering clock (Task 3) can
 * never mistake a replay for news.
 */
export function syntheticCheckoutEvent(session: Stripe.Checkout.Session): Stripe.Event {
  return {
    id: `confirm_${session.id}`,
    object: "event",
    type: "checkout.session.completed",
    created: session.created,
    data: { object: session },
  } as unknown as Stripe.Event;
}
```

- [ ] **Step 4: Key the Pro checkout movement on the session**

In `src/lib/billing-stripe.ts`, in the Pro checkout branch's booking, replace `                  eventId: event.id,` (line 384, the one inside `if (planMeta === PRO_METADATA_VALUE)`) with:

```ts
                  // Keyed on the SESSION: the return path (`confirmCheckoutForUser`) and this
                  // webhook can both read before = 0 in the same second. A session yields at
                  // most one checkout movement, so one key per session drops the second.
                  eventId: `csm:${session.id}`,
```

Also add `csm:<session>` to the list of namespaces in the module header comment, next to `cs:`.

- [ ] **Step 5: Add `confirmCheckoutForUser` to `src/lib/stripe-fulfilment.ts`**

Add the imports `import { decideStripeEvent } from "@/lib/billing-stripe";` (merge it into the existing `@/lib/billing-stripe` import) and `import { checkoutSessionVerdict, syntheticCheckoutEvent } from "@/lib/checkout-confirm";`, then append:

```ts
/**
 * Verify-on-return: apply a Checkout Session the caller just paid for, without waiting for
 * the webhook. Same decision, same apply, so the later webhook finds nothing left to do.
 */
export async function confirmCheckoutForUser(
  userId: string,
  sessionId: string,
  deps: { retrieve: (sessionId: string) => Promise<Stripe.Checkout.Session>; now?: Date }
): Promise<{ status: "applied" | "skipped"; reason?: string }> {
  const session = await deps.retrieve(sessionId);
  const now = deps.now ?? new Date();
  const verdict = checkoutSessionVerdict(session, {
    userId,
    nowSeconds: Math.floor(now.getTime() / 1000),
  });
  if (!verdict.ok) return { status: "skipped", reason: verdict.reason };

  const event = syntheticCheckoutEvent(session);
  const decision = decideStripeEvent(event, await readDecideContext(event, now));
  if (decision.outcome !== "handled") {
    return { status: "skipped", reason: decision.reason ?? "ignored" };
  }
  await applyStripeDecision(decision);
  return { status: "applied" };
}
```

- [ ] **Step 6: The action and the success URLs (`src/actions/billing.ts`)**

6a. Line 68: `success_url: \`${baseUrl}/settings?upgraded=lifetime&session_id={CHECKOUT_SESSION_ID}#settings-plan\`,`. Line 143: `success_url: \`${baseUrl}/settings?upgraded=pro&session_id={CHECKOUT_SESSION_ID}#settings-plan\`,`. Stripe substitutes the literal `{CHECKOUT_SESSION_ID}`, which has no `$` and so is not template interpolation.

6b. Add `import { confirmCheckoutForUser } from "@/lib/stripe-fulfilment";` and, after `getCurrentPlan`, add:

```ts
/**
 * Verify-on-return. The webhook stays the guarantee; this only shortens the wait, so every
 * failure is swallowed into a status and the caller carries on polling.
 */
export async function confirmCheckoutSession(
  sessionId: string
): Promise<{ status: "applied" | "skipped" | "unavailable" }> {
  const userId = await requireUserId();
  if (!isStripeConfigured()) return { status: "unavailable" };
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]{8,250}$/.test(sessionId)) {
    return { status: "skipped" };
  }
  try {
    const result = await confirmCheckoutForUser(userId, sessionId, {
      retrieve: (id) =>
        getStripe().checkout.sessions.retrieve(id, {
          expand: ["payment_intent.latest_charge", "subscription"],
        }),
    });
    return { status: result.status };
  } catch (err) {
    // Not recorded as a stripeCheckout error event: that source pages "nobody can pay".
    console.error("Checkout confirmation on return did not complete:", err);
    return { status: "unavailable" };
  }
}
```

- [ ] **Step 7: Wire the watcher**

In `plan-celebration-watcher.tsx`, import `confirmCheckoutSession` alongside `getCurrentPlan`. Replace the whole Feed 2 effect (from `// Feed 2 — fast post-checkout poll` through its closing `}, []);`) with:

```tsx
  // Feed 2 — post-checkout. With a `session_id`, first ask the server to verify the session
  // with Stripe and apply it (the webhook may be late or failing); then fast-poll as before.
  // Params are stripped only AFTER that action settles: a router navigation landing while an
  // action is queued can drop the action.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const upgraded = params.get("upgraded");
    if (upgraded !== "pro" && upgraded !== "lifetime") return;
    const sessionId = params.get("session_id");

    let cancelled = false;
    let interval: number | undefined;

    void (async () => {
      if (sessionId) {
        try {
          await confirmCheckoutSession(sessionId);
        } catch {
          // The webhook is still the guarantee; polling below picks it up.
        }
      }
      if (cancelled) return;
      const url = new URL(window.location.href);
      url.searchParams.delete("upgraded");
      url.searchParams.delete("session_id");
      router.replace(url.pathname + url.search + url.hash);

      let attempts = 0;
      let running = false;
      interval = window.setInterval(async () => {
        if (running) return;
        if (activeRef.current || attempts >= FAST_POLL_ATTEMPTS) {
          window.clearInterval(interval);
          return;
        }
        attempts += 1;
        running = true;
        try {
          maybeCelebrate(await getCurrentPlan());
        } catch {
          // Network blips: the next tick, the ambient poll, or the next page load will get it.
        } finally {
          running = false;
        }
      }, FAST_POLL_MS);
    })();

    return () => {
      cancelled = true;
      if (interval !== undefined) window.clearInterval(interval);
    };
    // Arm once per mount; the params are gone after the replace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 8: Verify**

```bash
npx tsx scripts/smoke-checkout-confirm.ts
npx tsx scripts/smoke-stripe-webhook.ts
npx tsx scripts/smoke-stripe-ordering.ts
npm run typecheck && npm run lint
```

Expected: all exit 0 (`smoke-stripe-webhook` asserts counts and kinds, not the Pro checkout key). Browser: start `orbit-web`, open `/settings?upgraded=pro&session_id=cs_test_bogus#settings-plan`, and confirm the params disappear from the URL within a second, the console shows no uncaught error, and the Plan card still renders. The end-to-end paid run is Manual step M2.

- [ ] **Step 9: Commit**

```bash
git add src/lib/checkout-confirm.ts src/lib/billing-stripe.ts src/lib/stripe-fulfilment.ts src/actions/billing.ts src/components/celebration/plan-celebration-watcher.tsx scripts/smoke-checkout-confirm.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Verify the Stripe checkout on return so a paid user is never stuck on free

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Record every purge as a run and resume unfinished ones nightly

`purgeUserData` inserts a `data_purge_runs` row, runs its plan step by step, and records each completed step. When a step throws, it stores `last_error` and throws `PurgeIncompleteError`, which carries the completed and pending steps. The nightly job calls `resumeStrandedPurges`: runs idle for 10+ minutes re-run only their pending steps (each is an idempotent WHERE-user delete), and a run that reaches `PURGE_MAX_ATTEMPTS` (5) is marked `failed`. Finished runs are pruned after 30 days.

**Files:**
- Modify: `src/lib/data-categories.ts` — append after `lockedByImplication` (line 177)
- Modify: `src/lib/user-data.ts` — imports (1–71), replace `purgeUserData` and its doc comment (490–544)
- Modify: `src/app/api/imports/process-stalled/route.ts` — imports (5–8), `stats` (113–140), new try block before the housekeeping block (line 160)
- Create: `scripts/smoke-purge-resume.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces**
- Consumes: `dataPurgeRuns`, `DataPurgeRunRow` (Task 1).
- Produces (data-categories.ts, DB-free): `type PurgeStepKey = DataCategory | "billing"`, `PURGE_MAX_ATTEMPTS = 5`, `isDataCategory(value: string): value is DataCategory`, `planPurgeSteps(categories: readonly string[], fullPurge: boolean): PurgeStepKey[]`.
- Produces (user-data.ts): `type PurgeOutcome = { runId: string | null; completed: PurgeStepKey[] }`; `purgeUserData(userId, opts?): Promise<PurgeOutcome>` (same options as today); `class PurgeIncompleteError extends Error { runId: string; completed: PurgeStepKey[]; pending: PurgeStepKey[] }`; `PURGE_RESUME_AFTER_MS`; `resumeStrandedPurges(opts: { now: Date; limit?: number }): Promise<{ found: number; finished: number; stillFailing: number; gaveUp: number; pruned: number }>`.

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-purge-resume.ts`:

```ts
/**
 * A purge interrupted mid-way finishes on the next nightly tick (launch Phase 2, audit B3).
 * The interruption is real, not simulated: the `goals` step's table is renamed away, so its
 * DELETE throws exactly as a dropped connection would.
 *
 * Run: npx tsx scripts/smoke-purge-resume.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import { PURGE_MAX_ATTEMPTS, planPurgeSteps } from "../src/lib/data-categories";
import { PurgeIncompleteError, purgeUserData, resumeStrandedPurges } from "../src/lib/user-data";

const USER = "smoke-purge-resume-user";
const MIN = 60_000;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function seed() {
  const db = await getDb();
  await db.insert(schema.userSettings).values({ userId: USER }).onConflictDoNothing();
  await db.insert(schema.contacts).values({ userId: USER, fullName: "Ada Lovelace" });
  await db.insert(schema.chatThreads).values({ userId: USER, title: "thread" });
}

async function count(table: "contacts" | "chat_threads") {
  const db = await getDb();
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE user_id = ${USER}`);
  return rowsOf<{ n: number }>(res)[0]?.n ?? 0;
}

async function runFor(runId: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.dataPurgeRuns).where(eq(schema.dataPurgeRuns.id, runId));
  return row;
}

async function breakGoals() {
  await (await getDb()).execute(sql`ALTER TABLE user_goals RENAME TO user_goals_parked`);
}
async function fixGoals() {
  await (await getDb()).execute(sql`ALTER TABLE IF EXISTS user_goals_parked RENAME TO user_goals`);
}

async function interruptedPurge(): Promise<PurgeIncompleteError> {
  await breakGoals();
  try {
    await purgeUserData(USER, { keepSettings: false });
  } catch (err) {
    if (err instanceof PurgeIncompleteError) return err;
    throw err;
  }
  throw new Error("expected the purge to stop at the goals step");
}

async function main() {
  console.log("The plan");
  const full = planPurgeSteps(["contacts", "preferences", "insights", "notes", "reminders"], false);
  check("a partial plan follows category order and ends with preferences", full.join(",") === "insights,notes,reminders,contacts,preferences", full.join(","));
  const all = planPurgeSteps(["tags", "preferences", "goals"], true);
  check("a full purge anonymises billing before resetting settings", all.slice(-2).join(",") === "billing,preferences", all.join(","));

  try {
    console.log("\nAn interrupted purge");
    await seed();
    const stopped = await interruptedPurge();
    check("the error names the completed steps", stopped.completed.join(",") === "insights,notes,reminders,imports,connections,events", stopped.completed.join(","));
    check("...and what is still pending, starting at goals", stopped.pending[0] === "goals");
    check("rows after the failed step are still there", (await count("contacts")) === 1);
    const stranded = await runFor(stopped.runId);
    check("the run is recorded as running with its progress", stranded?.status === "running" && stranded.completedSteps.length === 6);
    check("...and the error that stopped it", Boolean(stranded?.lastError));

    await fixGoals();
    const tooSoon = await resumeStrandedPurges({ now: new Date() });
    check("a run touched in the last ten minutes is left alone", tooSoon.found === 0);
    const resumed = await resumeStrandedPurges({ now: new Date(Date.now() + 11 * MIN) });
    check("the nightly resume finishes it", resumed.finished === 1, JSON.stringify(resumed));
    check("the rest of the data is gone", (await count("contacts")) === 0 && (await count("chat_threads")) === 0);
    const finished = await runFor(stopped.runId);
    check("the run is done, on its second attempt", finished?.status === "done" && finished.attempts === 2 && finished.finishedAt !== null);

    console.log("\nA run that keeps failing gives up");
    await seed();
    const again = await interruptedPurge();
    let clock = Date.now();
    let gaveUp = 0;
    for (let i = 0; i < PURGE_MAX_ATTEMPTS; i += 1) {
      clock += 11 * MIN;
      gaveUp += (await resumeStrandedPurges({ now: new Date(clock) })).gaveUp;
    }
    check("it is marked failed after the maximum attempts", (await runFor(again.runId))?.status === "failed" && gaveUp === 1);
    await fixGoals();

    console.log("\nHousekeeping");
    const pruned = await resumeStrandedPurges({ now: new Date(Date.now() + 31 * 86_400_000) });
    check("finished runs older than 30 days are pruned", pruned.pruned >= 1, JSON.stringify(pruned));
  } finally {
    await fixGoals();
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
    const db = await getDb();
    await db.delete(schema.dataPurgeRuns).where(eq(schema.dataPurgeRuns.targetUserId, USER));
  }
  console.log("\nAll purge-resume checks passed.");
}

run(main);
```

- [ ] **Step 2: Register and watch it fail**

Add `"smoke-purge-resume": "pglite",` next to `"smoke-purge-selective"`. Run it. Expected: fails at import with `planPurgeSteps` (or `PurgeIncompleteError`) not exported.

- [ ] **Step 3: DB-free plan helpers in `src/lib/data-categories.ts`**

Append:

```ts
/** A unit of `purgeUserData`: a category, or the full-purge-only billing anonymisation. */
export type PurgeStepKey = DataCategory | "billing";

/** Attempts (the first run plus nightly resumes) before a purge run is marked failed. */
export const PURGE_MAX_ATTEMPTS = 5;

export function isDataCategory(value: string): value is DataCategory {
  return (DATA_CATEGORY_IDS as readonly string[]).includes(value);
}

/**
 * The ordered steps for an already-expanded selection. `preferences` (the `user_settings`
 * reset) always runs LAST, after billing, exactly as `purgeUserData` always has — the
 * settings row is what every other step's bookkeeping hangs off.
 */
export function planPurgeSteps(
  categories: readonly string[],
  fullPurge: boolean
): PurgeStepKey[] {
  const selected = new Set(categories);
  const steps: PurgeStepKey[] = DATA_CATEGORY_META.map((c) => c.id).filter(
    (id) => id !== "preferences" && selected.has(id)
  );
  if (fullPurge) steps.push("billing");
  if (selected.has("preferences")) steps.push("preferences");
  return steps;
}
```

- [ ] **Step 4: The ledger in `src/lib/user-data.ts`**

4a. Imports: change the drizzle import to `import { and, asc, eq, getTableName, inArray, lt, sql } from "drizzle-orm";`; add `dataPurgeRuns,` to the `@/db/schema` import list and `import type { DataPurgeRunRow } from "@/db/schema";`; extend the `@/lib/data-categories` import with `PURGE_MAX_ATTEMPTS, planPurgeSteps, type PurgeStepKey`, and add `type PurgeStepKey` to the re-export block.

4b. Replace the `purgeUserData` doc comment and function (lines 490–544) with the code below. Keep the body of the doc comment you replace (the billing and `user_settings` paragraphs) above `purgeUserData` and add the "Resumable" paragraph.

```ts
export type PurgeOutcome = { runId: string | null; completed: PurgeStepKey[] };

/** Thrown when a step fails; the run stays `running` for `resumeStrandedPurges`. */
export class PurgeIncompleteError extends Error {
  readonly runId: string;
  readonly completed: PurgeStepKey[];
  readonly pending: PurgeStepKey[];
  constructor(runId: string, completed: PurgeStepKey[], pending: PurgeStepKey[], cause: unknown) {
    super(`Purge ${runId} stopped with ${pending.length} step(s) left`, { cause });
    this.name = "PurgeIncompleteError";
    this.runId = runId;
    this.completed = completed;
    this.pending = pending;
  }
}

/** A run touched more recently than this is assumed to still be in flight. */
export const PURGE_RESUME_AFTER_MS = 10 * 60 * 1000;
const PURGE_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function runPurgeStep(db: Db, userId: string, key: PurgeStepKey, keepSettings: boolean) {
  if (key === "billing") {
    await db.update(billingEvents).set({ userId: null }).where(eq(billingEvents.userId, userId));
    return;
  }
  if (key === "preferences") {
    await purgeUserSettings(db, userId, keepSettings);
    return;
  }
  await STEPS[key].run(db, userId);
}

async function executePurgeRun(db: Db, run: DataPurgeRunRow): Promise<PurgeOutcome> {
  const plan = planPurgeSteps(run.categories, run.fullPurge);
  const done = new Set<string>(run.completedSteps);
  for (const key of plan) {
    if (done.has(key)) continue;
    try {
      await runPurgeStep(db, run.targetUserId, key, run.keepSettings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(dataPurgeRuns)
        .set({ lastError: `${key}: ${message}`.slice(0, 500) })
        .where(eq(dataPurgeRuns.id, run.id));
      throw new PurgeIncompleteError(
        run.id,
        plan.filter((k) => done.has(k)),
        plan.filter((k) => !done.has(k)),
        err
      );
    }
    done.add(key);
    await db
      .update(dataPurgeRuns)
      .set({ completedSteps: plan.filter((k) => done.has(k)) })
      .where(eq(dataPurgeRuns.id, run.id));
  }
  await db
    .update(dataPurgeRuns)
    .set({ status: "done", finishedAt: new Date(), lastError: null })
    .where(eq(dataPurgeRuns.id, run.id));
  return { runId: run.id, completed: plan };
}

/**
 * (keep the existing doc comment here, plus:)
 *
 * RESUMABLE. Every call is recorded in `data_purge_runs` before anything is deleted, and each
 * finished step is written back. A throw leaves the run `running` with its `last_error`, and
 * `resumeStrandedPurges` (the nightly job) re-runs what is left. neon-http has no
 * transactions, so this ledger is what stands in for one.
 */
export async function purgeUserData(
  userId: string,
  opts: { keepSettings?: boolean; only?: readonly DataCategory[] } = {}
): Promise<PurgeOutcome> {
  const keepSettings = opts.keepSettings ?? true;
  const selected = opts.only
    ? expandCategories(opts.only)
    : new Set<DataCategory>(DATA_CATEGORY_IDS);
  if (selected.size === 0) return { runId: null, completed: [] };
  const fullPurge = selected.size === DATA_CATEGORY_IDS.length;
  const db = await getDb();

  const [run] = await db
    .insert(dataPurgeRuns)
    .values({ targetUserId: userId, categories: [...selected], keepSettings, fullPurge })
    .returning();
  return executePurgeRun(db, run);
}

/** The nightly backstop: finish stranded runs, give up on hopeless ones, prune old ones. */
export async function resumeStrandedPurges(opts: { now: Date; limit?: number }) {
  const db = await getDb();
  const stats = { found: 0, finished: 0, stillFailing: 0, gaveUp: 0, pruned: 0 };
  const idleSince = new Date(opts.now.getTime() - PURGE_RESUME_AFTER_MS);
  const runs = await db
    .select()
    .from(dataPurgeRuns)
    .where(and(eq(dataPurgeRuns.status, "running"), lt(dataPurgeRuns.lastAttemptAt, idleSince)))
    .orderBy(asc(dataPurgeRuns.lastAttemptAt))
    .limit(opts.limit ?? 10);
  stats.found = runs.length;

  for (const run of runs) {
    if (run.attempts >= PURGE_MAX_ATTEMPTS) {
      await db.update(dataPurgeRuns).set({ status: "failed" }).where(eq(dataPurgeRuns.id, run.id));
      stats.gaveUp += 1;
      continue;
    }
    const attempts = run.attempts + 1;
    await db
      .update(dataPurgeRuns)
      .set({ attempts, lastAttemptAt: opts.now })
      .where(eq(dataPurgeRuns.id, run.id));
    try {
      await executePurgeRun(db, { ...run, attempts });
      stats.finished += 1;
    } catch {
      stats.stillFailing += 1;
    }
  }

  const pruneBefore = new Date(opts.now.getTime() - PURGE_RUN_RETENTION_MS);
  const pruned = await db
    .delete(dataPurgeRuns)
    .where(and(eq(dataPurgeRuns.status, "done"), lt(dataPurgeRuns.finishedAt, pruneBefore)))
    .returning();
  stats.pruned = pruned.length;
  return stats;
}
```

- [ ] **Step 5: Resume from the nightly job**

In `src/app/api/imports/process-stalled/route.ts`: add `import { resumeStrandedPurges } from "@/lib/user-data";` after the `capture-photos` import. In `stats`, after `followUpsFailed: 0,` add:

```ts
    /** Deletion runs picked up, finished, still failing, and given up after 5 attempts. */
    purgesFound: 0,
    purgesFinished: 0,
    purgesStillFailing: 0,
    purgesGaveUp: 0,
    purgeRunsPruned: 0,
```

Directly before the line `    try {` that is followed by `      stats.usageEventsPruned = await pruneOlderThan(`, insert:

```ts
    try {
      // Deletion requests that stopped part-way: the user was told it is happening, so a
      // stranded run is finished here, and one that keeps failing surfaces as purge.stuck.
      const purges = await resumeStrandedPurges({ now: new Date() });
      stats.purgesFound = purges.found;
      stats.purgesFinished = purges.finished;
      stats.purgesStillFailing = purges.stillFailing;
      stats.purgesGaveUp = purges.gaveUp;
      stats.purgeRunsPruned = purges.pruned;
      if (purges.stillFailing > 0 || purges.gaveUp > 0) status = "partial";
    } catch {
      status = "partial";
    }

```

- [ ] **Step 6: Verify**

```bash
npx tsx scripts/smoke-purge-resume.ts
npx tsx scripts/smoke-purge.ts
npx tsx scripts/smoke-purge-selective.ts
npx tsx scripts/smoke-instrumentation.ts
npm run typecheck && npm run lint
```

Expected: all exit 0. `smoke-purge` still finds zero user rows (the ledger uses `target_user_id`); `smoke-instrumentation` still finds `recomputeRecruiterRating` in `user-data.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/data-categories.ts src/lib/user-data.ts src/app/api/imports/process-stalled/route.ts scripts/smoke-purge-resume.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Record each purge as a run and resume unfinished ones from the nightly job

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Alert when a deletion gives up (`purge.stuck`)

**Files:**
- Modify: `src/lib/ops-alerts.ts` — `OpsSnapshot` (38–60), `evaluateOpsConditions` (before `return out;`, line 279)
- Modify: `src/lib/ops-sweep.ts` — schema import (3), `loadOpsSnapshot` (42–130)
- Modify: `scripts/smoke-ops-alerts.ts` — `HEALTHY` (33–51), new checks after the `reauth.needed` check (line 120)
- Modify: `docs/RUNBOOK.md` — "Alert → what to do" table (36–46)

**Interfaces**
- Consumes: `dataPurgeRuns` (Task 1), `PURGE_MAX_ATTEMPTS` (Task 5, from the DB-free `@/lib/data-categories`).
- Produces: `OpsSnapshot.stuckPurges: number`; condition id `purge.stuck` (critical).

- [ ] **Step 1: Failing test**

In `scripts/smoke-ops-alerts.ts`, add `stuckPurges: 0,` to `HEALTHY` after `failingSyncs: 0,`. After the `accounts needing re-auth → info` check, add:

```ts
  check("a failed deletion run → purge.stuck (critical)",
    find({ ...HEALTHY, stuckPurges: 1 }, "purge.stuck")?.severity === "critical");
  check("no failed deletion runs → no purge.stuck", !find(HEALTHY, "purge.stuck"));
```

Run `npx tsx scripts/smoke-ops-alerts.ts`. Expected: a type error on `stuckPurges`, or `FAIL a failed deletion run → purge.stuck (critical)`.

- [ ] **Step 2: The condition**

In `src/lib/ops-alerts.ts`, add `import { PURGE_MAX_ATTEMPTS } from "@/lib/data-categories";` (DB-free, so this module stays pure). In `OpsSnapshot`, after `failingSyncs: number;` add:

```ts
  /** `data_purge_runs` marked failed: deletions a user asked for that did not finish. */
  stuckPurges: number;
```

Before `return out;` in `evaluateOpsConditions`, add:

```ts
  // Critical, not warning: a user was told their data was deleted, and it is still here.
  if (s.stuckPurges > 0) {
    out.push({
      id: "purge.stuck",
      severity: "critical",
      title: "An account deletion is stuck",
      detail: `${s.stuckPurges} deletion run(s) stopped after ${PURGE_MAX_ATTEMPTS} attempts — rows the user asked to delete are still in the database. See data_purge_runs.last_error.`,
      href: "/admin/health",
    });
  }
```

- [ ] **Step 3: Load it**

In `src/lib/ops-sweep.ts`, change line 3 to `import { cronRuns, dataPurgeRuns, errorEvents, imports, opsAlertState } from "@/db/schema";`. In `loadOpsSnapshot`, directly after the closing `]);` of the `Promise.all`, add:

```ts
  const [stuckPurgeRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(dataPurgeRuns)
    .where(eq(dataPurgeRuns.status, "failed"));
```

and in the returned object, after `failingSyncs: issues.syncFailing,`, add `stuckPurges: stuckPurgeRow?.n ?? 0,`.

- [ ] **Step 4: Runbook row**

In `docs/RUNBOOK.md`, add this row to the "Alert → what to do" table after the `import.wedged` row:

```markdown
| `purge.stuck` | `SELECT id, target_user_id, last_error, completed_steps FROM data_purge_runs WHERE status = 'failed';` Fix the cause `last_error` names, then requeue: `UPDATE data_purge_runs SET status = 'running', attempts = 0, last_attempt_at = now() - interval '1 hour' WHERE id = '<id>';` The next nightly run finishes it (or trigger `/api/imports/process-stalled`). |
```

- [ ] **Step 5: Verify and commit**

```bash
npx tsx scripts/smoke-ops-alerts.ts
npx tsx scripts/smoke-ops-sweep.ts
npm run typecheck && npm run lint
git add src/lib/ops-alerts.ts src/lib/ops-sweep.ts scripts/smoke-ops-alerts.ts docs/RUNBOOK.md
git commit -m "$(cat <<'EOF'
Raise purge.stuck when a deletion run gives up

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

Expected: both smokes exit 0; 0 type/lint errors. If Phase 0 added fields to `OpsSnapshot`, `HEALTHY` already carries them. Only `stuckPurges` is new here.

---

### Task 7: Tell the user what was deleted when a step stops part-way

`deleteAllData` catches `PurgeIncompleteError` and returns `{ deleted, pending }` as data. A thrown server-action error reaches production only as a digest. The dialog stays open and lists what is done and what Orbit will finish on its own.

**Files:**
- Modify: `src/actions/settings.ts` — imports (18–24), `deleteAllData` (444–471)
- Modify: `src/components/settings/delete-data-dialog.tsx` — state (48–60), `reset` (81–84), `submit` (95–121), a status panel before the confirmation `<label>` (line 219)
- Create: `scripts/smoke-delete-partial.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces**
- Consumes: `purgeUserData`, `PurgeIncompleteError` (Task 5); `isDataCategory` (Task 5).
- Produces: `deleteAllData(categories?): Promise<{ deleted: DataCategory[]; pending: DataCategory[] }>`, plus the lib helper `deletionOutcome(run: () => Promise<PurgeOutcome>): Promise<{ deleted: DataCategory[]; pending: DataCategory[] }>` exported from `src/lib/user-data.ts` so it can be tested without a session.

- [ ] **Step 1: Failing test**

Create `scripts/smoke-delete-partial.ts`:

```ts
/**
 * A delete that stops part-way reports what finished and what is pending, as data.
 * Run: npx tsx scripts/smoke-delete-partial.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { deletionOutcome, purgeUserData } from "../src/lib/user-data";

const USER = "smoke-delete-partial-user";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const db = await getDb();
  await db.insert(schema.userSettings).values({ userId: USER });
  const whole = await deletionOutcome(() => purgeUserData(USER, { only: ["chat", "goals"] }));
  check("a finished delete lists its categories", whole.deleted.sort().join(",") === "chat,goals" && whole.pending.length === 0, JSON.stringify(whole));

  await db.execute(sql`ALTER TABLE user_goals RENAME TO user_goals_parked`);
  try {
    const partial = await deletionOutcome(() => purgeUserData(USER, { only: ["events", "goals", "tags"] }));
    check("a stopped delete does not throw", true);
    check("...reports what finished (events runs before goals)", partial.deleted.join(",") === "events", JSON.stringify(partial));
    check("...and what is pending", partial.pending.join(",") === "goals,tags", JSON.stringify(partial));
    check("...never the internal billing step", ![...partial.deleted, ...partial.pending].includes("billing" as never));
  } finally {
    await db.execute(sql`ALTER TABLE IF EXISTS user_goals_parked RENAME TO user_goals`);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  console.log("\nAll partial-delete checks passed.");
}

run(main);
```

Register `"smoke-delete-partial": "pglite",`. Run it. Expected: `deletionOutcome` is not exported.

- [ ] **Step 2: The helper (`src/lib/user-data.ts`)**

Add `isDataCategory` to the `@/lib/data-categories` import, then append:

```ts
/**
 * A purge's result in the shape the settings dialog shows: categories only (the billing step
 * is bookkeeping, not something the user picked), and a stop reported as data rather than a
 * throw, because a thrown server-action error reaches production only as a digest.
 */
export async function deletionOutcome(
  runPurge: () => Promise<PurgeOutcome>
): Promise<{ deleted: DataCategory[]; pending: DataCategory[] }> {
  try {
    const outcome = await runPurge();
    return { deleted: outcome.completed.filter(isDataCategory), pending: [] };
  } catch (err) {
    if (!(err instanceof PurgeIncompleteError)) throw err;
    return {
      deleted: err.completed.filter(isDataCategory),
      pending: err.pending.filter(isDataCategory),
    };
  }
}
```

- [ ] **Step 3: The action (`src/actions/settings.ts`)**

Replace `expandCategories,` in the `@/lib/user-data` import with `deletionOutcome,` (it is no longer used here; keep `DATA_CATEGORY_IDS`, `getDataFootprint`, `purgeUserData`, `type DataCategory`). Replace the body of `deleteAllData` from `await purgeUserData(userId, only ? { only } : {});` to the end of the function with:

```ts
  const result = await deletionOutcome(() => purgeUserData(userId, only ? { only } : {}));

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/settings");
  revalidatePath("/outreach");

  return result;
}
```

Also change the early return to `if (only.length === 0) return { deleted: [] as DataCategory[], pending: [] as DataCategory[] };`.

- [ ] **Step 4: The dialog**

In `delete-data-dialog.tsx`:

4a. After the `footprint` state, add:

```tsx
  // Set when a delete stopped part-way; the dialog stays open to say what happened.
  const [partial, setPartial] = useState<{
    deleted: DataCategory[];
    pending: DataCategory[];
  } | null>(null);
```

and add `setPartial(null);` inside `reset`.

4b. In `submit`, replace `const { deleted } = await deleteAllData(chosen);` through `router.refresh();` (the success path) with:

```tsx
        const { deleted, pending: stillPending } = await deleteAllData(chosen);
        if (stillPending.length > 0) {
          setPartial({ deleted, pending: stillPending });
          setTyped("");
          toast.warning(
            `Deleted ${deleted.length} of ${deleted.length + stillPending.length} categories — Orbit will finish the rest on its own`
          );
          router.refresh();
          return;
        }
        setOpen(false);
        reset();
        toast.success(
          deleted.length === DATA_CATEGORY_IDS.length
            ? "All data deleted"
            : `Deleted ${deleted.length} ${deleted.length === 1 ? "category" : "categories"}`
        );
        router.refresh();
```

4c. Directly before `<label className="block space-y-1.5">`, add:

```tsx
        {partial && (
          <div
            role="status"
            className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-snug"
          >
            <p className="font-medium text-foreground">Part of this is still being deleted</p>
            <p className="mt-1 text-muted-foreground">
              Done: {labelsFor(partial.deleted)}
            </p>
            <p className="mt-1 text-muted-foreground">
              Still to go: {labelsFor(partial.pending)}. Orbit retries these on its own within a
              day — there’s nothing more you need to do
            </p>
          </div>
        )}
```

and above the component add:

```tsx
function labelsFor(ids: readonly DataCategory[]): string {
  if (ids.length === 0) return "nothing yet";
  return DATA_CATEGORY_META.filter((c) => ids.includes(c.id))
    .map((c) => c.label)
    .join(", ");
}
```

- [ ] **Step 5: Verify**

```bash
npx tsx scripts/smoke-delete-partial.ts
npx tsx scripts/smoke-purge-selective.ts
npx tsx scripts/smoke-toast-copy.ts
npm run typecheck && npm run lint
```

Browser: temporarily add `throw new Error("verify partial");` as the first line of `STEPS.goals.run` (do not commit it). Start `orbit-web`, open Settings → Data and privacy → Delete data…, type `delete` with real keystrokes, and delete everything. Expect the warning toast, and the dialog still open showing "Done: AI suggestions…, Events and attendees" and "Still to go: Networking goals, …". Remove the throw, restart, and confirm a normal delete closes the dialog with "All data deleted".

- [ ] **Step 6: Commit**

```bash
git add src/lib/user-data.ts src/actions/settings.ts src/components/settings/delete-data-dialog.tsx scripts/smoke-delete-partial.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Show which categories a stopped delete finished, and that the rest completes on its own

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Purge accounts whose Clerk user is gone (missed `user.deleted`)

This daily step catches deletions the webhook never delivered, for example after a rotated `CLERK_WEBHOOK_SIGNING_SECRET` or an outage longer than Svix's retry window. It takes candidate `user_settings` rows (Clerk-shaped ids, inactive for more than 7 days, at most 300 per run), asks Clerk which still exist 100 ids at a time, and purges the missing ones with `keepSettings: false`, at most 25 per run. It aborts without purging anything if more than half of a batch of 10+ reads as missing. That pattern means a wrong-instance `CLERK_SECRET_KEY` or a Clerk incident, not a wave of deletions. It never runs when Clerk is unconfigured.

Verified API (`node_modules/@clerk/backend/dist/api/endpoints/UserApi.d.ts`, v3.11.7): `getUserList(params?: UserListParams): Promise<PaginatedResourceResponse<User[]>>`, where `userId?: string[]` "accepts up to 100 user IDs". `limit` defaults to 10, so it must be passed.

**Files:**
- Create: `src/lib/clerk-orphan-sweep.ts`
- Modify: `src/app/api/imports/process-stalled/route.ts` — imports, `stats`, a try block after Task 5's purge block
- Create: `scripts/smoke-clerk-orphan-sweep.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces**
- Consumes: `purgeUserData` (Task 5); `isClerkConfigured` from `src/lib/demo-account.ts`.
- Produces: `type ExistingClerkUsers = (userIds: string[]) => Promise<Set<string>>`; `sweepOrphanedAccounts(opts: { lookup: ExistingClerkUsers; now: Date; maxCandidates?: number; maxPurges?: number; purge?: (userId: string) => Promise<unknown> }): Promise<{ examined: number; orphaned: number; purged: number; purgeErrors: number; aborted: boolean }>`.

- [ ] **Step 1: Failing test**

Create `scripts/smoke-clerk-orphan-sweep.ts`:

```ts
/**
 * The missed-webhook sweep purges only accounts Clerk no longer has, only once they have been
 * idle a week, never non-Clerk ids, and stops cold when Clerk says "everyone is gone".
 * Run: npx tsx scripts/smoke-clerk-orphan-sweep.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { sweepOrphanedAccounts } from "../src/lib/clerk-orphan-sweep";

const NOW = new Date("2026-09-20T03:00:00Z");
const OLD = new Date("2026-09-01T00:00:00Z");
const RECENT = new Date("2026-09-19T00:00:00Z");

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function exists(userId: string) {
  const db = await getDb();
  return (await db.select().from(userSettings).where(inArray(userSettings.userId, [userId]))).length === 1;
}

async function main() {
  const db = await getDb();
  await db.delete(userSettings).where(like(userSettings.userId, "user_smoke_orphan%"));
  await db.insert(userSettings).values([
    { userId: "user_smoke_orphan_alive", lastActiveAt: OLD },
    { userId: "user_smoke_orphan_gone", lastActiveAt: OLD },
    { userId: "user_smoke_orphan_gone_recent", lastActiveAt: RECENT },
    { userId: "demo-user-smoke-orphan", lastActiveAt: OLD },
  ]);
  const alive = new Set(["user_smoke_orphan_alive"]);
  const asked: string[][] = [];
  const result = await sweepOrphanedAccounts({
    now: NOW,
    lookup: async (ids) => {
      asked.push(ids);
      return new Set(ids.filter((id) => alive.has(id)));
    },
  });
  check("the missing, idle Clerk account is purged", !(await exists("user_smoke_orphan_gone")) && result.purged === 1, JSON.stringify(result));
  check("a live account is untouched", await exists("user_smoke_orphan_alive"));
  check("a recently active account is not even asked about", await exists("user_smoke_orphan_gone_recent") && !asked.flat().includes("user_smoke_orphan_gone_recent"));
  check("a non-Clerk id is never considered", await exists("demo-user-smoke-orphan") && !asked.flat().includes("demo-user-smoke-orphan"));
  check("every lookup batch is at most 100 ids", asked.every((b) => b.length <= 100));

  console.log("\nClerk reporting everyone gone");
  const many = Array.from({ length: 12 }, (_, i) => ({ userId: `user_smoke_orphan_bulk_${i}`, lastActiveAt: OLD }));
  await db.insert(userSettings).values(many);
  const aborted = await sweepOrphanedAccounts({ now: NOW, lookup: async () => new Set() });
  check("the sweep aborts", aborted.aborted === true && aborted.purged === 0, JSON.stringify(aborted));
  check("...and purges nobody", await exists("user_smoke_orphan_bulk_0"));

  console.log("\nThe per-run cap");
  const capped = await sweepOrphanedAccounts({
    now: NOW,
    maxPurges: 2,
    lookup: async (ids) => {
      const gone = ["user_smoke_orphan_bulk_0", "user_smoke_orphan_bulk_1", "user_smoke_orphan_bulk_2"];
      return new Set(ids.filter((id) => !gone.includes(id)));
    },
  });
  check("no more than maxPurges accounts are purged in one run", capped.purged === 2 && capped.orphaned === 3, JSON.stringify(capped));

  await db.delete(userSettings).where(like(userSettings.userId, "user_smoke_orphan%"));
  await db.delete(userSettings).where(inArray(userSettings.userId, ["demo-user-smoke-orphan"]));
  console.log("\nAll orphan-sweep checks passed.");
}

run(main);
```

Register `"smoke-clerk-orphan-sweep": "pglite",`. Run it. Expected: module not found.

- [ ] **Step 2: Create `src/lib/clerk-orphan-sweep.ts`**

```ts
import { and, like, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { purgeUserData } from "@/lib/user-data";

/**
 * Reconciles `user_settings` against Clerk, for the deletions the `user.deleted` webhook never
 * delivered. Clerk is injected (`lookup`) so this module needs no `@clerk/nextjs/server`
 * import — that reaches `next/server` and would hang every script that loads it.
 */
export const ORPHAN_INACTIVE_DAYS = 7;
export const ORPHAN_LOOKUP_BATCH = 100;
export const ORPHAN_MAX_CANDIDATES = 300;
export const ORPHAN_MAX_PURGES = 25;
const ABORT_MIN_MISSING = 10;
const ABORT_RATIO = 0.5;

/** Returns the subset of `userIds` that Clerk still has. */
export type ExistingClerkUsers = (userIds: string[]) => Promise<Set<string>>;

export async function sweepOrphanedAccounts(opts: {
  lookup: ExistingClerkUsers;
  now: Date;
  maxCandidates?: number;
  maxPurges?: number;
  purge?: (userId: string) => Promise<unknown>;
}) {
  const purge = opts.purge ?? ((userId: string) => purgeUserData(userId, { keepSettings: false }));
  const maxPurges = opts.maxPurges ?? ORPHAN_MAX_PURGES;
  const cutoff = new Date(opts.now.getTime() - ORPHAN_INACTIVE_DAYS * 24 * 60 * 60 * 1000);
  const result = { examined: 0, orphaned: 0, purged: 0, purgeErrors: 0, aborted: false };

  const db = await getDb();
  // Random order so a large roster is covered over successive nights instead of the same
  // oldest 300 forever. `user_` prefix: only real Clerk ids — never the local demo account
  // or smoke fixtures that share a database.
  const candidates = await db
    .select({ userId: userSettings.userId })
    .from(userSettings)
    .where(
      and(
        like(userSettings.userId, "user\\_%"),
        lt(sql`coalesce(${userSettings.lastActiveAt}, ${userSettings.createdAt})`, cutoff)
      )
    )
    .orderBy(sql`random()`)
    .limit(opts.maxCandidates ?? ORPHAN_MAX_CANDIDATES);

  const ids = candidates.map((c) => c.userId);
  for (let i = 0; i < ids.length; i += ORPHAN_LOOKUP_BATCH) {
    const batch = ids.slice(i, i + ORPHAN_LOOKUP_BATCH);
    const existing = await opts.lookup(batch);
    result.examined += batch.length;
    const missing = batch.filter((id) => !existing.has(id));
    if (missing.length >= ABORT_MIN_MISSING && missing.length / batch.length > ABORT_RATIO) {
      // A wrong-instance secret or a Clerk incident, not a wave of deletions. Stop cold.
      result.aborted = true;
      return result;
    }
    result.orphaned += missing.length;
    for (const userId of missing) {
      if (result.purged + result.purgeErrors >= maxPurges) break;
      try {
        await purge(userId);
        result.purged += 1;
      } catch {
        // The purge run is recorded; the nightly resume (or purge.stuck) takes it from here.
        result.purgeErrors += 1;
      }
    }
  }
  return result;
}
```

- [ ] **Step 3: Wire it into the nightly job**

In `src/app/api/imports/process-stalled/route.ts`, add `import { clerkClient } from "@clerk/nextjs/server";`, `import { isClerkConfigured } from "@/lib/demo-account";` and `import { sweepOrphanedAccounts } from "@/lib/clerk-orphan-sweep";`. In `stats` after `purgeRunsPruned: 0,` add:

```ts
    /** Missed user.deleted webhooks: accounts checked against Clerk, and purged. */
    orphansExamined: 0,
    orphansPurged: 0,
    orphanPurgeErrors: 0,
    orphanSweepAborted: false,
```

Directly after Task 5's purge-resume `try { … } catch { status = "partial"; }` block, add:

```ts
    try {
      if (isClerkConfigured() && process.env.CLERK_SECRET_KEY) {
        const clerk = await clerkClient();
        const sweep = await sweepOrphanedAccounts({
          now: new Date(),
          lookup: async (ids) => {
            const res = await clerk.users.getUserList({ userId: ids, limit: ids.length });
            return new Set(res.data.map((u) => u.id));
          },
        });
        stats.orphansExamined = sweep.examined;
        stats.orphansPurged = sweep.purged;
        stats.orphanPurgeErrors = sweep.purgeErrors;
        stats.orphanSweepAborted = sweep.aborted;
        if (sweep.aborted || sweep.purgeErrors > 0) status = "partial";
      }
    } catch {
      status = "partial";
    }
```

(`cron_runs.stats` is typed `Record<string, number | boolean>`, so the boolean is fine.)

- [ ] **Step 4: Verify and commit**

```bash
npx tsx scripts/smoke-clerk-orphan-sweep.ts
npm run typecheck && npm run lint
git add src/lib/clerk-orphan-sweep.ts src/app/api/imports/process-stalled/route.ts scripts/smoke-clerk-orphan-sweep.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Purge accounts whose Clerk user no longer exists, nightly and capped

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Revoke the Google grant on disconnect and on purge

Deleting the `gmail_connections` row leaves Orbit's access live in the user's Google account. Both `disconnectGmail` and the `connections` purge step now POST the decrypted refresh token (or the access token, when there is no refresh token) to `https://oauth2.googleapis.com/revoke`. The row is deleted first. The revoke is best-effort with a 5 s timeout and never throws, so it cannot block a deletion.

**Files:**
- Create: `src/lib/oauth-revoke.ts`
- Modify: `src/actions/gmail.ts` — `disconnectGmail` (104–109)
- Modify: `src/lib/user-data.ts` — `STEPS.connections.run` (193–202), import
- Create: `scripts/smoke-oauth-revoke.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces**
- Consumes: `decryptOrNull` (`src/lib/crypto.ts:39`).
- Produces: `GOOGLE_REVOKE_URL`, `REVOKE_TIMEOUT_MS = 5000`, `type RevokeResult = "revoked" | "already_invalid" | "skipped" | "error"`, `revokeGoogleToken(token: string | null, opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<RevokeResult>`, `revokeGoogleGrant(row: { refreshTokenEncrypted: string | null; accessTokenEncrypted: string | null }, opts?): Promise<RevokeResult>`.

- [ ] **Step 1: Failing test**

Create `scripts/smoke-oauth-revoke.ts`:

```ts
/**
 * Google grant revocation: the exact request, every outcome mapped, never a throw, and the
 * connections purge step revoking before the token is gone. Run: npx tsx scripts/smoke-oauth-revoke.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_REVOKE_URL, revokeGoogleGrant, revokeGoogleToken } from "../src/lib/oauth-revoke";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-oauth-revoke-user";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

type Call = { url: string; body: string; method: string };
function fakeFetch(status: number, calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? ""), method: String(init?.method) });
    return new Response(null, { status });
  }) as typeof fetch;
}

async function main() {
  console.log("revokeGoogleToken");
  const calls: Call[] = [];
  check("200 → revoked", (await revokeGoogleToken("tok-1", { fetchImpl: fakeFetch(200, calls) })) === "revoked");
  check("...as a form POST to Google's revoke endpoint", calls[0]?.url === GOOGLE_REVOKE_URL && calls[0]?.method === "POST" && calls[0]?.body === "token=tok-1", JSON.stringify(calls[0]));
  check("400 → already_invalid", (await revokeGoogleToken("tok", { fetchImpl: fakeFetch(400, []) })) === "already_invalid");
  check("500 → error", (await revokeGoogleToken("tok", { fetchImpl: fakeFetch(500, []) })) === "error");
  check("no token → skipped, no request", (await revokeGoogleToken(null, { fetchImpl: fakeFetch(200, calls) })) === "skipped" && calls.length === 1);
  const throwing = (async () => { throw new Error("network down"); }) as typeof fetch;
  check("a network error → error, not a throw", (await revokeGoogleToken("tok", { fetchImpl: throwing })) === "error");
  const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const started = Date.now();
  check("a hung request times out → error", (await revokeGoogleToken("tok", { fetchImpl: hanging, timeoutMs: 50 })) === "error" && Date.now() - started < 2000);

  console.log("\nrevokeGoogleGrant");
  const grantCalls: Call[] = [];
  await revokeGoogleGrant({ refreshTokenEncrypted: encrypt("refresh-plain"), accessTokenEncrypted: encrypt("access-plain") }, { fetchImpl: fakeFetch(200, grantCalls) });
  check("prefers the refresh token (revoking it ends the whole grant)", grantCalls[0]?.body === "token=refresh-plain");
  await revokeGoogleGrant({ refreshTokenEncrypted: null, accessTokenEncrypted: encrypt("access-plain") }, { fetchImpl: fakeFetch(200, grantCalls) });
  check("falls back to the access token", grantCalls[1]?.body === "token=access-plain");
  check("an undecryptable token is skipped", (await revokeGoogleGrant({ refreshTokenEncrypted: "garbage", accessTokenEncrypted: "garbage" }, { fetchImpl: fakeFetch(200, grantCalls) })) === "skipped");

  console.log("\nThe connections purge step");
  const db = await getDb();
  await db.insert(schema.gmailConnections).values({
    userId: USER,
    emailAddress: "revoke@example.test",
    accessTokenEncrypted: encrypt("purge-access"),
    refreshTokenEncrypted: encrypt("purge-refresh"),
  });
  const realFetch = globalThis.fetch;
  const purgeCalls: Call[] = [];
  globalThis.fetch = fakeFetch(200, purgeCalls);
  try {
    await purgeUserData(USER, { only: ["connections"] });
  } finally {
    globalThis.fetch = realFetch;
  }
  check("purging connections revokes the Google grant", purgeCalls.some((c) => c.url === GOOGLE_REVOKE_URL && c.body === "token=purge-refresh"), JSON.stringify(purgeCalls));
  check("...and the row is gone", (await db.query.gmailConnections.findMany()).every((r) => r.userId !== USER));
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  console.log("\nAll revoke checks passed.");
}

run(main);
```

Register `"smoke-oauth-revoke": "pglite",`. Run it. Expected: module not found.

- [ ] **Step 2: Create `src/lib/oauth-revoke.ts`**

```ts
import { decryptOrNull } from "@/lib/crypto";

/**
 * Best-effort revocation of Orbit's Google grant. Deleting our row alone leaves the grant
 * listed (and usable with the stolen token) in the user's Google account. Never throws, and
 * gives up after five seconds: a deletion must not wait on Google.
 *
 * Microsoft has no equivalent: the identity platform offers no endpoint that revokes one
 * app's delegated refresh token, and `POST /me/revokeSignInSessions` signs the user out of
 * EVERY app. The Outlook disconnect dialog points the user at their Microsoft account
 * instead (Task 10).
 */
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const REVOKE_TIMEOUT_MS = 5_000;

export type RevokeResult = "revoked" | "already_invalid" | "skipped" | "error";

export async function revokeGoogleToken(
  token: string | null,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<RevokeResult> {
  if (!token) return "skipped";
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? REVOKE_TIMEOUT_MS),
    });
    if (res.ok) return "revoked";
    // Google answers 400 invalid_token for a token that is already revoked or expired.
    if (res.status === 400) return "already_invalid";
    return "error";
  } catch {
    return "error";
  }
}

/** Revoking the refresh token ends the whole grant; the access token is the fallback. */
export async function revokeGoogleGrant(
  row: { refreshTokenEncrypted: string | null; accessTokenEncrypted: string | null },
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<RevokeResult> {
  const token = decryptOrNull(row.refreshTokenEncrypted) ?? decryptOrNull(row.accessTokenEncrypted);
  return revokeGoogleToken(token, opts);
}
```

- [ ] **Step 3: `disconnectGmail`**

In `src/actions/gmail.ts` add `import { revokeGoogleGrant } from "@/lib/oauth-revoke";` and replace `disconnectGmail` with:

```ts
export async function disconnectGmail() {
  const userId = await requireUserId();
  const db = await getDb();
  const grant = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { refreshTokenEncrypted: true, accessTokenEncrypted: true },
  });
  // Row first: the disconnect is done even if Google never answers.
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, userId));
  if (grant) await revokeGoogleGrant(grant);
  revalidatePath("/recruiters");
}
```

- [ ] **Step 4: The `connections` purge step**

In `src/lib/user-data.ts` add `import { revokeGoogleGrant } from "@/lib/oauth-revoke";`. In `STEPS.connections.run`, before `await db.delete(calendarSubscriptions)…`, add:

```ts
      // Read before the delete: once the row is gone there is nothing to revoke with.
      const googleGrants = await db
        .select({
          refreshTokenEncrypted: gmailConnections.refreshTokenEncrypted,
          accessTokenEncrypted: gmailConnections.accessTokenEncrypted,
        })
        .from(gmailConnections)
        .where(eq(gmailConnections.userId, userId));
```

and at the end of that `run` body, after the `eventProviderConnections` delete, add:

```ts
      // Best-effort and time-boxed (see oauth-revoke.ts): a Google outage must never
      // block an erasure. Outlook has no per-app revoke endpoint; Luma keys and Eventbrite
      // tokens have none Orbit can call.
      for (const grant of googleGrants) await revokeGoogleGrant(grant);
```

- [ ] **Step 5: Verify and commit**

```bash
npx tsx scripts/smoke-oauth-revoke.ts
npx tsx scripts/smoke-purge.ts
npx tsx scripts/smoke-purge-selective.ts
npm run typecheck && npm run lint
git add src/lib/oauth-revoke.ts src/actions/gmail.ts src/lib/user-data.ts scripts/smoke-oauth-revoke.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Revoke the Google grant when Gmail is disconnected or connections are purged

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

Expected: all exit 0. The two purge smokes seed `ciphertext-*` tokens that do not decrypt, so their revoke is `skipped` and no request leaves the machine.

---

### Task 10: A disconnect confirmation that can also delete what the account imported

Today every Disconnect button acts immediately. They now open one shared dialog. For Google it says Orbit will ask Google to revoke access, and it offers "Also delete what Orbit imported from this account", wired to existing selective-deletion categories. For Outlook it says Microsoft offers no app-side revoke and links to https://myaccount.microsoft.com/.

**Decision: which categories.** Categories are coarse, so the option lists only categories that Gmail actually fills. Google: `recruiters` (the Gmail recruiter scan's links, drafts, sent mail and watermark; the dialog shows the category's own description, which says manual recruiter links go too). Outlook fills only contacts, and deleting the `contacts` category would delete every contact, so Outlook gets no delete option. The dialog explains how to remove Outlook-imported contacts instead. Deleting just the contacts that came from one provider needs a per-source contact delete, which is out of scope. See Self-review.

**Files:**
- Modify: `src/lib/data-categories.ts` (append)
- Modify: `src/actions/gmail.ts` — `disconnectGmail` (Task 9 version); `src/actions/outlook.ts` — `disconnectOutlook` (73–77)
- Create: `src/components/settings/disconnect-account-dialog.tsx`
- Modify: `src/components/imports/google-contacts-import.tsx` (Disconnect button, 181–195), `src/components/recruiters/gmail-import-panel.tsx` (250–262), `src/components/imports/outlook-contacts-import.tsx` (169–183)
- Create: `scripts/smoke-disconnect-categories.ts` (pure); Modify: `scripts/run-smoke.ts`

**Interfaces**
- Consumes: `purgeUserData` (Task 5), `revokeGoogleGrant` (Task 9), `DATA_CATEGORY_META`.
- Produces: `type DisconnectProvider = "gmail" | "outlook"`, `DISCONNECT_DELETE_CATEGORIES: Readonly<Record<DisconnectProvider, readonly DataCategory[]>>`, `MICROSOFT_ACCOUNT_URL`; `disconnectGmail(opts?: { alsoDelete?: boolean })`, `disconnectOutlook(opts?: { alsoDelete?: boolean })`; `<DisconnectAccountDialog provider disabled onConfirm />`.

- [ ] **Step 1: Failing test**

Create `scripts/smoke-disconnect-categories.ts`:

```ts
/**
 * What "Also delete what Orbit imported" may delete. Run: npx tsx scripts/smoke-disconnect-categories.ts
 */
import {
  DATA_CATEGORY_IDS,
  DISCONNECT_DELETE_CATEGORIES,
  expandCategories,
} from "../src/lib/data-categories";

let failures = 0;
function check(label: string, ok: boolean) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

for (const [provider, ids] of Object.entries(DISCONNECT_DELETE_CATEGORIES)) {
  check(`${provider}: every id is a real category`, ids.every((id) => DATA_CATEGORY_IDS.includes(id)));
  // `contacts` implies notes, reminders and insights — the whole network, never "what one
  // account imported".
  check(`${provider}: never reaches contacts`, !expandCategories(ids).has("contacts"));
  check(`${provider}: expands to nothing it did not name`, expandCategories(ids).size === ids.length);
}
check("Google offers the recruiter scan's data", DISCONNECT_DELETE_CATEGORIES.gmail.includes("recruiters"));
check("Outlook offers nothing (it only fills contacts)", DISCONNECT_DELETE_CATEGORIES.outlook.length === 0);

if (failures > 0) process.exit(1);
console.log("\nAll disconnect-category checks passed.");
process.exit(0);
```

Register `"smoke-disconnect-categories": "pure",`. Run it. Expected: `DISCONNECT_DELETE_CATEGORIES` is undefined.

- [ ] **Step 2: Metadata (`src/lib/data-categories.ts`)**

```ts
export type DisconnectProvider = "gmail" | "outlook";

/**
 * What "Also delete what Orbit imported from this account" deletes, as whole categories
 * from the registry above, so the dialog can show each one's own label and description.
 * Only categories an account actually fills and that stay within it: Gmail feeds the
 * recruiter scan; Outlook feeds only contacts, and the `contacts` category is every contact.
 */
export const DISCONNECT_DELETE_CATEGORIES: Readonly<
  Record<DisconnectProvider, readonly DataCategory[]>
> = {
  gmail: ["recruiters"],
  outlook: [],
};

/** Where a user removes Orbit's Outlook access themselves (no app-side revoke exists). */
export const MICROSOFT_ACCOUNT_URL = "https://myaccount.microsoft.com/";
```

- [ ] **Step 3: The actions**

`src/actions/gmail.ts`: add `import { purgeUserData } from "@/lib/user-data";` and `import { DISCONNECT_DELETE_CATEGORIES } from "@/lib/data-categories";`, change the signature to `export async function disconnectGmail(opts: { alsoDelete?: boolean } = {})`, and before `revalidatePath("/recruiters");` add:

```ts
  if (opts.alsoDelete === true) {
    await purgeUserData(userId, { only: DISCONNECT_DELETE_CATEGORIES.gmail });
  }
```

`src/actions/outlook.ts`: add `import { revalidatePath } from "next/cache";`, `import { purgeUserData } from "@/lib/user-data";`, `import { DISCONNECT_DELETE_CATEGORIES } from "@/lib/data-categories";` and replace `disconnectOutlook` with:

```ts
/**
 * Deleting the row is all Orbit can do: Microsoft has no endpoint that revokes one app's
 * delegated token (`revokeSignInSessions` would sign the user out of every app). The
 * disconnect dialog links the user to their Microsoft account to remove the grant there.
 */
export async function disconnectOutlook(opts: { alsoDelete?: boolean } = {}) {
  const userId = await requireUserId();
  const db = await getDb();
  await db.delete(outlookConnections).where(eq(outlookConnections.userId, userId));
  const extra = DISCONNECT_DELETE_CATEGORIES.outlook;
  if (opts.alsoDelete === true && extra.length > 0) {
    await purgeUserData(userId, { only: extra });
  }
  revalidatePath("/settings");
}
```

- [ ] **Step 4: The dialog component**

Create `src/components/settings/disconnect-account-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DATA_CATEGORY_META,
  DISCONNECT_DELETE_CATEGORIES,
  MICROSOFT_ACCOUNT_URL,
  type DisconnectProvider,
} from "@/lib/data-categories";

const NAMES: Record<DisconnectProvider, string> = { gmail: "Google", outlook: "Outlook" };

/** One confirmation for every Gmail/Outlook Disconnect button. DB-free imports only. */
export function DisconnectAccountDialog({
  provider,
  disabled,
  onConfirm,
}: {
  provider: DisconnectProvider;
  disabled?: boolean;
  onConfirm: (opts: { alsoDelete: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [alsoDelete, setAlsoDelete] = useState(false);
  const name = NAMES[provider];
  const extra = DATA_CATEGORY_META.filter((c) =>
    DISCONNECT_DELETE_CATEGORIES[provider].includes(c.id)
  );

  return (
    <>
      <Button variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        Disconnect
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setAlsoDelete(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect {name}?</DialogTitle>
            <DialogDescription>
              {provider === "gmail" ? (
                <>Orbit deletes its copy of the sign-in and asks Google to revoke its access.</>
              ) : (
                <>
                  Orbit deletes its copy of the sign-in. Microsoft doesn’t let apps revoke their
                  own access, so to remove Orbit completely, open{" "}
                  <a
                    href={MICROSOFT_ACCOUNT_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    your Microsoft account
                  </a>{" "}
                  and remove Orbit from the apps with access.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {extra.length > 0 ? (
            <label className="flex cursor-pointer gap-3 rounded-lg p-2 hover:bg-muted/60">
              <Checkbox
                checked={alsoDelete}
                onCheckedChange={(v) => setAlsoDelete(v === true)}
                aria-label="Also delete what Orbit imported from this account"
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="text-sm font-medium text-ink">
                  Also delete what Orbit imported from this account
                </span>
                {extra.map((c) => (
                  <span key={c.id} className="mt-1 block text-xs leading-snug text-muted-foreground">
                    <span className="font-medium text-foreground/80">{c.label}:</span> {c.description}
                  </span>
                ))}
              </span>
            </label>
          ) : (
            <p className="text-xs leading-snug text-muted-foreground">
              Contacts imported from {name} stay in Orbit. Delete them from Contacts, or remove
              everything in Settings → Data and privacy.
            </p>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const choice = { alsoDelete };
                setOpen(false);
                setAlsoDelete(false);
                onConfirm(choice);
              }}
            >
              {alsoDelete ? "Disconnect and delete" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 5: Use it at the three call sites**

In each file, import `DisconnectAccountDialog` from `@/components/settings/disconnect-account-dialog` and replace the `<Button variant="outline" … onClick={() => start(async () => { await disconnectX(); … })}>Disconnect</Button>` element with the dialog, keeping the existing post-disconnect body unchanged inside `onConfirm`:

`google-contacts-import.tsx`:

```tsx
              <DisconnectAccountDialog
                provider="gmail"
                disabled={busy}
                onConfirm={(opts) =>
                  start(async () => {
                    await disconnectGmail(opts);
                    setPeople([]);
                    setLoaded(false);
                    setStatus(null);
                    toast.success(opts.alsoDelete ? "Google disconnected and its recruiter data deleted" : "Google disconnected");
                    router.refresh();
                    getGmailConnectionStatus().then(setStatus).catch(() => {});
                  })
                }
              />
```

`gmail-import-panel.tsx`:

```tsx
              <DisconnectAccountDialog
                provider="gmail"
                disabled={pending || running}
                onConfirm={(opts) =>
                  start(async () => {
                    await disconnectGmail(opts);
                    setScan(null);
                    toast.success(opts.alsoDelete ? "Gmail disconnected and its recruiter data deleted" : "Gmail disconnected");
                    router.refresh();
                  })
                }
              />
```

`outlook-contacts-import.tsx`:

```tsx
              <DisconnectAccountDialog
                provider="outlook"
                disabled={busy}
                onConfirm={(opts) =>
                  start(async () => {
                    await disconnectOutlook(opts);
                    setPeople([]);
                    setLoaded(false);
                    setStatus(null);
                    toast.success("Outlook disconnected");
                    router.refresh();
                    getOutlookConnectionStatus().then(setStatus).catch(() => {});
                  })
                }
              />
```

Remove `Button` from a file's imports only if lint reports it unused.

- [ ] **Step 6: Verify**

```bash
npx tsx scripts/smoke-disconnect-categories.ts
npx tsx scripts/smoke-toast-copy.ts
npm run typecheck && npm run lint
```

Browser (`orbit-web`): Settings → Integrations. A connected account is needed to see Disconnect. If none is connected in demo mode, temporarily render `<DisconnectAccountDialog provider="gmail" onConfirm={() => {}} />` and `provider="outlook"` on the settings page, check both dialogs (the Google option with the recruiter description, the Outlook text and the Microsoft link opening in a new tab, Cancel closing without calling `onConfirm`), then remove the temporary render. Check the Microsoft link at 375 px width too.

- [ ] **Step 7: Commit**

```bash
git add src/lib/data-categories.ts src/actions/gmail.ts src/actions/outlook.ts src/components/settings/disconnect-account-dialog.tsx src/components/imports/google-contacts-import.tsx src/components/recruiters/gmail-import-panel.tsx src/components/imports/outlook-contacts-import.tsx scripts/smoke-disconnect-categories.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Confirm disconnects, offer to delete imported recruiter data, explain Outlook revocation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Unguessable avatar blobs, and a delete helper

`persistAvatar` (`src/lib/contact-avatar.ts:374–401`) writes `avatars/<contactId>.jpg` as a public Blob with `addRandomSuffix: false`. Anyone who knows a contact id can fetch that URL. And @vercel/blob 2.8 refuses to overwrite without `allowOverwrite`, so a second photo for the same contact already throws `AvatarStorageError`. This task moves the Blob calls into `src/lib/avatar-blob.ts`, which uses `addRandomSuffix: true` and stores the returned URL, exactly as the URL is persisted today (the caller writes the returned string to `contacts.profile_image_url`). It adds `deleteAvatarBlobs` for Tasks 12–13, and deletes the replaced blob in the one path that swaps one stored photo for another (the Apollo/LinkedIn refresh). With no `BLOB_READ_WRITE_TOKEN`, nothing changes: photos stay inline data URIs, and the delete helper skips non-Blob URLs without calling the client.

**Files:**
- Create: `src/lib/avatar-blob.ts`
- Modify: `src/lib/contact-avatar.ts` — import (line 2), `persistAvatar` doc and Blob branch (361–401)
- Modify: `src/actions/contacts.ts` — refresh loop's two `updateContact(... profileImageUrl ...)` calls (1246–1275), import
- Create: `scripts/smoke-avatar-blob.ts` (pure); Modify: `scripts/run-smoke.ts`

**Interfaces**
- Produces: `type AvatarBlobClient = { put(pathname: string, body: Buffer, options: { access: "public"; contentType: string; addRandomSuffix: boolean }): Promise<{ url: string }>; del(urls: string[]): Promise<void> }`; `setAvatarBlobClientForTests(client: AvatarBlobClient | null): void`; `isAvatarBlobUrl(url: string | null | undefined): url is string`; `putAvatarBlob(contactId: string, body: Buffer, contentType: string): Promise<string>`; `deleteAvatarBlobs(urls: ReadonlyArray<string | null | undefined>): Promise<number>`; `deleteReplacedAvatar(previous: string | null | undefined, next: string | null | undefined): Promise<void>`.

- [ ] **Step 1: Failing test**

Create `scripts/smoke-avatar-blob.ts`:

```ts
/**
 * Avatar Blob writes are unguessable and deletes are best-effort, through an injected client.
 * Run: npx tsx scripts/smoke-avatar-blob.ts
 */
import {
  deleteAvatarBlobs,
  deleteReplacedAvatar,
  isAvatarBlobUrl,
  putAvatarBlob,
  setAvatarBlobClientForTests,
  type AvatarBlobClient,
} from "../src/lib/avatar-blob";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const BLOB = (name: string) => `https://abc123.public.blob.vercel-storage.com/avatars/${name}.jpg`;
const puts: Array<{ pathname: string; options: Record<string, unknown> }> = [];
const dels: string[][] = [];
let failDel = false;
const fake: AvatarBlobClient = {
  put: async (pathname, _body, options) => {
    puts.push({ pathname, options });
    return { url: BLOB(`c1-Xy7Rq2`) };
  },
  del: async (urls) => {
    if (failDel) throw new Error("blob outage");
    dels.push(urls);
  },
};

async function main() {
  setAvatarBlobClientForTests(fake);
  try {
    console.log("put");
    const url = await putAvatarBlob("c1", Buffer.from([1, 2, 3]), "image/jpeg");
    check("returns the URL Blob gave back", url === BLOB("c1-Xy7Rq2"));
    check("asks for a random suffix", puts[0]?.options.addRandomSuffix === true, JSON.stringify(puts[0]));
    check("under avatars/<contactId>", puts[0]?.pathname === "avatars/c1.jpg");

    console.log("\nisAvatarBlobUrl");
    check("a store avatar URL", isAvatarBlobUrl(BLOB("x")));
    check("not a data URI", !isAvatarBlobUrl("data:image/jpeg;base64,AAAA"));
    check("not another Blob path", !isAvatarBlobUrl("https://abc.public.blob.vercel-storage.com/capture/x.jpg"));
    check("not a lookalike host", !isAvatarBlobUrl("https://evil.example/avatars/x.jpg?.public.blob.vercel-storage.com"));
    check("not null", !isAvatarBlobUrl(null));

    console.log("\ndelete");
    const n = await deleteAvatarBlobs([BLOB("a"), "data:image/png;base64,AA", null, BLOB("a"), BLOB("b")]);
    check("deletes only Blob avatar URLs, once each", n === 2 && dels.length === 1 && dels[0].length === 2, JSON.stringify(dels));
    dels.length = 0;
    check("nothing to delete makes no call", (await deleteAvatarBlobs(["data:image/png;base64,AA"])) === 0 && dels.length === 0);
    failDel = true;
    check("an outage is swallowed", (await deleteAvatarBlobs([BLOB("c")])) === 0);
    failDel = false;

    console.log("\nreplacement");
    await deleteReplacedAvatar(BLOB("old"), BLOB("new"));
    check("a replaced photo's blob is deleted", dels.at(-1)?.[0] === BLOB("old"));
    const before = dels.length;
    await deleteReplacedAvatar(BLOB("same"), BLOB("same"));
    await deleteReplacedAvatar(null, BLOB("new"));
    check("an unchanged or first photo deletes nothing", dels.length === before);
  } finally {
    setAvatarBlobClientForTests(null);
  }
  if (failures > 0) process.exit(1);
  console.log("\nAll avatar-blob checks passed.");
  process.exit(0);
}

void main();
```

Register `"smoke-avatar-blob": "pure",`. Run it. Expected: module not found.

- [ ] **Step 2: Create `src/lib/avatar-blob.ts`**

```ts
import { del, put } from "@vercel/blob";

/**
 * The only code that talks to Vercel Blob about contact photos.
 *
 * RANDOM SUFFIX. The object is public (the avatar route redirects the browser to it), so the
 * URL itself is the only secret: `avatars/<contactId>.jpg` was guessable from a contact id.
 * A random suffix makes each photo a new object, so whoever replaces or deletes a photo also
 * deletes the old object — `deleteReplacedAvatar` and `deleteAvatarBlobs` below.
 *
 * Deletes are best-effort by contract: an orphaned object is a cost problem, a delete that
 * blocks on a Blob outage is a privacy one.
 */
export type AvatarBlobClient = {
  put(
    pathname: string,
    body: Buffer,
    options: { access: "public"; contentType: string; addRandomSuffix: boolean }
  ): Promise<{ url: string }>;
  del(urls: string[]): Promise<void>;
};

const defaultClient: AvatarBlobClient = {
  put: (pathname, body, options) => put(pathname, body, options),
  del: (urls) => del(urls),
};

let testClient: AvatarBlobClient | null = null;

/** Test seam: route every avatar Blob call through `client` until called with null. */
export function setAvatarBlobClientForTests(client: AvatarBlobClient | null): void {
  testClient = client;
}

function client(): AvatarBlobClient {
  return testClient ?? defaultClient;
}

const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";
const DELETE_BATCH = 100;

export function isAvatarBlobUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith(BLOB_HOST_SUFFIX) && parsed.pathname.startsWith("/avatars/");
  } catch {
    return false;
  }
}

export async function putAvatarBlob(
  contactId: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  const blob = await client().put(`avatars/${contactId}.jpg`, body, {
    access: "public",
    contentType,
    addRandomSuffix: true,
  });
  return blob.url;
}

/** Deletes every Blob avatar among `urls`; returns how many were deleted. Never throws. */
export async function deleteAvatarBlobs(
  urls: ReadonlyArray<string | null | undefined>
): Promise<number> {
  const targets = [...new Set(urls.filter(isAvatarBlobUrl))];
  let deleted = 0;
  for (let i = 0; i < targets.length; i += DELETE_BATCH) {
    const chunk = targets.slice(i, i + DELETE_BATCH);
    try {
      await client().del(chunk);
      deleted += chunk.length;
    } catch {
      // See the header: never fail the caller over an orphaned object.
    }
  }
  return deleted;
}

/** After a contact's stored photo changed, delete the object the old URL pointed at. */
export async function deleteReplacedAvatar(
  previous: string | null | undefined,
  next: string | null | undefined
): Promise<void> {
  if (previous && previous !== next) await deleteAvatarBlobs([previous]);
}
```

- [ ] **Step 3: Use it in `persistAvatar`**

In `src/lib/contact-avatar.ts`, delete line 2 (`import { put } from "@vercel/blob";`) and add `import { putAvatarBlob } from "@/lib/avatar-blob";`. In the `persistAvatar` doc comment, replace the sentence "Blob storage is the preferred home, at a stable per-contact path so re-fetches overwrite instead of orphaning." with "Blob storage is the preferred home, at a random-suffixed path so the public URL cannot be guessed from a contact id; whoever replaces a stored photo deletes the old object (`deleteReplacedAvatar`)." Replace the `try` block's body:

```ts
    const blob = await put(`avatars/${contactId}.jpg`, encoded.buf, {
      access: "public",
      contentType: encoded.contentType,
      addRandomSuffix: false,
    });
    return blob.url;
```

with:

```ts
    return await putAvatarBlob(contactId, encoded.buf, encoded.contentType);
```

(The `catch` that wraps failures in `AvatarStorageError` stays, so `scripts/smoke-avatar-storage.ts`'s bad-token case still passes.)

- [ ] **Step 4: Delete the replaced photo on refresh**

In `src/actions/contacts.ts`, add `import { deleteReplacedAvatar } from "@/lib/avatar-blob";`. In the refresh loop (the function containing `// Prefer Apollo photo when present`), directly after the first `await updateContact(contact.id, { profileImageUrl }, { skipRevalidate: true });` (inside `if (!profile) { if (profileImageUrl) {`), add:

```ts
          await deleteReplacedAvatar(contact.profileImageUrl, profileImageUrl);
```

and directly after the second `await updateContact(contact.id, { ... ...(profileImageUrl ? { profileImageUrl } : {}), }, { skipRevalidate: true });`, add:

```ts
      if (profileImageUrl) await deleteReplacedAvatar(contact.profileImageUrl, profileImageUrl);
```

(`contact.profileImageUrl` is already selected there, verified at 33a213c: the query at ~1160 selects `profileImageUrl: true`.)

- [ ] **Step 5: Verify and commit**

```bash
npx tsx scripts/smoke-avatar-blob.ts
npx tsx scripts/smoke-avatar-storage.ts
npx tsx scripts/smoke-avatar-tiers.ts
npm run typecheck && npm run lint
git add src/lib/avatar-blob.ts src/lib/contact-avatar.ts src/actions/contacts.ts scripts/smoke-avatar-blob.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Store contact photos at unguessable Blob paths and delete replaced ones

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

Expected: all exit 0. `smoke-avatar-storage` still stores inline without a token, and still throws `AvatarStorageError` with a bogus one.

---

### Task 12: Deleting a contact removes the structured rows tied to them

`deleteContact` (`src/actions/contacts.ts:776–785`) deletes one row today. The cascades already take `interactions`, `reminders`, `contact_embeddings`, `contact_tags`, `contact_identities`, `duplicate_suggestions`, `interaction_mentions`, `action_items`, `contact_briefs`, `contact_profiles` and `contact_experiences`. Per the FKs in `schema.ts`, this is the rule for every other table:

| Table | FK / link | Rule | Why |
|---|---|---|---|
| `event_attendees` | `contact_id` SET NULL | **delete** rows with this `contact_id` | the roster row is the same person's name, email and employer; a provider re-sync may re-add them as an unconverted attendee, because they are still on that event's guest list |
| `outreach_prospects` (+ `outreach_messages` by cascade) | `contact_id` SET NULL | **delete** rows with this `contact_id` in the user's campaigns | email, phone and LinkedIn of the person; campaign totals drop by those rows |
| `suggested_reminders` | `contact_id` SET NULL | **delete** rows with this `contact_id` | pending suggestions about someone who is gone; SET NULL would keep the excerpt naming them |
| `contact_merges` | no FK; `winner_contact_id` | **delete** rows whose winner is this contact | each `loser_snapshot` is an earlier record of the same person |
| `note_batches.seed_contact_id` | no FK | **set NULL** | `source_text` is the user's own prose and is not scrubbed |
| `chat_messages.attached_contacts` | jsonb `{id,name}[]` | **remove** this contact's entry | a structured pointer; message `content` is free text and is not scrubbed |
| `user_recruiter_links.contact_id` | SET NULL | unchanged | the recruiter record is its own entity |
| `ignored_people` | none | unchanged | a "never propose this name" instruction about capture, not a record of the contact |
| Blob photo | `profile_image_url` + snapshots | **delete** (Task 11 helper) | |

Free text (notes, capture history, transcripts, chat content) is not scrubbed, and the confirmation says so.

**Files:**
- Create: `src/lib/contact-delete.ts`, `src/lib/contact-delete-copy.ts`
- Modify: `src/actions/contacts.ts` — `deleteContact` (776–785)
- Modify: `src/components/contacts/delete-contact-button.tsx` (88–91), `src/components/contacts/contacts-list.tsx` (662–665), `src/components/capture/note-batch-result.tsx` (`removeContact`, ~96)
- Create: `scripts/smoke-contact-delete.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces**
- Consumes: `deleteAvatarBlobs`, `setAvatarBlobClientForTests` (Task 11); `runAtomicWrite`.
- Produces: `deleteContactForUser(userId: string, contactId: string): Promise<{ deleted: boolean }>`; `CONTACT_DELETE_EXPLAINER: string` (DB-free).

- [ ] **Step 1: Failing test**

Create `scripts/smoke-contact-delete.ts`:

```ts
/**
 * Deleting a contact takes the structured rows tied to them (audit B10). Run: npx tsx scripts/smoke-contact-delete.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import { setAvatarBlobClientForTests } from "../src/lib/avatar-blob";
import { deleteContactForUser } from "../src/lib/contact-delete";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-contact-delete-user";
const BLOB = (n: string) => `https://abc.public.blob.vercel-storage.com/avatars/${n}.jpg`;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const db = await getDb();
  const deleted: string[] = [];
  setAvatarBlobClientForTests({ put: async () => ({ url: "" }), del: async (urls) => void deleted.push(...urls) });
  try {
    const [c] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Ada Lovelace", profileImageUrl: BLOB("ada") }).returning();
    const [d] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Bob Other" }).returning();
    await db.insert(schema.interactions).values({ userId: USER, contactId: c.id, interactionType: "note", rawNotes: "coffee" });
    const [event] = await db.insert(schema.events).values({ userId: USER, title: "Summit" }).returning();
    await db.insert(schema.eventAttendees).values([
      { eventId: event.id, userId: USER, fullName: "Ada Lovelace", email: "ada@x.test", identityKey: "email:ada@x.test", contactId: c.id },
      { eventId: event.id, userId: USER, fullName: "Bob Other", identityKey: "name:bob other", contactId: d.id },
    ]);
    const [campaign] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "C" }).returning();
    const [pc] = await db.insert(schema.outreachProspects).values({ campaignId: campaign.id, externalId: "p-ada", fullName: "Ada Lovelace", email: "ada@x.test", contactId: c.id }).returning();
    await db.insert(schema.outreachProspects).values({ campaignId: campaign.id, externalId: "p-bob", fullName: "Bob Other", contactId: d.id });
    await db.insert(schema.outreachMessages).values({ prospectId: pc.id, channel: "email", body: "hi" });
    await db.insert(schema.suggestedReminders).values({
      userId: USER, contactId: c.id, captureBatchId: randomUUID(), title: "Follow up with Ada", rawDatePhrase: "Friday",
      dueDate: new Date(), sourceExcerpt: "follow up with Ada Friday", sourceHash: "h", itemHash: `i-${randomUUID()}`,
    });
    await db.insert(schema.contactMerges).values({ userId: USER, winnerContactId: c.id, loserContactId: randomUUID(), loserSnapshot: { full_name: "A. Lovelace", profile_image_url: BLOB("ada-old") } });
    await db.execute(sql`INSERT INTO note_batches (user_id, source_hash, source_text, anchor_date, result, seed_contact_id) VALUES (${USER}, 'h', 'met Ada at the summit', now(), '{}'::jsonb, ${c.id}::uuid)`);
    const [thread] = await db.insert(schema.chatThreads).values({ userId: USER, title: "t" }).returning();
    await db.insert(schema.chatMessages).values({ threadId: thread.id, userId: USER, role: "user", content: "who is Ada?", attachedContacts: [{ id: c.id, name: "Ada" }, { id: d.id, name: "Bob" }] });

    check("someone else cannot delete it", (await deleteContactForUser("someone-else", c.id)).deleted === false);
    check("the owner can", (await deleteContactForUser(USER, c.id)).deleted === true);

    const n = async (q: ReturnType<typeof sql>) => rowsOf<{ n: number }>(await db.execute(q))[0]?.n ?? 0;
    check("the contact is gone", (await n(sql`SELECT count(*)::int AS n FROM contacts WHERE id = ${c.id}::uuid`)) === 0);
    check("their interactions went with it", (await n(sql`SELECT count(*)::int AS n FROM interactions WHERE contact_id = ${c.id}::uuid`)) === 0);
    check("their roster row is deleted, the other stays", (await n(sql`SELECT count(*)::int AS n FROM event_attendees WHERE user_id = ${USER}`)) === 1);
    check("their prospect and its messages are deleted, the other stays", (await n(sql`SELECT count(*)::int AS n FROM outreach_prospects WHERE campaign_id = ${campaign.id}::uuid`)) === 1 && (await n(sql`SELECT count(*)::int AS n FROM outreach_messages`)) === 0);
    check("pending suggestions about them are deleted", (await n(sql`SELECT count(*)::int AS n FROM suggested_reminders WHERE user_id = ${USER}`)) === 0);
    check("merge snapshots of them are deleted", (await n(sql`SELECT count(*)::int AS n FROM contact_merges WHERE user_id = ${USER}`)) === 0);
    check("the note batch survives, unlinked", (await n(sql`SELECT count(*)::int AS n FROM note_batches WHERE user_id = ${USER} AND seed_contact_id IS NULL`)) === 1);
    const [msg] = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.threadId, thread.id));
    check("the chat attachment is removed, the other kept", JSON.stringify(msg.attachedContacts) === JSON.stringify([{ id: d.id, name: "Bob" }]), JSON.stringify(msg.attachedContacts));
    check("their photos are deleted from Blob", deleted.includes(BLOB("ada")) && deleted.includes(BLOB("ada-old")), JSON.stringify(deleted));
  } finally {
    setAvatarBlobClientForTests(null);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  console.log("\nAll contact-delete checks passed.");
}

run(main);
```

Register `"smoke-contact-delete": "pglite",`. Run it. Expected: module not found.

- [ ] **Step 2: Create `src/lib/contact-delete-copy.ts`**

```ts
/** Shown in every contact-delete confirmation. DB-free, so client components can import it. */
export const CONTACT_DELETE_EXPLAINER =
  "This removes them, their interactions and reminders, the event-roster rows and outreach prospects linked to them, and their photo. Anything you wrote about them in notes, capture history or chat stays — edit or delete those yourself. This can’t be undone.";
```

- [ ] **Step 3: Create `src/lib/contact-delete.ts`**

```ts
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, runAtomicWrite } from "@/db";
import {
  contactMerges,
  contacts,
  eventAttendees,
  noteBatches,
  outreachCampaigns,
  outreachProspects,
  suggestedReminders,
} from "@/db/schema";
import { deleteAvatarBlobs } from "@/lib/avatar-blob";

/**
 * Delete one contact and every structured row that is about them. The per-table rule, and
 * why, is in the launch Phase 2 plan (Task 12). Free text is deliberately not scrubbed.
 *
 * One atomic group, contact LAST: `event_attendees`, `outreach_prospects` and
 * `suggested_reminders` point at the contact with ON DELETE SET NULL, so deleting the contact
 * first would lose the link that says which rows to take.
 */
export async function deleteContactForUser(
  userId: string,
  contactId: string
): Promise<{ deleted: boolean }> {
  const db = await getDb();
  const [contact] = await db
    .select({ id: contacts.id, profileImageUrl: contacts.profileImageUrl })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .limit(1);
  if (!contact) return { deleted: false };

  const snapshots = await db
    .select({ snapshot: contactMerges.loserSnapshot })
    .from(contactMerges)
    .where(and(eq(contactMerges.userId, userId), eq(contactMerges.winnerContactId, contactId)));
  const photos = [
    contact.profileImageUrl,
    ...snapshots.map((s) => {
      const url = (s.snapshot as Record<string, unknown>).profile_image_url;
      return typeof url === "string" ? url : null;
    }),
  ];

  await runAtomicWrite(db, (tx) => [
    tx.delete(eventAttendees).where(and(eq(eventAttendees.userId, userId), eq(eventAttendees.contactId, contactId))),
    tx.delete(outreachProspects).where(
      and(
        eq(outreachProspects.contactId, contactId),
        inArray(
          outreachProspects.campaignId,
          tx.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(eq(outreachCampaigns.userId, userId))
        )
      )
    ),
    tx.delete(suggestedReminders).where(and(eq(suggestedReminders.userId, userId), eq(suggestedReminders.contactId, contactId))),
    tx.delete(contactMerges).where(and(eq(contactMerges.userId, userId), eq(contactMerges.winnerContactId, contactId))),
    tx.update(noteBatches).set({ seedContactId: null }).where(and(eq(noteBatches.userId, userId), eq(noteBatches.seedContactId, contactId))),
    tx.execute(sql`
      UPDATE chat_messages
         SET attached_contacts = COALESCE(
               (SELECT jsonb_agg(e) FROM jsonb_array_elements(attached_contacts) e WHERE e->>'id' <> ${contactId}),
               '[]'::jsonb)
       WHERE user_id = ${userId}
         AND attached_contacts @> ${JSON.stringify([{ id: contactId }])}::jsonb
    `),
    tx.delete(contacts).where(and(eq(contacts.id, contactId), eq(contacts.userId, userId))),
  ]);

  await deleteAvatarBlobs(photos);
  return { deleted: true };
}
```

- [ ] **Step 4: The action and the copy**

In `src/actions/contacts.ts`, add `import { deleteContactForUser } from "@/lib/contact-delete";` and replace `deleteContact`'s body between `const userId = await requireUserId();` and the `revalidatePath` calls with `await deleteContactForUser(userId, id);` (the `const db = await getDb();` line and the `db.delete(contacts)` statement go).

In `delete-contact-button.tsx` and `contacts-list.tsx`, import `CONTACT_DELETE_EXPLAINER` from `@/lib/contact-delete-copy` and replace each `DialogDescription`'s text ("This removes the contact and their interaction history. This cannot be undone.") with `{CONTACT_DELETE_EXPLAINER}`. In `note-batch-result.tsx`, import it and change `if (!confirm("Delete this contact and its notes?")) return;` to `if (!confirm(`Delete this contact? ${CONTACT_DELETE_EXPLAINER}`)) return;`.

- [ ] **Step 5: Verify**

```bash
npx tsx scripts/smoke-contact-delete.ts
npx tsx scripts/smoke-contact-merge.ts
npm run typecheck && npm run lint
```

Browser (`orbit-web`, seeded demo workspace): open a contact, click Delete, and read the new explainer at desktop width and at 375 px. Confirm, check you land on `/contacts` with the "<name> deleted" toast, and check the contact is gone from the list.

- [ ] **Step 6: Commit**

```bash
git add src/lib/contact-delete.ts src/lib/contact-delete-copy.ts src/actions/contacts.ts src/components/contacts/delete-contact-button.tsx src/components/contacts/contacts-list.tsx src/components/capture/note-batch-result.tsx scripts/smoke-contact-delete.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Delete the roster, prospect, suggestion, merge and photo rows tied to a deleted contact

Free-text notes are not scrubbed, and the confirmation now says so.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Delete avatar blobs on merge and in the contacts purge step

A merge's fold is `profile_image_url = COALESCE(w.profile_image_url, l.profile_image_url)` (`src/lib/contact-merge.ts:203`). The winner adopts the loser's photo only when it had none, so the loser's blob is orphaned exactly when the winner already had a photo. In that case the blob is deleted after the merge commits, and the archived snapshot's `profile_image_url` is nulled, so an unmerge restores the contact without a dead URL (the avatar backfill then re-resolves it). The `contacts` purge step deletes every Blob avatar the user's contacts and merge snapshots reference.

**Files:**
- Modify: `src/lib/contact-merge.ts` — imports (34–38), the initial select in `mergeContacts` (137–141), after the `runAtomicWrite` call (~line 432, before `if (!options.deferInvalidation)`)
- Modify: `src/lib/user-data.ts` — `STEPS.contacts.run` (360–390)
- Create: `scripts/smoke-avatar-cleanup.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces**
- Consumes: `isAvatarBlobUrl`, `deleteAvatarBlobs`, `setAvatarBlobClientForTests` (Task 11); `mergeContacts`, `unmergeContacts`.
- Produces: no new exports.

- [ ] **Step 1: Failing test**

Create `scripts/smoke-avatar-cleanup.ts`:

```ts
/**
 * Avatar blobs follow their contacts out: a merge loser's orphaned photo and every photo in
 * a contacts purge. Run: npx tsx scripts/smoke-avatar-cleanup.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { setAvatarBlobClientForTests } from "../src/lib/avatar-blob";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-avatar-cleanup-user";
const BLOB = (n: string) => `https://abc.public.blob.vercel-storage.com/avatars/${n}.jpg`;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function contact(fullName: string, profileImageUrl: string | null) {
  const db = await getDb();
  const [row] = await db.insert(schema.contacts).values({ userId: USER, fullName, profileImageUrl }).returning();
  return row.id;
}

async function main() {
  const db = await getDb();
  const deleted: string[] = [];
  setAvatarBlobClientForTests({ put: async () => ({ url: "" }), del: async (urls) => void deleted.push(...urls) });
  try {
    console.log("Merge");
    const winner = await contact("Ada Lovelace", BLOB("winner"));
    const loser = await contact("A. Lovelace", BLOB("loser"));
    const { mergeId } = await mergeContacts(USER, winner, loser, { deferInvalidation: true });
    check("the loser's orphaned photo is deleted", deleted.includes(BLOB("loser")) && !deleted.includes(BLOB("winner")), JSON.stringify(deleted));
    const [archive] = await db.select().from(schema.contactMerges).where(eq(schema.contactMerges.id, mergeId));
    check("the snapshot no longer points at the deleted object", (archive.loserSnapshot as Record<string, unknown>).profile_image_url === null);
    await unmergeContacts(USER, mergeId);
    const [restored] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, loser));
    check("an unmerge restores the contact with no dead photo URL", restored?.profileImageUrl === null, String(restored?.profileImageUrl));

    deleted.length = 0;
    const bare = await contact("Grace Hopper", null);
    const donor = await contact("G. Hopper", BLOB("donor"));
    await mergeContacts(USER, bare, donor, { deferInvalidation: true });
    const [adopted] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, bare));
    check("a winner with no photo adopts the loser's, and nothing is deleted", adopted?.profileImageUrl === BLOB("donor") && deleted.length === 0);

    console.log("\nPurge");
    deleted.length = 0;
    await purgeUserData(USER, { only: ["contacts"] });
    check("the contacts step deletes every photo it references", deleted.includes(BLOB("winner")) && deleted.includes(BLOB("donor")), JSON.stringify(deleted));
  } finally {
    setAvatarBlobClientForTests(null);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  console.log("\nAll avatar-cleanup checks passed.");
}

run(main);
```

Register `"smoke-avatar-cleanup": "pglite",`. Run it. Expected: `FAIL the loser's orphaned photo is deleted`.

- [ ] **Step 2: Merge (`src/lib/contact-merge.ts`)**

Add `import { deleteAvatarBlobs, isAvatarBlobUrl } from "@/lib/avatar-blob";`. Change the initial select from `.select({ id: contacts.id })` to `.select({ id: contacts.id, profileImageUrl: contacts.profileImageUrl })`. Directly after the `await runAtomicWrite(db, (tx) => { … });` call in `mergeContacts`, before `if (!options.deferInvalidation) await invalidateAfterMerge(userId, winnerId);`, add:

```ts
  await releaseOrphanedLoserPhoto(userId, mergeId, {
    winner: rows.find((r) => r.id === winnerId)?.profileImageUrl ?? null,
    loser: rows.find((r) => r.id === loserId)?.profileImageUrl ?? null,
  });
```

and add this function below `mergeContacts`:

```ts
/**
 * The fold is COALESCE(winner, loser), so the loser's photo survives only when the winner
 * had none. Otherwise its Blob object is orphaned: delete it, and null it in the archive so
 * an unmerge restores the contact photo-less (the backfill re-resolves it) rather than
 * pointing at nothing. Best-effort and after the commit: never worth failing a merge over.
 */
async function releaseOrphanedLoserPhoto(
  userId: string,
  mergeId: string,
  photos: { winner: string | null; loser: string | null }
) {
  if (photos.winner === null || !isAvatarBlobUrl(photos.loser) || photos.loser === photos.winner) {
    return;
  }
  try {
    await deleteAvatarBlobs([photos.loser]);
    const db = await getDb();
    await db.execute(sql`
      UPDATE contact_merges
         SET loser_snapshot = jsonb_set(loser_snapshot, '{profile_image_url}', 'null'::jsonb)
       WHERE id = ${mergeId}::uuid AND user_id = ${userId}
    `);
  } catch {
    // See above.
  }
}
```

- [ ] **Step 3: Purge (`src/lib/user-data.ts`)**

Add `import { deleteAvatarBlobs } from "@/lib/avatar-blob";`. At the top of `STEPS.contacts.run`, before the `contactIdentities` delete, add:

```ts
      // Read before anything goes: the contact rows and merge snapshots are the only record
      // of which Blob objects are this user's. The objects have no foreign key to cascade.
      const photoRows = await db.execute(sql`
        SELECT profile_image_url AS url FROM contacts WHERE user_id = ${userId} AND profile_image_url LIKE '%.public.blob.vercel-storage.com/avatars/%'
        UNION
        SELECT loser_snapshot->>'profile_image_url' AS url FROM contact_merges WHERE user_id = ${userId} AND loser_snapshot->>'profile_image_url' LIKE '%.public.blob.vercel-storage.com/avatars/%'
      `);
      const photoUrls = rowsOf<{ url: string }>(photoRows).map((r) => r.url);
```

At the end of that `run` body, after `await db.delete(companies)…`, add:

```ts
      // After the rows: a Blob outage leaves orphaned objects, never undeleted people.
      await deleteAvatarBlobs(photoUrls);
```

- [ ] **Step 4: Verify and commit**

```bash
npx tsx scripts/smoke-avatar-cleanup.ts
npx tsx scripts/smoke-contact-merge.ts
npx tsx scripts/smoke-purge.ts
npx tsx scripts/smoke-purge-selective.ts
npm run typecheck && npm run lint
git add src/lib/contact-merge.ts src/lib/user-data.ts scripts/smoke-avatar-cleanup.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Delete avatar blobs orphaned by a merge and every avatar in a contacts purge

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

Expected: all exit 0. If `unmergeContacts` skips a snapshot column that is JSON null, the restored-photo check still reads `null`.

---

### Task 14: Recruiter contact details live on each user's own link (A8 proper)

**Reconcile with Phase 0 first.** Phase 0 Task 8 shipped an interim rule with no columns: `CREATOR_LINK_WINDOW_SECONDS`, `isCreatorLink`, `piiPooledRecruiterIds` and `unlockedRecruiterIds` in `src/lib/recruiters.ts`, a `{ callerIsSharing }` option on `upsertCanonicalRecruiter`, an `{ includePii }` option on `mergeRecruiterFields`, and Phase 0 Task 9 made `src/actions/recruiter-messages.ts` call `unlockedRecruiterIds`. This task replaces that rule with per-link columns, so: delete `isCreatorLink`, `piiPooledRecruiterIds` and `unlockedRecruiterIds` once nothing imports them (`grep -rn "unlockedRecruiterIds\|isCreatorLink\|piiPooledRecruiterIds" src scripts` must print nothing at the end of Step 3); keep `CREATOR_LINK_WINDOW_SECONDS` only if the Task 1 backfill comment still cites it, otherwise delete it too; map `{ callerIsSharing }` to this task's `{ contributePii }`. `scripts/smoke-recruiter-pii.ts` already exists from Phase 0 — Step 1 below **replaces its whole contents** rather than creating it, and its MANIFEST entry already exists.

Writes put email, phone and LinkedIn on the caller's `user_recruiter_links` row. The shared `recruiters` row takes them only from a caller who has `recruiter_sharing` on (fill-empty-only, as before). Reads resolve each field from the viewer's own link first, then from the shared row only when the row is pooled for this viewer. `rederiveSharedRecruiterPii` keeps the shared row honest when a contributor withdraws, whether by the sharing toggle, the per-link toggle, or (Task 15) a purge. A shared value stays only while some pooled link vouches for it. Rows with an unknown creator (legacy rows the Task 1 backfill could not attribute) keep an unvouched value unless the withdrawing user's own link holds that same value.

**Files:**
- Modify: `src/lib/recruiters.ts` — imports (1–11), `toPublicRecruiter` (69–99), `upsertCanonicalRecruiter` (247–298), `ensureUserLink` (350–404), `resweepUserRatings` (483–492); new helpers after `mergeRecruiterFields` (147)
- Modify: `src/actions/recruiters.ts` — `listMyRecruiters` (54–63), `getRecruiter` (65–90), `setLinkShared` (124–143), `logRecruiter` (160–221), `loadRecruitersForChat` personal rows (286–308)
- Modify: `src/lib/gmail-scan-processor.ts` — `processSender` (217–229), import (29)
- Modify: `src/actions/recruiter-messages.ts` — `toDraft` (33–51), `generateRecruiterDrafts` (156), `listRecruiterDrafts` (168–183), `sendRecruiterDrafts` select and `to` (266–285)
- Modify: `scripts/smoke-recruiter-sharing.ts` (93–112)
- Replace: `scripts/smoke-recruiter-pii.ts` (created by Phase 0 Task 8; already in MANIFEST)

**Interfaces**
- Consumes: link and creator columns (Task 1).
- Produces (`src/lib/recruiters.ts`): `type RecruiterPii = { email: string | null; phone: string | null; linkedinUrl: string | null }`; `resolveRecruiterPii(row, link, pooledForViewer): RecruiterPii`; `pickPooledPii(current: RecruiterPii, pooled: RecruiterPii[], opts: { strict: boolean; withdrawn?: RecruiterPii | null }): RecruiterPii`; `pooledIdsForViewer(userId: string, ids: string[]): Promise<Set<string>>`; `rederiveSharedRecruiterPii(recruiterId: string, opts?: { withdrawn?: RecruiterPii | null }): Promise<void>`; `upsertCanonicalRecruiter(input, opts?: { contributePii?: boolean; createdByUserId?: string })` (default contributes nothing); `ensureUserLink` accepts `email?`, `phone?`, `linkedinUrl?`.

- [ ] **Step 1: Failing test**

Create `scripts/smoke-recruiter-pii.ts`:

```ts
/**
 * Recruiter contact details are per link; the shared row holds only what sharing users
 * vouch for (audit A8). Run: npx tsx scripts/smoke-recruiter-pii.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { recruiters, userSettings } from "../src/db/schema";
import {
  ensureUserLink,
  pickPooledPii,
  resolveRecruiterPii,
  resweepUserRatings,
  toPublicRecruiter,
  upsertCanonicalRecruiter,
} from "../src/lib/recruiters";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}
const none = { email: null, phone: null, linkedinUrl: null };

async function main() {
  console.log("Pure");
  const row = { email: "shared@r.test", phone: null, linkedinUrl: null };
  check("own link wins", resolveRecruiterPii(row, { email: "mine@r.test", phone: null, linkedinUrl: null }, true).email === "mine@r.test");
  check("pooled viewer falls back to the shared row", resolveRecruiterPii(row, null, true).email === "shared@r.test");
  check("a link alone no longer unlocks someone else's details", resolveRecruiterPii(row, { ...none }, false).email === null);
  check("strict: an unvouched value is dropped", pickPooledPii(row, [], { strict: true }).email === null);
  check("strict: a vouched value stays (case-insensitive)", pickPooledPii(row, [{ ...none, email: "SHARED@r.test" }], { strict: true }).email === "shared@r.test");
  check("legacy: an unvouched value stays", pickPooledPii(row, [], { strict: false }).email === "shared@r.test");
  check("legacy: withdrawn by its owner, it goes", pickPooledPii(row, [], { strict: false, withdrawn: { ...none, email: "shared@r.test" } }).email === null);
  check("an empty field is filled from a pooled link", pickPooledPii({ ...none }, [{ ...none, phone: "+1 555" }], { strict: true }).phone === "+1 555");

  console.log("\nDatabase");
  const db = await getDb();
  await db.insert(userSettings).values([
    { userId: "smoke-pii-private", recruiterSharing: 0 },
    { userId: "smoke-pii-sharer", recruiterSharing: 1 },
    { userId: "smoke-pii-viewer", recruiterSharing: 1 },
  ]);
  const created = await upsertCanonicalRecruiter(
    { fullName: "Pat Recruiter", firm: "Acme Talent", email: "pat.private@r.test" },
    { contributePii: false, createdByUserId: "smoke-pii-private" }
  );
  check("a private user's email never reaches the shared row", created.email === null && created.createdByUserId === "smoke-pii-private");
  const { link: privateLink } = await ensureUserLink({ userId: "smoke-pii-private", recruiterId: created.id, email: "pat.private@r.test" });
  check("...it is on their own link", privateLink.email === "pat.private@r.test");

  const same = await upsertCanonicalRecruiter({ fullName: "Pat Recruiter", firm: "Acme Talent", email: "pat@acme.test" }, { contributePii: true, createdByUserId: "smoke-pii-sharer" });
  const { link: sharerLink } = await ensureUserLink({ userId: "smoke-pii-sharer", recruiterId: same.id, email: "pat@acme.test" });
  check("a sharing user's email fills the shared row", same.id === created.id && same.email === "pat@acme.test");
  const fresh = (await db.query.recruiters.findFirst({ where: eq(recruiters.id, created.id) }))!;
  check("the private owner still sees their own address", toPublicRecruiter(fresh, privateLink, false).email === "pat.private@r.test");
  check("a pooled viewer sees the contributed one", toPublicRecruiter(fresh, null, true).email === "pat@acme.test");

  await db.update(userSettings).set({ recruiterSharing: 0 }).where(eq(userSettings.userId, "smoke-pii-sharer"));
  await resweepUserRatings("smoke-pii-sharer");
  const after = (await db.query.recruiters.findFirst({ where: eq(recruiters.id, created.id) }))!;
  check("turning sharing off withdraws the contribution", after.email === null, String(after.email));
  check("...but the contributor keeps it on their link", sharerLink.email === "pat@acme.test");

  await db.delete(recruiters).where(eq(recruiters.id, created.id));
  console.log("\nAll recruiter-PII checks passed.");
}

run(main);
```

Register `"smoke-recruiter-pii": "pglite",`. Run it. Expected: `resolveRecruiterPii` is not exported.

- [ ] **Step 2: Helpers and reads in `src/lib/recruiters.ts`**

Change the drizzle import to include `asc`. After `mergeRecruiterFields`, add:

```ts
export type RecruiterPii = { email: string | null; phone: string | null; linkedinUrl: string | null };
type PiiKey = keyof RecruiterPii;
const PII_KEYS: PiiKey[] = ["email", "phone", "linkedinUrl"];

function samePii(key: PiiKey, a: string, b: string): boolean {
  if (key === "email") return a.trim().toLowerCase() === b.trim().toLowerCase();
  if (key === "linkedinUrl") return normalizeLinkedinUrl(a) === normalizeLinkedinUrl(b);
  return a.replace(/\D/g, "") === b.replace(/\D/g, "");
}

/** Per field: the viewer's own link, else the shared value only when pooled for this viewer. */
export function resolveRecruiterPii(
  row: RecruiterPii,
  link: RecruiterPii | null,
  pooledForViewer: boolean
): RecruiterPii {
  const pick = (key: PiiKey) => link?.[key]?.trim() ? link[key] : pooledForViewer ? row[key] : null;
  return { email: pick("email"), phone: pick("phone"), linkedinUrl: pick("linkedinUrl") };
}

/**
 * What the shared row should hold, given the pooled links that could vouch for it.
 * Strict (a row with a known creator): only vouched values survive. Legacy (creator unknown):
 * an unvouched value survives unless the user withdrawing holds that very value.
 */
export function pickPooledPii(
  current: RecruiterPii,
  pooled: RecruiterPii[],
  opts: { strict: boolean; withdrawn?: RecruiterPii | null }
): RecruiterPii {
  const out = { ...current };
  for (const key of PII_KEYS) {
    const offered = pooled.map((p) => p[key]).filter((v): v is string => Boolean(v?.trim()));
    const cur = current[key];
    if (!cur) {
      out[key] = offered[0] ?? null;
      continue;
    }
    if (offered.some((v) => samePii(key, v, cur))) continue;
    const withdrawn = opts.withdrawn?.[key];
    if (opts.strict || (withdrawn && samePii(key, withdrawn, cur))) out[key] = offered[0] ?? null;
  }
  return out;
}

export async function pooledIdsForViewer(userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0 || !(await isViewerSharing(userId))) return new Set();
  return pooledRecruiterIds(ids);
}

export async function rederiveSharedRecruiterPii(
  recruiterId: string,
  opts: { withdrawn?: RecruiterPii | null } = {}
): Promise<void> {
  const db = await getDb();
  const row = await db.query.recruiters.findFirst({ where: eq(recruiters.id, recruiterId) });
  if (!row) return;
  const pooled = await db
    .select({ email: userRecruiterLinks.email, phone: userRecruiterLinks.phone, linkedinUrl: userRecruiterLinks.linkedinUrl })
    .from(userRecruiterLinks)
    .innerJoin(userSettings, eq(userSettings.userId, userRecruiterLinks.userId))
    .where(and(eq(userRecruiterLinks.recruiterId, recruiterId), eq(userRecruiterLinks.sharedToPool, 1), eq(userSettings.recruiterSharing, 1)))
    .orderBy(asc(userRecruiterLinks.createdAt));
  const next = pickPooledPii(row, pooled, { strict: row.createdByUserId !== null, withdrawn: opts.withdrawn });
  if (PII_KEYS.every((k) => next[k] === row[k])) return;
  await db
    .update(recruiters)
    .set({ ...next, emailNormalized: normalizeEmail(next.email), updatedAt: new Date() })
    .where(eq(recruiters.id, recruiterId));
}
```

Replace `toPublicRecruiter`'s body (whatever Phase 0 left) with:

```ts
  const pii = resolveRecruiterPii(row, link, pooledForViewer);
  return {
    id: row.id,
    fullName: row.fullName,
    firm: row.firm,
    specialty: row.specialty || [],
    avgRating: row.avgRating,
    ratingCount: row.ratingCount,
    logCount: row.logCount,
    ...pii,
    // Unchanged meaning: may this viewer see a contact section at all (their own link, or the pool).
    piiUnlocked: Boolean(link) || pooledForViewer,
    myLink: link,
  };
```

- [ ] **Step 3: Writes in `src/lib/recruiters.ts`**

`upsertCanonicalRecruiter`: change the signature to `(input: {…same…}, opts: { contributePii?: boolean; createdByUserId?: string } = {})`. Directly after `if (!fullName) throw …`, add:

```ts
  // Matching may use every identifier; WRITING contact details to the shared row needs consent.
  const shared = opts.contributePii
    ? input
    : { ...input, email: null, linkedinUrl: null, phone: null };
```

and use `shared` (not `input`) in `mergeRecruiterFields(existing, shared)` and for the `email`, `emailNormalized`, `linkedinUrl` and `phone` values of the insert. Add `createdByUserId: opts.createdByUserId ?? null,` to the insert values. `findMatchingRecruiter` keeps receiving `input`. If Phase 0 gave `mergeRecruiterFields` a sharing parameter, drop it: the caller now passes contact details only when sharing.

`ensureUserLink`: add `email?: string | null; phone?: string | null; linkedinUrl?: string | null;` to the input type. In the existing-link `.set({…})`, add:

```ts
        email: input.email?.trim() || existing.email,
        phone: input.phone?.trim() || existing.phone,
        linkedinUrl: input.linkedinUrl?.trim() ? normalizeLinkedinUrl(input.linkedinUrl) : existing.linkedinUrl,
```

and in the insert `.values({…})`, add `email: input.email?.trim() || null, phone: input.phone?.trim() || null, linkedinUrl: normalizeLinkedinUrl(input.linkedinUrl),`.

`resweepUserRatings`: select `columns: { recruiterId: true, email: true, phone: true, linkedinUrl: true }` and in the loop, after `await recomputeRecruiterRating(link.recruiterId);`, add `await rederiveSharedRecruiterPii(link.recruiterId, { withdrawn: link });`. Passing the link either way is safe: when sharing turns on, the now-pooled link vouches for its own value.

- [ ] **Step 4: Callers**

`src/actions/recruiters.ts` (add `pooledIdsForViewer`, `rederiveSharedRecruiterPii`, `resolveRecruiterPii` to the `@/lib/recruiters` import):
- `listMyRecruiters`: after `links` is loaded, `const pooled = await pooledIdsForViewer(userId, links.map((l) => l.recruiterId));` and return `links.map((l) => toPublicRecruiter(l.recruiter, l, pooled.has(l.recruiterId)));`.
- `getRecruiter`: replace the final `return toPublicRecruiter(row, link);` with `return toPublicRecruiter(row, link, (await pooledIdsForViewer(userId, [id])).has(id));`.
- `setLinkShared`: after `await recomputeRecruiterRating(recruiterId);`, add `await rederiveSharedRecruiterPii(recruiterId, { withdrawn: link });`.
- `logRecruiter`: after `const userId = await requireRecruitersUser();` add `const sharing = await isViewerSharing(userId);`. Replace the `if (fullName || input.email || input.firm || input.linkedinUrl) { await upsertCanonicalRecruiter({…}); }` block inside `if (recruiterId)` with a direct patch of THAT row, which also stops an email from matching and patching a different row:

```ts
      const patch = mergeRecruiterFields(existing, {
        fullName: fullName || existing.fullName,
        firm: input.firm,
        specialty: input.specialty,
        ...(sharing ? { email: input.email, linkedinUrl: input.linkedinUrl, phone: input.phone } : {}),
      });
      if (Object.keys(patch).length > 1) {
        await db.update(recruiters).set(patch).where(eq(recruiters.id, existing.id));
      }
```

  Pass `{ contributePii: sharing, createdByUserId: userId }` as the second argument of the `upsertCanonicalRecruiter` call in the `else` branch, add `mergeRecruiterFields` to the import, and add `email: input.email, phone: input.phone, linkedinUrl: input.linkedinUrl,` to the `ensureUserLink({…})` call.
- `loadRecruitersForChat`: after `personal` is loaded, `const pooledPersonal = await pooledIdsForViewer(userId, personal.map((l) => l.recruiterId));`. In the personal map, replace `email: r.email, linkedinUrl: r.linkedinUrl,` with `...(({ email, linkedinUrl }) => ({ email, linkedinUrl }))(resolveRecruiterPii(r, l, pooledPersonal.has(r.id))),`.

`src/lib/gmail-scan-processor.ts` (`processSender`): add `isViewerSharing` to the recruiters import. Pass `{ contributePii: await isViewerSharing(userId), createdByUserId: userId }` as the second argument to `upsertCanonicalRecruiter`, and add `email: payload.email,` to the `ensureUserLink({…})` call.

`src/actions/recruiter-messages.ts`: import `pooledIdsForViewer, resolveRecruiterPii` from `@/lib/recruiters` and `and` is already imported. Change `toDraft(row, recruiter)` to `toDraft(row: RecruiterMessage, recruiter: { fullName: string; firm: string | null }, recruiterEmail: string | null)` and set `recruiterEmail` from the parameter. Then:
- `generateRecruiterDrafts`: before the insert loop, `const pooled = await pooledIdsForViewer(userId, links.map((l) => l.recruiterId));`; call `toDraft(row, links[i].recruiter, resolveRecruiterPii(links[i].recruiter, links[i], pooled.has(links[i].recruiterId)).email)`.
- `listRecruiterDrafts` and `sendRecruiterDrafts`: select `{ message: recruiterMessages, recruiter: recruiters, link: userRecruiterLinks }` and add, after the `innerJoin(recruiters, …)`, `.leftJoin(userRecruiterLinks, and(eq(userRecruiterLinks.recruiterId, recruiterMessages.recruiterId), eq(userRecruiterLinks.userId, recruiterMessages.userId)))`. Compute `const pooled = await pooledIdsForViewer(userId, rows.map((r) => r.recruiter.id));` after the query. In list, map `toDraft(r.message, r.recruiter, resolveRecruiterPii(r.recruiter, r.link, pooled.has(r.recruiter.id)).email)`. In send, replace `const to = row.recruiter.email;` with `const to = resolveRecruiterPii(row.recruiter, row.link, pooled.has(row.recruiter.id)).email;`.

`scripts/smoke-recruiter-sharing.ts`: pass `{ contributePii: true }` as the second argument to both `upsertCanonicalRecruiter` calls (lines 93–102), and add `email: "alpha@zzsmokeshare.test",` / `email: "beta@zzsmokeshare.test",` to the matching `userRecruiterLinks` inserts (104–112), so the pooled links vouch for what the rows hold.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx scripts/smoke-recruiter-pii.ts
npx tsx scripts/smoke-recruiter-sharing.ts
npx tsx scripts/smoke-recruiter-scan.ts
npm run typecheck && npm run lint
git add src/lib/recruiters.ts src/actions/recruiters.ts src/lib/gmail-scan-processor.ts src/actions/recruiter-messages.ts scripts/smoke-recruiter-pii.ts scripts/smoke-recruiter-sharing.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Keep recruiter contact details on each user's link; share only what sharing users vouch for

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

Browser: `/recruiters/<id>` for a logged recruiter shows your own email under Contact; for a recruiter with no details on your link it shows "No contact details contributed yet."

---

### Task 15: A purge removes the recruiter data a user brought into the shared directory

The `recruiters` purge step (full or selective) now also:
1. Deletes canonical `recruiters` rows whose only links belonged to this user. They are third-party PII nobody else holds. `recruiter_messages` cascade.
2. Marks rows this user created as `created_by_user_id = 'deleted-account'`, so the strict vouching rule keeps applying.
3. Re-derives shared contact details on every surviving row the user linked, with their link's values as `withdrawn` (Task 14).

**Files:**
- Modify: `src/lib/user-data.ts` — `STEPS.recruiters.run` (239–270)
- Modify: `src/lib/recruiters.ts` — add `RECRUITER_DELETED_CREATOR`
- Modify: `scripts/smoke-recruiter-pii.ts` (append a section), `scripts/smoke-purge.ts` (seed 332–338, return 532, assertions 644–649), `scripts/smoke-purge-selective.ts` (seed 180–196)

**Interfaces**
- Consumes: `rederiveSharedRecruiterPii`, `RecruiterPii` (Task 14); `recomputeRecruiterRating`.
- Produces: `RECRUITER_DELETED_CREATOR = "deleted-account"`.

- [ ] **Step 1: Failing test**

In `scripts/smoke-recruiter-pii.ts`, add `purgeUserData` (`import { purgeUserData } from "../src/lib/user-data";`) and `userRecruiterLinks` to the schema import. Replace `await db.delete(recruiters).where(eq(recruiters.id, created.id));` with:

```ts
  console.log("\nPurge");
  const solo = await upsertCanonicalRecruiter({ fullName: "Solo Recruiter", firm: "Only Me", email: "solo@r.test" }, { contributePii: true, createdByUserId: "smoke-pii-viewer" });
  await ensureUserLink({ userId: "smoke-pii-viewer", recruiterId: solo.id, email: "solo@r.test" });
  const both = await upsertCanonicalRecruiter({ fullName: "Both Recruiter", firm: "Two Of Us", email: "both@r.test" }, { contributePii: true, createdByUserId: "smoke-pii-viewer" });
  await ensureUserLink({ userId: "smoke-pii-viewer", recruiterId: both.id, email: "both@r.test" });
  await ensureUserLink({ userId: "smoke-pii-private", recruiterId: both.id, email: "both.private@r.test" });

  await purgeUserData("smoke-pii-viewer", { only: ["recruiters"] });
  check("a recruiter only this user linked is deleted", !(await db.query.recruiters.findFirst({ where: eq(recruiters.id, solo.id) })));
  const survivor = await db.query.recruiters.findFirst({ where: eq(recruiters.id, both.id) });
  check("a recruiter someone else links survives", Boolean(survivor));
  check("...without the departing user's contributed email", survivor?.email === null, String(survivor?.email));
  check("...and no longer names them as creator", survivor?.createdByUserId === "deleted-account");
  const otherLink = await db.query.userRecruiterLinks.findFirst({ where: eq(userRecruiterLinks.recruiterId, both.id) });
  check("the other user's own details are untouched", otherLink?.email === "both.private@r.test");

  await db.delete(recruiters).where(eq(recruiters.id, created.id));
  await db.delete(recruiters).where(eq(recruiters.id, both.id));
```

Run it. Expected: `FAIL a recruiter only this user linked is deleted`.

- [ ] **Step 2: The step**

In `src/lib/recruiters.ts`, add:

```ts
/** `created_by_user_id` after the creator's data is purged: not null, so vouching stays strict. */
export const RECRUITER_DELETED_CREATOR = "deleted-account";
```

In `src/lib/user-data.ts`, extend the recruiters import to `import { RECRUITER_DELETED_CREATOR, recomputeRecruiterRating, rederiveSharedRecruiterPii } from "@/lib/recruiters";`. In `STEPS.recruiters.run`, replace the `linkedRecruiterIds` query with one that also reads the link's details:

```ts
      const departingLinks = await db.query.userRecruiterLinks.findMany({
        where: eq(userRecruiterLinks.userId, userId),
        columns: { recruiterId: true, email: true, phone: true, linkedinUrl: true },
      });
      const linkedRecruiterIds = departingLinks.map((l) => l.recruiterId);
```

Then, after `await db.delete(userRecruiterLinks)…` and BEFORE the existing recompute loop, add:

```ts
      // Third-party PII nobody else holds: a canonical row whose only links were this user's.
      const ids = [...new Set(linkedRecruiterIds)];
      if (ids.length > 0) {
        await db.execute(sql`
          DELETE FROM recruiters r
           WHERE r.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
             AND NOT EXISTS (SELECT 1 FROM user_recruiter_links l WHERE l.recruiter_id = r.id)
        `);
      }
      await db
        .update(recruiters)
        .set({ createdByUserId: RECRUITER_DELETED_CREATOR })
        .where(eq(recruiters.createdByUserId, userId));
      // What this user contributed to rows others still use leaves with them.
      for (const link of departingLinks) {
        await rederiveSharedRecruiterPii(link.recruiterId, { withdrawn: link }).catch(() => {});
      }
```

Add `recruiters` to the `@/db/schema` import. (`recomputeRecruiterRating` on a deleted row updates nothing, which is harmless. The loop stays.)

- [ ] **Step 3: Update the two purge smokes' "the directory survives" fixtures**

`scripts/smoke-purge.ts`: after the `userRecruiterLinks` insert for `USER` (line ~338), add a second linker and a sole-link recruiter:

```ts
  // A second user's link keeps the shared row alive; a row only USER links must go.
  await db.insert(schema.userRecruiterLinks).values({ userId: "smoke-purge-other-linker", recruiterId: recruiter.id });
  const [soleRecruiter] = await db
    .insert(schema.recruiters)
    .values({ fullName: "Solo Recruiter", nameNormalized: "solo recruiter", email: "solo@example.test" })
    .returning();
  await db.insert(schema.userRecruiterLinks).values({ userId: USER, recruiterId: soleRecruiter.id, email: "solo@example.test" });
```

Change `return { recruiterId: recruiter.id };` to `return { recruiterId: recruiter.id, soleRecruiterId: soleRecruiter.id };` and `const { recruiterId } = await seed();` to `const { recruiterId, soleRecruiterId } = await seed();`. After the `the shared recruiters directory survives` check, add:

```ts
  const sole = await db.query.recruiters.findFirst({ where: eq(schema.recruiters.id, soleRecruiterId) });
  check("a recruiter only this user linked is deleted with them", !sole);
```

`scripts/smoke-purge-selective.ts`: in `seed()`, after the `userRecruiterLinks` insert for `USER` (line ~194), add:

```ts
  // Another user's link: the shared row must survive a link delete and its counters come down.
  await db.insert(schema.userRecruiterLinks).values({ userId: "smoke-purge-selective-other", recruiterId: recruiter.id });
```

- [ ] **Step 4: Verify and commit**

```bash
npx tsx scripts/smoke-recruiter-pii.ts
npx tsx scripts/smoke-purge.ts
npx tsx scripts/smoke-purge-selective.ts
npx tsx scripts/smoke-instrumentation.ts
npm run typecheck && npm run lint
git add src/lib/user-data.ts src/lib/recruiters.ts scripts/smoke-recruiter-pii.ts scripts/smoke-purge.ts scripts/smoke-purge-selective.ts
git commit -m "$(cat <<'EOF'
Purge recruiter rows only the departing user linked, and withdraw what they contributed

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Build the export from the deletion registry

Each `STEPS` entry in `src/lib/user-data.ts` gains `exports`: the datasets that category exports. The same `Record<DataCategory, CategoryStep>` that forces every category to have a delete now forces it to have an export, and a guard checks that every table a category counts is exported. `src/lib/data-export.ts` streams `{ format, exportedAt, categories: { <category>: { <dataset>: rows[] } }, account: { billing_events } }` page by page. It drops every column ending `_encrypted`, `token`, `secret` or `_hash`, plus `embedding`, `embedding_vector`, `blob_url` and `inline_data`. Photos become proxied URLs (`/api/capture/photos/<id>`, `/api/feedback/screenshots/<id>`, `/api/avatars/<contactId>`).

**Files:**
- Modify: `src/lib/user-data.ts` — schema imports, `CategoryStep` type (111–119), each `STEPS` entry (121–407), new exports after `STEPS`
- Create: `src/lib/data-export.ts`
- Create: `scripts/smoke-data-export.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces**
- Produces (user-data.ts): `type ExportSource = { name: string; page: (userId: string, limit: number, offset: number) => SQL; transform?: (row: Record<string, unknown>) => Record<string, unknown> }`; `ownRowsSource(table: PgTable, orderBy?: string): ExportSource`; `exportSourcesFor(category: DataCategory): readonly ExportSource[]`; `countedTableNames(category: DataCategory): string[]`.
- Produces (data-export.ts): `redactExportRow(row): Record<string, unknown>`; `userExportChunks(userId: string, now?: Date): AsyncGenerator<string>`; `userExportStream(userId: string): ReadableStream<Uint8Array>`; `collectUserExport(userId: string): Promise<UserExport>`; `type UserExport = { format: string; exportedAt: string; categories: Record<DataCategory, Record<string, Record<string, unknown>[]>>; account: Record<string, Record<string, unknown>[]> }`.

- [ ] **Step 1: Failing test**

Create `scripts/smoke-data-export.ts`:

```ts
/**
 * The export covers every deletion category, leaks no secret column, and shows photos as
 * proxied URLs (audit B10). Run: npx tsx scripts/smoke-data-export.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { DATA_CATEGORY_IDS } from "../src/lib/data-categories";
import { collectUserExport } from "../src/lib/data-export";
import { countedTableNames, exportSourcesFor, purgeUserData } from "../src/lib/user-data";

const USER = "smoke-export-user";
const FORBIDDEN = /(_encrypted|token|secret)$/;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function seed() {
  const db = await getDb();
  await db.insert(schema.userSettings).values({ userId: USER, geminiApiKeyEncrypted: encrypt("k"), calendarFeedToken: "feed-token" });
  const [contact] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Ada Lovelace", profileImageUrl: "data:image/jpeg;base64,AAAA" }).returning();
  await db.insert(schema.contacts).values({ userId: "smoke-export-someone-else", fullName: "Not Mine" });
  await db.insert(schema.interactions).values({ userId: USER, contactId: contact.id, interactionType: "note", rawNotes: "coffee" });
  await db.insert(schema.capturePhotos).values({ userId: USER, storage: "inline", inlineData: "AAAA", contentType: "image/jpeg", byteSize: 4 });
  await db.insert(schema.reminders).values({ userId: USER, contactId: contact.id, title: "follow up", dueDate: new Date() });
  await db.insert(schema.aiSuggestions).values({ userId: USER, suggestionType: "reconnect", title: "Reach out" });
  await db.insert(schema.imports).values({ userId: USER, importType: "linkedin_connections" });
  await db.insert(schema.gmailConnections).values({ userId: USER, emailAddress: "e@x.test", accessTokenEncrypted: encrypt("a"), refreshTokenEncrypted: encrypt("r") });
  await db.insert(schema.events).values({ userId: USER, title: "Summit" });
  await db.insert(schema.userGoals).values({ userId: USER, text: "meet people" });
  await db.insert(schema.chatThreads).values({ userId: USER, title: "thread" });
  const [recruiter] = await db.insert(schema.recruiters).values({ fullName: "Rec", nameNormalized: "rec" }).returning();
  await db.insert(schema.userRecruiterLinks).values({ userId: USER, recruiterId: recruiter.id, email: "rec@x.test" });
  await db.insert(schema.apiKeys).values({ userId: USER, name: "key", prefix: "orb_live_export", keyHash: "0".repeat(64), scopes: ["read"] });
  await db.insert(schema.usageEvents).values({ userId: USER, operation: "capture.parse", provider: "gemini", model: "m", kind: "completion", keyOwner: "user" });
  await db.insert(schema.feedback).values({ userId: USER, kind: "churn_reason", text: "words" });
  await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Campaign" });
  await db.insert(schema.tags).values({ userId: USER, name: "friend" });
  return { contactId: contact.id, recruiterId: recruiter.id };
}

async function main() {
  const { contactId } = await seed();
  try {
    console.log("The registry");
    for (const id of DATA_CATEGORY_IDS) {
      const exported = new Set(exportSourcesFor(id).map((s) => s.name));
      const missing = countedTableNames(id).filter((t) => !exported.has(t));
      check(`${id}: every counted table is exported`, missing.length === 0, missing.join(", "));
    }

    console.log("\nThe export");
    const out = await collectUserExport(USER);
    for (const id of DATA_CATEGORY_IDS) {
      const rows = Object.values(out.categories[id] ?? {}).flat();
      check(`${id}: at least one row`, rows.length > 0);
    }
    const leaks: string[] = [];
    const walk = (dataset: string, rows: Record<string, unknown>[]) => {
      for (const row of rows) for (const key of Object.keys(row)) if (FORBIDDEN.test(key)) leaks.push(`${dataset}.${key}`);
    };
    for (const byName of Object.values(out.categories)) for (const [name, rows] of Object.entries(byName)) walk(name, rows);
    for (const [name, rows] of Object.entries(out.account)) walk(name, rows);
    check("no column ending _encrypted, token or secret", leaks.length === 0, [...new Set(leaks)].join(", "));
    const photo = out.categories.notes.capture_photos?.[0];
    check("capture photos are proxied URLs, not bytes", typeof photo?.url === "string" && String(photo.url).startsWith("/api/capture/photos/") && !("inline_data" in photo));
    const contact = out.categories.contacts.contacts?.find((c) => c.id === contactId);
    check("an inline avatar becomes the avatar route", contact?.profile_image_url === `/api/avatars/${contactId}`);
    check("nobody else's rows", out.categories.contacts.contacts.every((c) => c.user_id === USER));
    check("recruiter links name the recruiter", out.categories.recruiters.user_recruiter_links?.[0]?.recruiter_full_name === "Rec");
  } finally {
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
    await purgeUserData("smoke-export-someone-else", { keepSettings: false }).catch(() => {});
  }
  console.log("\nAll export checks passed.");
}

run(main);
```

Register `"smoke-data-export": "pglite",`. Run it. Expected: `Cannot find module '../src/lib/data-export'`.

- [ ] **Step 2: The registry (`src/lib/user-data.ts`)**

Add to the `@/db/schema` import: `actionItems, capturePhotos, chatMessages, contactBriefs, contactExperiences, contactProfiles, importJobRows, interactionMentions`. Add `import type { SQL } from "drizzle-orm";`. Above `type CategoryStep`, add:

```ts
/** One dataset of a category's export: a page of this user's rows, snake_case keys. */
export type ExportSource = {
  name: string;
  page: (userId: string, limit: number, offset: number) => SQL;
  transform?: (row: Record<string, unknown>) => Record<string, unknown>;
};

/** Every row of `table` whose `user_id` is this user, in a stable order. */
export function ownRowsSource(table: PgTable, orderBy = "id"): ExportSource {
  const name = getTableName(table);
  return {
    name,
    page: (userId, limit, offset) =>
      sql`SELECT * FROM ${sql.identifier(name)} WHERE user_id = ${userId} ORDER BY ${sql.identifier(orderBy)} LIMIT ${limit} OFFSET ${offset}`,
  };
}

const own = ownRowsSource;
const joined = (name: string, page: ExportSource["page"]): ExportSource => ({ name, page });
const withUrl = (source: ExportSource, prefix: string): ExportSource => ({
  ...source,
  transform: (row) => ({ ...row, url: `${prefix}${String(row.id)}` }),
});
const contactsSource: ExportSource = {
  ...own(contacts),
  // Inline bytes and public Blob URLs become the owner-only avatar route.
  transform: (row) => {
    const url = typeof row.profile_image_url === "string" ? row.profile_image_url : null;
    const proxied = url && (url.startsWith("data:") || url.includes(".public.blob.vercel-storage.com"));
    return { ...row, profile_image_url: proxied ? `/api/avatars/${String(row.id)}` : url };
  },
};
```

In `type CategoryStep`, after `counts: PgTable[];`, add:

```ts
  /** What this category exports — one dataset per table, same boundary as the delete. */
  exports: ExportSource[];
```

Add one `exports` line to each step, directly after its `counts` line:

```ts
  // insights
    exports: [own(aiSuggestions), own(contactEmbeddings), own(closenessCohorts, "user_id")],
  // notes
    exports: [own(interactions), own(noteBatches), own(interactionMentions), own(actionItems), own(meetingSessions), own(meetingTranscriptSegments), own(captureJobs), own(captureHandoffs), own(ignoredPeople), withUrl(own(capturePhotos), "/api/capture/photos/")],
  // reminders
    exports: [own(reminders), own(reminderLists), own(suggestedReminders)],
  // imports
    exports: [own(imports), own(importJobRows)],
  // connections
    exports: [own(gmailConnections), own(outlookConnections), own(calendarSubscriptions), own(eventProviderConnections)],
  // events
    exports: [own(events), own(eventAttendees), own(eventCompanies), own(eventAliases)],
  // goals
    exports: [own(userGoals)],
  // chat
    exports: [own(chatThreads), own(chatMessages)],
  // recruiters
    exports: [
      joined("user_recruiter_links", (userId, limit, offset) => sql`SELECT l.*, r.full_name AS recruiter_full_name, r.firm AS recruiter_firm FROM user_recruiter_links l JOIN recruiters r ON r.id = l.recruiter_id WHERE l.user_id = ${userId} ORDER BY l.id LIMIT ${limit} OFFSET ${offset}`),
      own(recruiterMessages),
      own(recruiterScanState),
    ],
  // api
    exports: [own(apiKeys), own(webhookEndpoints), own(outboundWebhookDeliveries), own(apiIdempotencyKeys, "idempotency_key")],
  // activity
    exports: [own(usageEvents), own(extensionUsage, "user_id"), own(errorEvents), own(gateEvents), own(planUpgradeEvents), own(pageViews)],
  // feedback
    exports: [own(feedback), withUrl(own(feedbackScreenshots), "/api/feedback/screenshots/")],
  // outreach
    exports: [
      own(outreachCampaigns),
      joined("outreach_prospects", (userId, limit, offset) => sql`SELECT p.* FROM outreach_prospects p JOIN outreach_campaigns c ON c.id = p.campaign_id WHERE c.user_id = ${userId} ORDER BY p.id LIMIT ${limit} OFFSET ${offset}`),
      joined("outreach_messages", (userId, limit, offset) => sql`SELECT m.* FROM outreach_messages m JOIN outreach_prospects p ON p.id = m.prospect_id JOIN outreach_campaigns c ON c.id = p.campaign_id WHERE c.user_id = ${userId} ORDER BY m.id LIMIT ${limit} OFFSET ${offset}`),
    ],
  // contacts
    exports: [
      contactsSource,
      own(companies),
      own(contactMerges),
      own(contactIdentities),
      own(duplicateSuggestions),
      own(targetCompanies),
      own(contactBriefs, "contact_id"),
      own(contactProfiles),
      own(contactExperiences),
      joined("contact_tags", (userId, limit, offset) => sql`SELECT ct.* FROM contact_tags ct JOIN contacts c ON c.id = ct.contact_id WHERE c.user_id = ${userId} ORDER BY ct.id LIMIT ${limit} OFFSET ${offset}`),
    ],
  // tags
    exports: [own(tags)],
  // preferences
    exports: [own(userSettings)],
```

After `STEPS`, add:

```ts
export function exportSourcesFor(category: DataCategory): readonly ExportSource[] {
  return STEPS[category].exports;
}

export function countedTableNames(category: DataCategory): string[] {
  return STEPS[category].counts.map(getTableName);
}
```

- [ ] **Step 3: Create `src/lib/data-export.ts`**

```ts
import { getDb, rowsOf } from "@/db";
import { billingEvents } from "@/db/schema";
import { DATA_CATEGORY_META, type DataCategory } from "@/lib/data-categories";
import { exportSourcesFor, ownRowsSource, type ExportSource } from "@/lib/user-data";

/**
 * "Download my data", built from the same registry as "delete my data" so the two cannot
 * disagree about what a category is. Streamed page by page: a large account's export is
 * many megabytes, past both the 4.5 MB serverless response limit for a buffered body and
 * the server-action body limit (`CAPTURE_BODY_SIZE_LIMIT`, 32 MB).
 */
const PAGE = 500;
const REDACTED_SUFFIX = /(_encrypted|token|secret|_hash)$/i;
const EXCLUDED = new Set(["embedding", "embedding_vector", "blob_url", "inline_data"]);
const ACCOUNT_SOURCES: ExportSource[] = [ownRowsSource(billingEvents)];

export type UserExport = {
  format: string;
  exportedAt: string;
  categories: Record<DataCategory, Record<string, Record<string, unknown>[]>>;
  account: Record<string, Record<string, unknown>[]>;
};

/** Credentials, hashes, vectors and raw bytes never leave. */
export function redactExportRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (REDACTED_SUFFIX.test(key) || EXCLUDED.has(key)) continue;
    out[key] = value;
  }
  return out;
}

async function* datasetChunks(userId: string, source: ExportSource): AsyncGenerator<string> {
  const db = await getDb();
  yield `${JSON.stringify(source.name)}:[`;
  let first = true;
  for (let offset = 0; ; offset += PAGE) {
    const rows = rowsOf<Record<string, unknown>>(await db.execute(source.page(userId, PAGE, offset)));
    for (const raw of rows) {
      const clean = redactExportRow(raw);
      yield `${first ? "" : ","}${JSON.stringify(source.transform ? source.transform(clean) : clean)}`;
      first = false;
    }
    if (rows.length < PAGE) break;
  }
  yield "]";
}

async function* groupChunks(userId: string, sources: readonly ExportSource[]): AsyncGenerator<string> {
  yield "{";
  for (const [i, source] of sources.entries()) {
    if (i > 0) yield ",";
    yield* datasetChunks(userId, source);
  }
  yield "}";
}

export async function* userExportChunks(userId: string, now = new Date()): AsyncGenerator<string> {
  yield `{"format":"orbit-export/2","exportedAt":${JSON.stringify(now.toISOString())},"categories":{`;
  for (const [i, { id }] of DATA_CATEGORY_META.entries()) {
    yield `${i > 0 ? "," : ""}${JSON.stringify(id)}:`;
    yield* groupChunks(userId, exportSourcesFor(id));
  }
  yield `},"account":`;
  yield* groupChunks(userId, ACCOUNT_SOURCES);
  yield "}";
}

export function userExportStream(userId: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = userExportChunks(userId);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

export async function collectUserExport(userId: string): Promise<UserExport> {
  let text = "";
  for await (const chunk of userExportChunks(userId)) text += chunk;
  return JSON.parse(text) as UserExport;
}
```

- [ ] **Step 4: Verify and commit**

```bash
npx tsx scripts/smoke-data-export.ts
npx tsx scripts/smoke-purge.ts
npx tsx scripts/smoke-purge-selective.ts
npm run typecheck && npm run lint
git add src/lib/user-data.ts src/lib/data-export.ts scripts/smoke-data-export.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Build the data export from the deletion registry, one dataset per category, no secrets

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Serve the export as a streamed download from `/api/export`

`exportAllData` (`src/actions/settings.ts:399–433`) returns six tables through a server action. That caps the payload at the action body limit and buffers it. It is replaced by a `GET /api/export` route handler that streams Task 16's export, and the Settings button fetches it.

**Files:**
- Create: `src/app/api/export/route.ts`
- Modify: `src/actions/settings.ts` — delete `exportAllData` (399–433), trim the schema import (6–15)
- Modify: `src/components/settings/data-settings.tsx` (7, 34–62)

**Interfaces**
- Consumes: `userExportStream` (Task 16), `requireUserId`.
- Produces: `GET /api/export` → `200 application/json` attachment `orbit-export-YYYY-MM-DD.json`, `401` without a session.

- [ ] **Step 1: Read the docs**

Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (the "Streaming" section) and `…/02-route-segment-config` for `maxDuration`. Confirm `/api/export` is not in `PUBLIC_ROUTES` in `proxy.ts`, so Clerk protects it (after Phase 0's B1 fix, an anonymous request gets a 401 JSON).

- [ ] **Step 2: The route**

Create `src/app/api/export/route.ts`:

```ts
import { requireUserId } from "@/lib/auth";
import { userExportStream } from "@/lib/data-export";

/** A large network pages through every table; the stream keeps memory flat, not time short. */
export const maxDuration = 300;

/**
 * The signed-in user's own data, as one JSON file, streamed. Owner-only by construction:
 * the only input is the session. No secrets, tokens or photo bytes; see `data-export.ts`.
 */
export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return new Response(null, { status: 401 });
  }
  const date = new Date().toISOString().slice(0, 10);
  return new Response(userExportStream(userId), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="orbit-export-${date}.json"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
```

- [ ] **Step 3: Remove the old action**

In `src/actions/settings.ts`, delete the whole `exportAllData` function. Replace the schema import with `import { contactEmbeddings, userSettings } from "@/db/schema";`. Those two are still used, at line ~254 and throughout; the other six served only the export. Run `grep -rn "exportAllData" src scripts` and expect only `data-settings.tsx`, fixed next.

- [ ] **Step 4: The Settings button**

In `src/components/settings/data-settings.tsx`, remove `import { exportAllData } from "@/actions/settings";` and add `import { friendlyError } from "@/lib/errors";`. Change the Export row's description to `"Everything in each category below, as one JSON file — photos as links that open while you’re signed in. Keys and tokens are left out."` Replace the button's `onClick` with:

```tsx
          onClick={() =>
            startExport(async () => {
              try {
                const res = await fetch("/api/export", { cache: "no-store" });
                if (!res.ok) throw new Error(`export responded ${res.status}`);
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `orbit-export-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
                toast.success("Export downloaded");
              } catch (err) {
                toast.error(friendlyError(err, "Couldn’t build your export — try again?"));
              }
            })
          }
```

- [ ] **Step 5: Verify**

```bash
npx tsx scripts/smoke-data-export.ts
npx tsx scripts/smoke-toast-copy.ts
npm run typecheck && npm run lint
```

Browser (`orbit-web`, demo workspace): Settings → Data and privacy → Export JSON, and expect the "Export downloaded" toast. Then, in the browser pane, run `const r = await fetch("/api/export"); const j = await r.json(); [r.headers.get("content-disposition"), Object.keys(j.categories).length, JSON.stringify(j).match(/"[a-z_]*(_encrypted|token|secret)":/)]` and expect `attachment; filename="orbit-export-…json"`, `16` and `null`. A `curl -i http://localhost:3001/api/export` from the terminal (no cookie) returns 401 only when Clerk keys are set; in demo mode it returns the demo account's export.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/export/route.ts src/actions/settings.ts src/components/settings/data-settings.tsx
git commit -m "$(cat <<'EOF'
Stream the full data export from /api/export instead of a server action

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Before pushing the branch**

Re-run the `SCHEMA_VERSION` scan from Global Constraints. If any remote branch now claims `<N>` or higher, bump to one above it, re-run `npx tsx scripts/smoke-schema-ddl.ts --update`, and amend the changelog line with the reason. Then run `npm test` and `npm run build`.

---

### Task 18: Subscribers can cancel and manage billing themselves (Stripe customer portal)

Found while writing Phase 1: there is no self-serve way to cancel Orbit Pro. The Terms say "write to us, or delete your account", and several US state auto-renewal laws (California's among them) expect a subscription bought online to be cancellable online. Stripe's hosted customer portal does cancellation, card updates and invoices, so Orbit only has to open it.

**Files:**
- Create: `src/lib/billing-portal.ts`
- Modify: `src/actions/billing.ts` (new export after `getCurrentPlan`)
- Create: `src/components/settings/manage-billing-button.tsx`
- Modify: `src/components/settings/plan-settings.tsx` — the button row (`<div className="flex flex-wrap items-center gap-3 border-t …">`, near the end)
- Create: `scripts/smoke-billing-portal.ts`; Modify: `scripts/run-smoke.ts` (pglite section)

**Interfaces:**
- Consumes: `user_settings.stripe_customer_id` (exists), `getStripe()` from `src/lib/stripe.ts`, `getAppBaseUrl()` from `src/lib/app-url.ts`, `getEntitlements` from `src/lib/entitlements.ts`.
- Produces: `type BillingPortalResult = { url: string } | { error: string }`; `BILLING_PORTAL_COPY = { noSubscription, unavailable }`; `createBillingPortalUrl(userId: string, deps?: { createSession?: (args: { customer: string; return_url: string }) => Promise<{ url: string | null }> }): Promise<BillingPortalResult>`; server action `openBillingPortal(): Promise<BillingPortalResult>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-billing-portal.ts`:

```ts
/**
 * A subscriber can open Stripe's customer portal to cancel or change billing, and nobody
 * else gets a portal session for a customer that is not theirs.
 *
 * Run: npx tsx scripts/smoke-billing-portal.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { BILLING_PORTAL_COPY, createBillingPortalUrl } from "../src/lib/billing-portal";

const SUBSCRIBER = "smoke-portal-subscriber";
const LIFETIME = "smoke-portal-lifetime";
const FREE = "smoke-portal-free";

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
  for (const id of [SUBSCRIBER, LIFETIME, FREE]) await ensureUserSettings(id);
  const future = new Date(Date.now() + 20 * 86_400_000);
  await db.update(userSettings)
    .set({ stripeCustomerId: "cus_smoke_sub", subscriptionPlan: "orbit", subscriptionStatus: "active", subscriptionPeriodEnd: future })
    .where(eq(userSettings.userId, SUBSCRIBER));
  await db.update(userSettings)
    .set({ stripeCustomerId: "cus_smoke_life", lifetimePurchasedAt: new Date() })
    .where(eq(userSettings.userId, LIFETIME));

  const calls: Array<{ customer: string; return_url: string }> = [];
  const createSession = async (args: { customer: string; return_url: string }) => {
    calls.push(args);
    return { url: `https://billing.stripe.test/session/${args.customer}` };
  };

  console.log("A subscriber gets a portal session for their own customer");
  const sub = await createBillingPortalUrl(SUBSCRIBER, { createSession });
  check("returns the session url", "url" in sub && sub.url === "https://billing.stripe.test/session/cus_smoke_sub", JSON.stringify(sub));
  check("for their own customer id", calls[0]?.customer === "cus_smoke_sub");
  check("returning to the plan card", /\/settings#settings-plan$/.test(calls[0]?.return_url ?? ""), calls[0]?.return_url);

  console.log("\nNobody else gets one");
  const life = await createBillingPortalUrl(LIFETIME, { createSession });
  check("a Lifetime buyer (no subscription) is told there is nothing to manage",
    "error" in life && life.error === BILLING_PORTAL_COPY.noSubscription, JSON.stringify(life));
  const free = await createBillingPortalUrl(FREE, { createSession });
  check("a free account is told the same", "error" in free && free.error === BILLING_PORTAL_COPY.noSubscription);
  check("neither reached Stripe", calls.length === 1, String(calls.length));

  console.log("\nStripe trouble is a sentence, not a stack trace");
  const broken = await createBillingPortalUrl(SUBSCRIBER, {
    createSession: async () => { throw new Error("No configuration provided; set your default configuration in the dashboard"); },
  });
  check("a Stripe error returns the unavailable copy",
    "error" in broken && broken.error === BILLING_PORTAL_COPY.unavailable, JSON.stringify(broken));
  const noUrl = await createBillingPortalUrl(SUBSCRIBER, { createSession: async () => ({ url: null }) });
  check("a session without a url returns the unavailable copy", "error" in noUrl && noUrl.error === BILLING_PORTAL_COPY.unavailable);

  check("copy follows the house voice",
    !/failed|Could not|\.$/.test(BILLING_PORTAL_COPY.noSubscription + BILLING_PORTAL_COPY.unavailable));

  if (failures > 0) throw new Error(`${failures} billing-portal check(s) failed`);
  console.log("\nAll billing-portal checks passed.");
});
```

Add `"smoke-billing-portal": "pglite",` to the pglite block of `MANIFEST` in `scripts/run-smoke.ts`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-billing-portal.ts`
Expected: exits 1 with a module-not-found error for `../src/lib/billing-portal`.

- [ ] **Step 3: Implement the lib function**

Create `src/lib/billing-portal.ts`:

```ts
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import { getEntitlements } from "@/lib/entitlements";
import { getStripe } from "@/lib/stripe";

/**
 * Opens Stripe's hosted customer portal, where a subscriber cancels, changes card or reads
 * invoices. Orbit renders none of that itself: cancellation handled by Stripe is cancellation
 * whose webhook (`customer.subscription.updated` / `.deleted`) the existing handler already
 * turns into the right plan.
 *
 * Only an account whose plan comes from a subscription gets a session. A Lifetime buyer has
 * a Stripe customer too, but nothing recurring to manage — sending them to a portal that
 * shows an empty subscription list reads as a bug. The customer id always comes from the
 * caller's own settings row, never from input.
 *
 * `deps.createSession` exists so the smoke can run without Stripe.
 */

export type BillingPortalResult = { url: string } | { error: string };

export const BILLING_PORTAL_COPY = {
  noSubscription: "There’s no subscription on this account to manage",
  unavailable: "Couldn’t open billing just now — try again in a moment",
} as const;

type CreateSession = (args: { customer: string; return_url: string }) => Promise<{ url: string | null }>;

export async function createBillingPortalUrl(
  userId: string,
  deps: { createSession?: CreateSession } = {}
): Promise<BillingPortalResult> {
  const { source } = await getEntitlements(userId);
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { stripeCustomerId: true },
  });
  const customer = row?.stripeCustomerId?.trim();
  if (source !== "subscription" || !customer) {
    return { error: BILLING_PORTAL_COPY.noSubscription };
  }

  const createSession: CreateSession =
    deps.createSession ?? ((args) => getStripe().billingPortal.sessions.create(args));
  try {
    const session = await createSession({
      customer,
      return_url: `${getAppBaseUrl()}/settings#settings-plan`,
    });
    return session.url ? { url: session.url } : { error: BILLING_PORTAL_COPY.unavailable };
  } catch (err) {
    console.error("Stripe billing portal session failed:", err);
    return { error: BILLING_PORTAL_COPY.unavailable };
  }
}
```

Before relying on it, confirm in `node_modules/stripe/types/BillingPortal/SessionsResource.d.ts` that `sessions.create` takes `{ customer, return_url }` and returns a session with `url: string`; the injected type above is deliberately the narrow subset.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-billing-portal.ts`
Expected: `All billing-portal checks passed.`, exit 0. If the Lifetime check fails because `getEntitlements` reports `source: "lifetime"` only when `lifetimePurchasedAt` is set, confirm the seed wrote it (it does above).

- [ ] **Step 5: The action and the button**

In `src/actions/billing.ts` (a `"use server"` module — async exports only), add after `getCurrentPlan`:

```ts
/** Stripe's customer portal for the caller's own subscription. Returns the URL, like checkout. */
export async function openBillingPortal(): Promise<BillingPortalResult> {
  const userId = await requireUserId();
  return createBillingPortalUrl(userId);
}
```

with `import { createBillingPortalUrl, type BillingPortalResult } from "@/lib/billing-portal";` beside the other `@/lib` imports.

Create `src/components/settings/manage-billing-button.tsx`, following `src/components/pricing/pro-checkout-button.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { openBillingPortal } from "@/actions/billing";
import { buttonVariants } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";

/** Opens Stripe's portal: cancel, change card, download invoices. */
export function ManageBillingButton() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        disabled={pending}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        onClick={() => {
          setError(null);
          start(async () => {
            try {
              const result = await openBillingPortal();
              if ("url" in result) {
                window.location.href = result.url;
                return;
              }
              setError(result.error);
            } catch (err) {
              setError(friendlyError(err, "Couldn’t open billing just now — try again in a moment"));
            }
          });
        }}
      >
        {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
        Manage billing
      </button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
```

In `src/components/settings/plan-settings.tsx`, import it (`import { ManageBillingButton } from "@/components/settings/manage-billing-button";`) and, inside the button row after the `See all plans` `WarpLink`, add:

```tsx
          {entitlements.source === "subscription" && <ManageBillingButton />}
```

`plan-settings.tsx` is a server component rendering a client child, which is fine; the child imports only `@/actions/billing`, `@/lib/errors` and UI modules, none of which reach `@/db` from the client bundle (the action is a server reference).

- [ ] **Step 6: Typecheck, lint, voice, browser**

Run: `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`
Expected: exit 0.

In the browser (`orbit-web`, demo mode): a free demo account shows no "Manage billing" button on Settings → Pricing Plan. Then give the demo account a subscription from a tsx one-liner with the dev server stopped (PGlite single-writer): `ensureUserSettings("demo-user")` and set `stripeCustomerId`, `subscriptionPlan: "orbit"`, `subscriptionStatus: "active"`, `subscriptionPeriodEnd` 20 days out. Restart the server and confirm the button appears. With `STRIPE_SECRET_KEY` unset, clicking it shows "Couldn’t open billing just now — try again in a moment". Undo the seed afterwards (Settings → Delete data → Preferences, or reset `.data/pglite`).

- [ ] **Step 7: Commit**

```bash
git add src/lib/billing-portal.ts src/actions/billing.ts src/components/settings/manage-billing-button.tsx src/components/settings/plan-settings.tsx scripts/smoke-billing-portal.ts scripts/run-smoke.ts
git commit -m "$(cat <<'EOF'
Let subscribers cancel and manage billing through Stripe's portal

There was no self-serve way to cancel Orbit Pro. A "Manage billing" button on
the plan card now opens Stripe's customer portal for the caller's own
subscription; cancellations flow back through the existing subscription
webhooks. Lifetime and free accounts are told there is nothing to manage.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Manual steps (not code)

- **Stripe customer portal (Task 18).** Stripe Dashboard → Settings → Billing → Customer portal, in BOTH test and live mode: turn on "Cancel subscriptions" (at period end), "Update payment methods" and "Invoice history"; set the business name, privacy policy URL (`/privacy`) and terms URL (`/terms`); save. Without a saved configuration `billingPortal.sessions.create` throws and the button shows the unavailable copy.

**M1 — Before merging Task 1: prove no Stripe customer is shared.** Against production (Neon SQL editor, read-only role is fine):

```sql
SELECT stripe_customer_id, count(*), array_agg(user_id)
  FROM user_settings
 WHERE stripe_customer_id IS NOT NULL
 GROUP BY 1
HAVING count(*) > 1;
```

It must return zero rows. If it returns any, decide per customer which account owns it (Stripe Dashboard → Customers → the id → Subscriptions/Payments → `orbit_user_id` metadata), null the other row's `stripe_customer_id`, and re-run the query. Otherwise the unique index fails the build-time migration and blocks every deploy.

**M2 — Return path grants without a webhook, and the late webhook is a no-op.** In the branch worktree, put test-mode `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (from step 4), `STRIPE_LIFETIME_PRICE_ID` and `STRIPE_PRO_MONTHLY_PRICE_ID` in `.env.local`, then start `orbit-web` (port 3001).
1. Make sure no `stripe listen` is running.
2. `/pricing` → Lifetime → pay with `4242 4242 4242 4242`, any future date and CVC. You land on `/settings?upgraded=lifetime&session_id=cs_test_…`. Expected: the params vanish, the Plan card reads Orbit Lifetime within a few seconds, and the celebration plays, all with no webhook delivered.
3. Note the session id. Stripe Dashboard (test mode) → Developers → Events → find its `checkout.session.completed` and copy the `evt_…` id.
4. Start forwarding: `stripe listen --forward-to localhost:3001/api/webhooks/stripe` (copy the printed `whsec_…` into `.env.local` and restart the dev server if it changed).
5. Resend the missed event: `stripe events resend evt_…`. If the CLI asks for `--webhook-endpoint`, use Dashboard → the event → Resend to the CLI endpoint instead. Expected: `stripe listen` shows `200`; the plan and `lifetime_purchased_at` are unchanged; `/admin/billing` shows exactly one Lifetime cash row (`cs:<session>`); `/admin/health` webhook deliveries show it `handled`.
6. Repeat 1–5 on a fresh test account with Pro monthly. Expect exactly one `new +500` movement, keyed `csm:<session>`, after the resend.

**M3 — A stale subscription event cannot re-grant.** With `stripe listen` running and a Pro test subscription from M2:
1. Dashboard → the subscription → Update → change the quantity or add metadata. This emits `customer.subscription.updated` (note its `evt_…`).
2. Cancel it immediately: `stripe subscriptions cancel sub_…`. This emits `customer.subscription.deleted`, and the account resolves to free once the period ends (check `/settings`).
3. Resend the older update: `stripe events resend <evt_ from 1>`. Expected: `200`, the delivery recorded as `ignored` with reason `duplicate_event` (dedupe) and no change of plan. The staleness rule itself (`stale_subscription_event`, for an event never delivered before) is covered by `scripts/smoke-stripe-dedupe.ts`, because the CLI cannot replay an event id Stripe never delivered.
4. `stripe trigger customer.subscription.updated` creates a new, unattributed customer. Expect `ignored / missing_user_id` and no effect on your account.

**M4 — After deploying:** open `/admin/health` → cron runs → the next `imports.process-stalled` run's stats include `purgesFound` and `orphansExamined`, and `orphanSweepAborted: false`. If it is `true`, check that `CLERK_SECRET_KEY` in Production belongs to the production Clerk instance.

**M5 — Google:** nothing to configure. Revocation uses the public endpoint. To see it work, connect a throwaway Google account, disconnect it in Orbit, and confirm Orbit is gone from https://myaccount.google.com/connections.

## Self-review

| Audit item | Task(s) |
|---|---|
| B2 verify-on-return (`session_id`, `confirmCheckoutSession`, replay through `decideStripeEvent`, shared apply module, watcher) | 2 (shared `applyStripeDecision`), 4 |
| B2 ordering (`subscription_event_at`, skip older `customer.subscription.*`) | 1 (column), 3 |
| B2 dedupe (`stripe_processed_events`, 200 on repeat) | 1 (table), 2 |
| B2 MRR `beforeCents` robust on retries | 2 (bookings first, strict writes); 4 (`csm:` key for return path + webhook race) |
| B2 `stripe_customer_id` uniqueness (decided: partial unique index + pre-flight) | 1, M1 |
| B3 resumable purge + nightly resume + `purge.stuck` + dialog shows completed categories | 1 (table), 5, 6, 7 |
| B3 missed-webhook reconciliation via Clerk `getUserList` | 8 |
| B3 revoke on disconnect and in `connections` purge; Microsoft documented and linked; "also delete imported" | 9, 10 |
| B3 avatars: random suffix, delete on contact delete, merge loser, contacts purge; inline unchanged without a token | 11, 12, 13 |
| A8 proper (`created_by_user_id`, link PII, pooled-only sharing, backfill) + B3 recruiter cleanup | 1 (columns + backfill), 14, 15 |
| B10 export from the category registry, streamed, no secrets, photos as proxied URLs | 16, 17 |
| B10 contact delete: per-table rule, confirmation copy | 12 |

**Decisions and deviations recorded here:**
- `data_purge_runs.target_user_id` instead of the requested `user_id`: the purge smoke sweeps every `userId` column, and the ledger must outlive the purge. Added `full_purge`, `status` and `last_attempt_at` to the requested columns.
- Recruiter backfill copies shared details only to the determinable contributor: the creator (the earliest link within 5 min of the row), a sole linker, or a Gmail-scan link's email. Every other shared value stays on the shared row, as instructed. On rows with an unknown creator, such a value is dropped later only when a user holding that same value withdraws.
- The Outlook disconnect offers no delete option: categories cannot delete "contacts from Outlook" without deleting all contacts. A per-source contact delete would be new scope.
- `stripe_processed_events` is never pruned (one small row per handled event).
- The per-account subscription clock cannot tell two subscriptions of one user apart. An old canceled subscription's genuinely newer event could still overwrite a new one's mirror, as it can today.
- Photos replaced through other writers (imports, the extension) are not blob-deleted; only the Apollo/LinkedIn refresh path is covered (Task 11).

**Placeholder scan:** the only symbolic value is `<N>`, which is mandated: computed in Task 1 Step 1 and re-checked in Task 17 Step 7. Conditional steps (Task 2 Step 4, Task 3 Step 3h, Task 14 Step 3's `mergeRecruiterFields` note) name the exact Phase 0 code to port if present. Names used across tasks were checked: `applyStripeDecision`, `readDecideContext`, `isStaleSubscriptionEvent`, `confirmCheckoutForUser`, `purgeUserData`, `PurgeIncompleteError`, `resumeStrandedPurges`, `planPurgeSteps`, `PURGE_MAX_ATTEMPTS`, `deletionOutcome`, `sweepOrphanedAccounts`, `revokeGoogleGrant`, `DISCONNECT_DELETE_CATEGORIES`, `putAvatarBlob`, `deleteAvatarBlobs`, `deleteReplacedAvatar`, `setAvatarBlobClientForTests`, `deleteContactForUser`, `resolveRecruiterPii`, `pickPooledPii`, `rederiveSharedRecruiterPii`, `pooledIdsForViewer`, `RECRUITER_DELETED_CREATOR`, `exportSourcesFor`, `countedTableNames`, `userExportStream`, `collectUserExport`.
