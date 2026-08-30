# YC Startup Console Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-admin "YC mode" toggle to Orbit's admin console that swaps the nav for
four new sections (Runway, Revenue, Unit Economics, Fundraising) tracking Orbit as a real,
if small, startup — cash/burn/runway, subscriber-growth-as-revenue-proxy, CAC/LTV, and a
fundraising round tracker — all fed by manual entry, since Orbit has no bank/ad-spend
integration.

**Architecture:** Four new Postgres tables (`startup_expenses`, `cash_snapshots`,
`acquisition_spend`, `fundraising_rounds`/`fundraising_investors`) plus two new
`user_settings` columns (`yc_mode_enabled`, `estimated_monthly_churn_pct`). A new route
group `src/app/(admin)/admin/yc/*` with its own nav array, gated the same way as the
existing admin console. Calculation logic is split into pure functions (unit-tested with
plain fixtures, no DB) and thin DB loaders that fetch rows and call them — mirroring the
existing `loadAdminUserRows()` / `buildPlanBreakdown()` split in `admin-metrics.ts`.

**Tech Stack:** Next.js App Router, Drizzle ORM (`drizzle-orm/pg-core`), Postgres
(Neon in production, PGlite locally), React Server Components + small "use client" islands
for mutations (`useTransition` + Server Actions, no native `<form action>`).

**Spec:** [docs/superpowers/specs/2026-08-29-yc-startup-console-design.md](../specs/2026-08-29-yc-startup-console-design.md)

## Global Constraints

- Money is stored as plain-dollar `real` columns (`amountUsd`, `balanceUsd`, `targetUsd`) —
  never cents. This matches `MONTHLY_AMOUNT = 5` in `src/lib/plan-copy.ts` and `priceUsd` in
  `src/lib/lifetime-offer.ts`; Orbit has no cents-scaled money anywhere.
- Every new DB column must appear in **all** of: `src/db/schema.ts`, the `DDL` template or
  `alters` array in `src/db/index.ts` (Neon), and the `ensureColumn` call list in
  `migratePglite` (PGlite) — `scripts/smoke-schema-ddl.ts`'s coverage check fails the build
  otherwise. New tables only need `DDL` (both engines run it); new columns on an existing
  table need both `alters` (Neon) and `ensureColumn` (PGlite).
- `SCHEMA_VERSION` in `src/db/index.ts` (currently `12`) must be bumped to `13` in the same
  commit as any DDL change — otherwise the new DDL never runs on an already-migrated
  database (see the doc comment at `src/db/index.ts:601-614`).
- Never run `drizzle-kit push` — it drops the runtime-managed
  `contact_embeddings.embedding_vector` column. All schema changes are hand-written DDL.
- Every admin page and Server Action must call `requireAdminPage()` (pages/layouts) or
  `requireAdminUserId()` (Server Actions) — layouts do not re-run on POST, so each action
  re-asserts the gate independently (`src/lib/admin.ts`).
- No native `<form action={...}>` anywhere in the admin console — every mutation is a
  client component using `useTransition` to call a Server Action, then `router.refresh()`.
  Follow `SurfaceRow` / `ViewAsUserButton` in `src/components/admin/surface-toggles.tsx`.
- Reuse `AdminPageHeader`, `AdminPanel`, `MetricTile`, `TrendBars`, `EmptyState` from
  `src/components/admin/primitives.tsx` for every new page. Do not invent new "deck-style"
  components — this codebase's stated posture is not to abstract for a single call site.
- Pure calculation logic lives in files with no `getDb()` import, so it can be tested with
  plain fixtures using the project's no-framework smoke-test convention: a `check(label,
  condition)` helper, assertions in `main()`, `main(); process.exit(0);` at the end (see
  `scripts/smoke-lifetime-pricing.ts`). Run with `npx tsx scripts/smoke-<name>.ts`.

---

## Task 1: Schema, migration DDL, and the schema-DDL guard

**Files:**
- Modify: `src/db/schema.ts` (add 4 tables + 2 `userSettings` columns)
- Modify: `src/db/index.ts` (DDL, alters, ensureColumn, SCHEMA_VERSION)
- Modify: `scripts/schema-ddl.lock.json` (regenerated, not hand-edited)

**Interfaces:**
- Produces: `startupExpenses`, `cashSnapshots`, `acquisitionSpend`, `fundraisingRounds`,
  `fundraisingInvestors` tables (exact shapes below); `userSettings.ycModeEnabled: boolean`,
  `userSettings.estimatedMonthlyChurnPct: number | null`. Every later task imports tables
  from `@/db/schema` by these exact names.

- [ ] **Step 1: Add the five schema definitions**

Open `src/db/schema.ts` and add this block immediately after the `appSurfaceFlags` export
(around line 1605), before `contactsRelations`:

```ts
/**
 * Manually-entered spend, for the YC-mode Runway page's burn calculation. No integration
 * exists to pull this automatically — Orbit has no bank/accounting connection.
 */
export const startupExpenses = pgTable("startup_expenses", {
  id: uuid("id").defaultRandom().primaryKey(),
  category: text("category").notNull(),
  amountUsd: real("amount_usd").notNull(),
  incurredAt: timestamp("incurred_at", { withTimezone: true }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Point-in-time cash-on-hand entries. The latest row is "current" cash for Runway. */
export const cashSnapshots = pgTable("cash_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  balanceUsd: real("balance_usd").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Manually-logged acquisition spend by channel, for the Unit Economics CAC calculation. */
export const acquisitionSpend = pgTable("acquisition_spend", {
  id: uuid("id").defaultRandom().primaryKey(),
  channel: text("channel").notNull(),
  amountUsd: real("amount_usd").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const fundraisingRounds = pgTable("fundraising_rounds", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  targetUsd: real("target_usd").notNull(),
  status: text("status").$type<"open" | "closed">().notNull().default("open"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** No FK-cascade delete: closing/deleting a round should not silently erase commitments. */
export const fundraisingInvestors = pgTable("fundraising_investors", {
  id: uuid("id").defaultRandom().primaryKey(),
  roundId: uuid("round_id").notNull().references(() => fundraisingRounds.id),
  name: text("name").notNull(),
  amountUsd: real("amount_usd").notNull(),
  committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
  note: text("note"),
});
```

Then add the two new columns to the `userSettings` table definition (around line 86, right
after the existing `theme` field):

```ts
  theme: text("theme").$type<"light" | "dark" | "system">(),
  ycModeEnabled: boolean("yc_mode_enabled").default(false),
  /**
   * Manual estimate feeding the Unit Economics LTV calculation. Orbit's subscriber count
   * is too small to derive a reliable churn rate from cancellation history, so this is
   * entered by hand like the expense/spend figures elsewhere in YC mode.
   */
  estimatedMonthlyChurnPct: real("estimated_monthly_churn_pct"),
```

Add `boolean` to the `drizzle-orm/pg-core` import list at the top of the file (it currently
imports `pgTable, text, timestamp, integer, real, jsonb, uuid, index, uniqueIndex` — `real`
is already there, `boolean` is not).

- [ ] **Step 2: Add the DDL, alters, ensureColumn, and version bump**

In `src/db/index.ts`, add to the `DDL` template string, immediately after the
`app_surface_flags` table (around line 592, before the closing `` ` ``):

```sql
CREATE TABLE IF NOT EXISTS startup_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  amount_usd real NOT NULL,
  incurred_at timestamptz NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cash_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of timestamptz NOT NULL,
  balance_usd real NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS acquisition_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL,
  amount_usd real NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fundraising_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  target_usd real NOT NULL,
  status text NOT NULL DEFAULT 'open',
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fundraising_investors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id uuid NOT NULL REFERENCES fundraising_rounds(id),
  name text NOT NULL,
  amount_usd real NOT NULL,
  committed_at timestamptz NOT NULL,
  note text
);
```

Add to the Neon `alters` array (around line 1358, after the `lifetime_purchased_at` line):

```ts
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS yc_mode_enabled boolean DEFAULT false`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS estimated_monthly_churn_pct real`,
```

Add to `migratePglite` (around line 949, after the `theme` ensureColumn call):

```ts
  await ensureColumn(client, "user_settings", "yc_mode_enabled", "boolean DEFAULT false");
  await ensureColumn(client, "user_settings", "estimated_monthly_churn_pct", "real");
```

Bump the version:

```ts
export const SCHEMA_VERSION = 13;
```

- [ ] **Step 3: Run the schema-DDL guard and regenerate its lock file**

Run: `npx tsx scripts/smoke-schema-ddl.ts`
Expected: FAILS — reports the five new tables/columns exist in `schema.ts` but the lock
fingerprint doesn't match the new DDL yet.

Run: `npx tsx scripts/smoke-schema-ddl.ts --update`
Expected: regenerates `scripts/schema-ddl.lock.json`, prints success.

Run: `npx tsx scripts/smoke-schema-ddl.ts` again
Expected: PASSES.

- [ ] **Step 4: Verify the new tables actually migrate cleanly on PGlite**

Run: `npm run db:setup` (or whatever bootstraps the local `.data/pglite` — check
`package.json`'s `db:setup` script) against a throwaway local DB, then confirm the five new
tables exist:

```bash
npx tsx -e "
import { getDb } from './src/db';
const db = await getDb();
const r = await db.execute(\`select table_name from information_schema.tables where table_name in ('startup_expenses','cash_snapshots','acquisition_spend','fundraising_rounds','fundraising_investors') order by table_name\`);
console.log(r.rows.map((x) => x.table_name));
process.exit(0);
"
```

Expected: prints all five table names.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/index.ts scripts/schema-ddl.lock.json
git commit -m "feat: add YC-mode schema (expenses, cash, acquisition spend, fundraising)"
```

---

## Task 2: Pure calculation functions

**Files:**
- Create: `src/lib/admin-yc-calculations.ts`
- Test: `scripts/smoke-admin-yc-calculations.ts`

**Interfaces:**
- Consumes: nothing (pure functions, no DB, no imports from Task 1's tables)
- Produces:
  - `computeMonthlyBurn(expenses: { amountUsd: number; incurredAt: Date }[], asOf: Date): number`
  - `computeRunway(cashBalanceUsd: number, monthlyBurnUsd: number): number | null` (null = infinite runway, burn is zero or negative)
  - `computeSubscriberGrowth(current: number, previous: number): number | null` (percent; null when `previous` is 0 and `current` is also 0 — no signal either way)
  - `computeCac(acquisitionSpendUsd: number, newSubscribers: number): number | null` (null when `newSubscribers` is 0 — undefined, not zero)
  - `computeLtv(arpuUsd: number, monthlyChurnPct: number | null): number | null` (null when churn is unset or zero — undefined, not infinite)
  - `computeFundraisingProgress(targetUsd: number, raisedUsd: number): number` (percent, clamped to `[0, Infinity)`; 0 when `targetUsd` is 0)

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-admin-yc-calculations.ts`:

```ts
/**
 * Pure YC-mode calculations: runway, subscriber growth, unit economics, fundraising
 * progress. No database — every case here is a fixed input/output pair.
 *
 * Run: npx tsx scripts/smoke-admin-yc-calculations.ts
 */
import {
  computeMonthlyBurn,
  computeRunway,
  computeSubscriberGrowth,
  computeCac,
  computeLtv,
  computeFundraisingProgress,
} from "../src/lib/admin-yc-calculations";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function main() {
  const now = new Date("2026-08-29T00:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  /* ------------------------------------------------------------------------- burn */
  const burn = computeMonthlyBurn(
    [
      { amountUsd: 100, incurredAt: daysAgo(5) },
      { amountUsd: 50, incurredAt: daysAgo(20) },
      { amountUsd: 9999, incurredAt: daysAgo(45) }, // outside the trailing-30-day window
    ],
    now
  );
  check("burn sums only the trailing 30 days", burn === 150, `got ${burn}`);

  /* ---------------------------------------------------------------------- runway */
  check("runway divides cash by burn", computeRunway(1500, 300) === 5);
  check("zero burn means infinite runway (null)", computeRunway(1500, 0) === null);
  check("negative burn (net income) also reads as infinite runway", computeRunway(1500, -50) === null);

  /* ------------------------------------------------------------- subscriber growth */
  check("growth from 10 to 15 is +50%", computeSubscriberGrowth(15, 10) === 50);
  check("growth from 10 to 5 is -50%", computeSubscriberGrowth(5, 10) === -50);
  check("0 to 0 has no signal (null)", computeSubscriberGrowth(0, 0) === null);
  check("0 to 3 is null (no prior baseline to compare against)", computeSubscriberGrowth(3, 0) === null);

  /* -------------------------------------------------------------------------- cac */
  check("CAC divides spend by new subscribers", computeCac(500, 10) === 50);
  check("zero new subscribers makes CAC undefined (null)", computeCac(500, 0) === null);

  /* -------------------------------------------------------------------------- ltv */
  check("LTV divides ARPU by churn rate", computeLtv(5, 2) === 250, `got ${computeLtv(5, 2)}`);
  check("no churn estimate makes LTV undefined (null)", computeLtv(5, null) === null);
  check("zero churn also makes LTV undefined (null), not infinite", computeLtv(5, 0) === null);

  /* ------------------------------------------------------------ fundraising progress */
  check("progress divides raised by target", computeFundraisingProgress(100000, 25000) === 25);
  check("zero target reads as 0%, not a divide-by-zero error", computeFundraisingProgress(0, 5000) === 0);
  check("progress can exceed 100% on an oversubscribed round", computeFundraisingProgress(100, 150) === 150);

  console.log("\nAll YC-calculation checks passed.");
}

main();
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/smoke-admin-yc-calculations.ts`
Expected: FAIL — `Cannot find module '../src/lib/admin-yc-calculations'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/admin-yc-calculations.ts`:

```ts
const DAY_MS = 24 * 60 * 60 * 1000;

/** Sum of expenses whose `incurredAt` falls within the trailing 30 days of `asOf`. */
export function computeMonthlyBurn(
  expenses: { amountUsd: number; incurredAt: Date }[],
  asOf: Date
): number {
  const since = asOf.getTime() - 30 * DAY_MS;
  return expenses
    .filter((e) => e.incurredAt.getTime() >= since)
    .reduce((sum, e) => sum + e.amountUsd, 0);
}

/**
 * Months of runway left. Zero or negative burn (net income, or nothing logged yet) reads
 * as infinite runway rather than a divide-by-zero — `null` means "not running out."
 */
export function computeRunway(
  cashBalanceUsd: number,
  monthlyBurnUsd: number
): number | null {
  if (monthlyBurnUsd <= 0) return null;
  return cashBalanceUsd / monthlyBurnUsd;
}

/**
 * Percent change from `previous` to `current`. `null` when there is no baseline to compare
 * against (both zero, or previous zero with a positive current) — undefined growth, not
 * infinite growth.
 */
export function computeSubscriberGrowth(
  current: number,
  previous: number
): number | null {
  if (previous === 0) return current === 0 ? null : null;
  return ((current - previous) / previous) * 100;
}

/** Cost to acquire one subscriber. `null` when no new subscribers arrived — undefined, not zero. */
export function computeCac(
  acquisitionSpendUsd: number,
  newSubscribers: number
): number | null {
  if (newSubscribers === 0) return null;
  return acquisitionSpendUsd / newSubscribers;
}

/**
 * Lifetime value: ARPU divided by monthly churn rate (as a percent, e.g. `2` for 2%).
 * `null` when churn is unset or zero — an unknown or zero churn rate makes LTV undefined,
 * not infinite.
 */
export function computeLtv(
  arpuUsd: number,
  monthlyChurnPct: number | null
): number | null {
  if (!monthlyChurnPct) return null;
  return arpuUsd / (monthlyChurnPct / 100);
}

/** Percent of a fundraising target raised so far. Zero target reads as 0%, not NaN. */
export function computeFundraisingProgress(
  targetUsd: number,
  raisedUsd: number
): number {
  if (targetUsd === 0) return 0;
  return (raisedUsd / targetUsd) * 100;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/smoke-admin-yc-calculations.ts`
Expected: PASS, prints "All YC-calculation checks passed."

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin-yc-calculations.ts scripts/smoke-admin-yc-calculations.ts
git commit -m "feat: add pure YC-mode calculation functions"
```

---

## Task 3: DB loaders

**Files:**
- Create: `src/lib/admin-yc-metrics.ts`

**Interfaces:**
- Consumes: `computeMonthlyBurn`, `computeRunway`, `computeSubscriberGrowth`, `computeCac`,
  `computeLtv`, `computeFundraisingProgress` (Task 2); `startupExpenses`, `cashSnapshots`,
  `acquisitionSpend`, `fundraisingRounds`, `fundraisingInvestors` (Task 1);
  `loadAdminUserRows()` and `windowCount()` from `src/lib/admin-metrics.ts` (existing);
  `MONTHLY_AMOUNT` from `src/lib/plan-copy.ts` (existing).
- Produces:
  - `loadRunwayMetrics(now?: Date): Promise<{ cashBalanceUsd: number; monthlyBurnUsd: number; runwayMonths: number | null; recentExpenses: { id: string; category: string; amountUsd: number; incurredAt: Date; note: string | null }[] }>`
  - `loadRevenueGrowth(now?: Date): Promise<{ mrrUsd: number; subscriberGrowthPct: number | null; newSubscribers30d: number; newSubscribersPrior30d: number }>`
  - `loadUnitEconomics(now?: Date): Promise<{ cac: number | null; ltv: number | null; ltvToCac: number | null; spend30dUsd: number; newSubscribers30d: number; estimatedMonthlyChurnPct: number | null }>`
  - `loadFundraisingSummary(): Promise<{ rounds: { id: string; name: string; targetUsd: number; status: "open" | "closed"; raisedUsd: number; progressPct: number; investors: { id: string; name: string; amountUsd: number; committedAt: Date }[] }[] }>`

- [ ] **Step 1: Write `loadRunwayMetrics` and `loadRevenueGrowth`**

Create `src/lib/admin-yc-metrics.ts`:

```ts
import { desc, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import {
  acquisitionSpend,
  cashSnapshots,
  fundraisingInvestors,
  fundraisingRounds,
  startupExpenses,
  userSettings,
} from "@/db/schema";
import { loadAdminUserRows, windowCount } from "@/lib/admin-metrics";
import { MONTHLY_AMOUNT } from "@/lib/plan-copy";
import { requireAdminUserId } from "@/lib/admin";
import {
  computeCac,
  computeFundraisingProgress,
  computeLtv,
  computeMonthlyBurn,
  computeRunway,
  computeSubscriberGrowth,
} from "@/lib/admin-yc-calculations";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function loadRunwayMetrics(now = new Date()) {
  const db = await getDb();
  const [latestSnapshot, expenseRows] = await Promise.all([
    db.query.cashSnapshots.findFirst({
      orderBy: [desc(cashSnapshots.asOf)],
    }),
    db.query.startupExpenses.findMany({
      where: gte(startupExpenses.incurredAt, new Date(now.getTime() - THIRTY_DAYS_MS)),
      orderBy: [desc(startupExpenses.incurredAt)],
    }),
  ]);

  const cashBalanceUsd = latestSnapshot?.balanceUsd ?? 0;
  const monthlyBurnUsd = computeMonthlyBurn(expenseRows, now);

  return {
    cashBalanceUsd,
    monthlyBurnUsd,
    runwayMonths: computeRunway(cashBalanceUsd, monthlyBurnUsd),
    recentExpenses: expenseRows.map((e) => ({
      id: e.id,
      category: e.category,
      amountUsd: e.amountUsd,
      incurredAt: e.incurredAt,
      note: e.note,
    })),
  };
}

/**
 * Growth is a new-subscriber count comparison, not a claimed dollar MRR delta — Orbit has
 * one flat price and stores no historical MRR series, so subscriber growth is the honest
 * proxy for revenue growth at this stage.
 */
export async function loadRevenueGrowth(now = new Date()) {
  const rows = await loadAdminUserRows();
  const activeSubscribers = rows.filter((r) => r.subscriptionStatus === "active");
  const { current, previous } = windowCount(
    activeSubscribers.map((r) => r.signupAt),
    30,
    now
  );

  return {
    mrrUsd: activeSubscribers.length * MONTHLY_AMOUNT,
    subscriberGrowthPct: computeSubscriberGrowth(current, previous),
    newSubscribers30d: current,
    newSubscribersPrior30d: previous,
  };
}
```

- [ ] **Step 2: Write `loadUnitEconomics` and `loadFundraisingSummary`**

Append to `src/lib/admin-yc-metrics.ts`:

```ts
export async function loadUnitEconomics(now = new Date()) {
  const db = await getDb();
  const since = new Date(now.getTime() - THIRTY_DAYS_MS);

  const [spendRows, rows, settings] = await Promise.all([
    db.query.acquisitionSpend.findMany({
      where: gte(acquisitionSpend.periodStart, since),
    }),
    loadAdminUserRows(),
    (async () => {
      const adminUserId = await requireAdminUserId();
      return db.query.userSettings.findFirst({
        where: eq(userSettings.userId, adminUserId),
      });
    })(),
  ]);

  const activeSubscribers = rows.filter((r) => r.subscriptionStatus === "active");
  const { current: newSubscribers30d } = windowCount(
    activeSubscribers.map((r) => r.signupAt),
    30,
    now
  );
  const spend30dUsd = spendRows.reduce((sum, r) => sum + r.amountUsd, 0);
  const estimatedMonthlyChurnPct = settings?.estimatedMonthlyChurnPct ?? null;

  const cac = computeCac(spend30dUsd, newSubscribers30d);
  const ltv = computeLtv(MONTHLY_AMOUNT, estimatedMonthlyChurnPct);

  return {
    cac,
    ltv,
    ltvToCac: cac && ltv ? ltv / cac : null,
    spend30dUsd,
    newSubscribers30d,
    estimatedMonthlyChurnPct,
  };
}

export async function loadFundraisingSummary() {
  const db = await getDb();
  const [rounds, investors] = await Promise.all([
    db.query.fundraisingRounds.findMany({ orderBy: [desc(fundraisingRounds.createdAt)] }),
    db.query.fundraisingInvestors.findMany({ orderBy: [desc(fundraisingInvestors.committedAt)] }),
  ]);

  return {
    rounds: rounds.map((round) => {
      const roundInvestors = investors.filter((i) => i.roundId === round.id);
      const raisedUsd = roundInvestors.reduce((sum, i) => sum + i.amountUsd, 0);
      return {
        id: round.id,
        name: round.name,
        targetUsd: round.targetUsd,
        status: round.status,
        raisedUsd,
        progressPct: computeFundraisingProgress(round.targetUsd, raisedUsd),
        investors: roundInvestors.map((i) => ({
          id: i.id,
          name: i.name,
          amountUsd: i.amountUsd,
          committedAt: i.committedAt,
        })),
      };
    }),
  };
}
```

- [ ] **Step 3: Verify it builds and type-checks**

Run: `npx tsc --noEmit`
Expected: no new errors referencing `admin-yc-metrics.ts`. (If `db.query.cashSnapshots` /
`db.query.startupExpenses` / etc. are not recognized, confirm `src/db/index.ts`'s
`drizzle({ schema })` call passes the full `* as schema` import so Drizzle's query API picks
up the new tables automatically — no relations wiring is needed since none of these tables
are queried through `with:`.)

- [ ] **Step 4: Smoke-check against the local database**

Run: `npx tsx -e "
import { loadRunwayMetrics, loadRevenueGrowth, loadUnitEconomics, loadFundraisingSummary } from './src/lib/admin-yc-metrics';
console.log(await loadRunwayMetrics());
console.log(await loadRevenueGrowth());
console.log(await loadFundraisingSummary());
process.exit(0);
"`
Expected: prints objects with zeroed/null metrics (no data entered yet) and no thrown
errors. Skip `loadUnitEconomics` here — it calls `requireAdminUserId()`, which needs a real
request-scoped auth context and will throw outside one; it's exercised in Task 4 via the
page instead.

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin-yc-metrics.ts
git commit -m "feat: add YC-mode DB loaders for runway, revenue, economics, fundraising"
```

---

## Task 4: Server Actions

**Files:**
- Create: `src/actions/admin-yc.ts`
- Modify: `src/actions/admin.ts` (add `setYcModeAction`)

**Interfaces:**
- Consumes: `requireAdminUserId` (`src/lib/admin.ts`); `startupExpenses`, `cashSnapshots`,
  `acquisitionSpend`, `fundraisingRounds`, `fundraisingInvestors`, `userSettings` (Task 1).
- Produces:
  - `setYcModeAction(input: { on: boolean }): Promise<{ ok: true }>` in `src/actions/admin.ts`
  - `addStartupExpenseAction(input: { category: string; amountUsd: number; incurredAt: string; note?: string }): Promise<{ ok: true }>`
  - `setCashSnapshotAction(input: { balanceUsd: number; asOf: string }): Promise<{ ok: true }>`
  - `addAcquisitionSpendAction(input: { channel: string; amountUsd: number; periodStart: string; periodEnd: string }): Promise<{ ok: true }>`
  - `setEstimatedChurnAction(input: { monthlyChurnPct: number }): Promise<{ ok: true }>`
  - `createFundraisingRoundAction(input: { name: string; targetUsd: number }): Promise<{ ok: true }>`
  - `addFundraisingInvestorAction(input: { roundId: string; name: string; amountUsd: number; committedAt: string }): Promise<{ ok: true }>`
  All in `src/actions/admin-yc.ts` unless noted.

- [ ] **Step 1: Add `setYcModeAction` to `src/actions/admin.ts`**

This is a personal per-admin preference, not an action affecting another user's data or
visibility (unlike `setSurfaceHiddenAction` / `setViewAsUserAction`), so it follows
`saveThemePreference`'s simpler upsert — no `recordAdminAction` audit entry. Add after
`setViewAsUserAction`:

```ts
export async function setYcModeAction(input: { on: boolean }): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  const db = await getDb();

  await db
    .insert(userSettings)
    .values({ userId: adminUserId, ycModeEnabled: input.on })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { ycModeEnabled: input.on, updatedAt: new Date() },
    });

  return { ok: true };
}
```

`userSettings` and `getDb` are already imported at the top of `src/actions/admin.ts`.

- [ ] **Step 2: Write `src/actions/admin-yc.ts`**

```ts
"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  acquisitionSpend,
  cashSnapshots,
  fundraisingInvestors,
  fundraisingRounds,
  startupExpenses,
  userSettings,
} from "@/db/schema";
import { requireAdminUserId } from "@/lib/admin";

export async function addStartupExpenseAction(input: {
  category: string;
  amountUsd: number;
  incurredAt: string;
  note?: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db.insert(startupExpenses).values({
    category: input.category,
    amountUsd: input.amountUsd,
    incurredAt: new Date(input.incurredAt),
    note: input.note?.trim() || null,
  });

  revalidatePath("/admin/yc/runway");
  return { ok: true };
}

export async function setCashSnapshotAction(input: {
  balanceUsd: number;
  asOf: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db.insert(cashSnapshots).values({
    balanceUsd: input.balanceUsd,
    asOf: new Date(input.asOf),
  });

  revalidatePath("/admin/yc/runway");
  return { ok: true };
}

export async function addAcquisitionSpendAction(input: {
  channel: string;
  amountUsd: number;
  periodStart: string;
  periodEnd: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db.insert(acquisitionSpend).values({
    channel: input.channel,
    amountUsd: input.amountUsd,
    periodStart: new Date(input.periodStart),
    periodEnd: new Date(input.periodEnd),
  });

  revalidatePath("/admin/yc/economics");
  return { ok: true };
}

export async function setEstimatedChurnAction(input: {
  monthlyChurnPct: number;
}): Promise<{ ok: true }> {
  const adminUserId = await requireAdminUserId();
  const db = await getDb();

  await db
    .insert(userSettings)
    .values({ userId: adminUserId, estimatedMonthlyChurnPct: input.monthlyChurnPct })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { estimatedMonthlyChurnPct: input.monthlyChurnPct, updatedAt: new Date() },
    });

  revalidatePath("/admin/yc/economics");
  return { ok: true };
}

export async function createFundraisingRoundAction(input: {
  name: string;
  targetUsd: number;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db.insert(fundraisingRounds).values({
    name: input.name,
    targetUsd: input.targetUsd,
  });

  revalidatePath("/admin/yc/fundraising");
  return { ok: true };
}

export async function addFundraisingInvestorAction(input: {
  roundId: string;
  name: string;
  amountUsd: number;
  committedAt: string;
}): Promise<{ ok: true }> {
  await requireAdminUserId();
  const db = await getDb();

  await db.insert(fundraisingInvestors).values({
    roundId: input.roundId,
    name: input.name,
    amountUsd: input.amountUsd,
    committedAt: new Date(input.committedAt),
  });

  revalidatePath("/admin/yc/fundraising");
  return { ok: true };
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in `src/actions/admin-yc.ts` or `src/actions/admin.ts`.

- [ ] **Step 4: Manual smoke check**

Run the same inline-script approach as Task 3 Step 4, but this cannot call
`requireAdminUserId()` outside a request context either — defer verifying these actions to
Task 6-9's manual page checks, where they run inside a real authenticated request. Confirm
here only that the file has no syntax/type errors (Step 3 already covers this).

- [ ] **Step 5: Commit**

```bash
git add src/actions/admin-yc.ts src/actions/admin.ts
git commit -m "feat: add YC-mode server actions for mode toggle and manual data entry"
```

---

## Task 5: Toggle, nav, shell, and layout wiring

**Files:**
- Modify: `src/components/admin/admin-nav.ts` (add `ADMIN_YC_NAV`)
- Modify: `src/components/admin/admin-shell.tsx` (accept a mode prop, pick nav, render toggle)
- Create: `src/components/admin/yc-mode-toggle.tsx`
- Modify: `src/app/(admin)/layout.tsx` (read the flag, pass it down)

**Interfaces:**
- Consumes: `setYcModeAction` (Task 4); `userSettings` (Task 1); `ADMIN_NAV`,
  `isAdminNavActive` (existing, `admin-nav.ts`).
- Produces: `ADMIN_YC_NAV: AdminNavItem[]` (exported from `admin-nav.ts`); `AdminShell`
  gains a required `ycMode: boolean` prop; `YCModeToggle({ active }: { active: boolean })`.

- [ ] **Step 1: Add `ADMIN_YC_NAV`**

In `src/components/admin/admin-nav.ts`, add after `ADMIN_NAV` (need four new icons —
`Flame` for Runway, `TrendingUp` is already imported and reused for Revenue, `Scale` for
Unit Economics, `HandCoins` for Fundraising):

```ts
import {
  Activity,
  Flame,
  Gauge,
  HandCoins,
  LayoutTemplate,
  Scale,
  ScrollText,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
```

```ts
/**
 * The YC-mode nav — a full replacement for `ADMIN_NAV`, not an addition to it. Toggling
 * modes changes which of these two arrays `AdminShell` renders.
 */
export const ADMIN_YC_NAV: AdminNavItem[] = [
  { href: "/admin/yc/runway", label: "Runway", icon: Flame },
  { href: "/admin/yc/revenue", label: "Revenue", icon: TrendingUp },
  { href: "/admin/yc/economics", label: "Unit Economics", icon: Scale },
  { href: "/admin/yc/fundraising", label: "Fundraising", icon: HandCoins },
];
```

- [ ] **Step 2: Create `YCModeToggle`**

Create `src/components/admin/yc-mode-toggle.tsx`:

```tsx
"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Rocket } from "lucide-react";
import { setYcModeAction } from "@/actions/admin";
import { cn } from "@/lib/utils";

/**
 * Full mode switch, not a per-item toggle — flipping it swaps which of `ADMIN_NAV` /
 * `ADMIN_YC_NAV` renders, so it has to navigate rather than just refresh in place.
 * Follows `ViewAsUserButton`'s push-to-the-right-route pattern in `surface-toggles.tsx`.
 */
export function YCModeToggle({ active }: { active: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await setYcModeAction({ on: !active });
          router.push(active ? "/admin" : "/admin/yc");
        })
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors duration-fast disabled:opacity-60",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border/70 text-muted-foreground hover:text-foreground"
      )}
    >
      <Rocket className="size-3" aria-hidden />
      {active ? "Exit YC mode" : "YC mode"}
    </button>
  );
}
```

- [ ] **Step 3: Wire the toggle and mode-based nav into `AdminShell`**

In `src/components/admin/admin-shell.tsx`, import `ADMIN_YC_NAV` and `YCModeToggle`, add a
`ycMode: boolean` prop, and pick the nav array. Replace the `nav` block's `ADMIN_NAV.map`
with a `navItems` variable, and add the toggle to the top-right block:

```tsx
import { ADMIN_NAV, ADMIN_YC_NAV, isAdminNavActive } from "@/components/admin/admin-nav";
import { YCModeToggle } from "@/components/admin/yc-mode-toggle";
```

```tsx
export function AdminShell({
  children,
  adminEmail,
  hiddenSurfaceCount = 0,
  ycMode = false,
}: {
  children: React.ReactNode;
  adminEmail?: string | null;
  hiddenSurfaceCount?: number;
  ycMode?: boolean;
}) {
  const pathname = usePathname();
  const navItems = ycMode ? ADMIN_YC_NAV : ADMIN_NAV;
```

Replace `{ADMIN_NAV.map((item) => {` with `{navItems.map((item) => {` in the nav-rendering
block (the `hiddenSurfaceCount` badge condition checking `item.href === "/admin/product"`
stays as-is — it simply never matches while `navItems` is `ADMIN_YC_NAV`, which has no such
href, so nothing extra is needed there).

Add the toggle into the existing top-right block, before the "Open app" link:

```tsx
          <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
            <YCModeToggle active={ycMode} />
            {adminEmail && (
```

- [ ] **Step 4: Read the flag in the layout and pass it down**

In `src/app/(admin)/layout.tsx`:

```tsx
import { AdminShell } from "@/components/admin/admin-shell";
import { requireAdminPage } from "@/lib/admin";
import { getCurrentUserProfile } from "@/lib/auth";
import { getHiddenSurfaceKeys } from "@/lib/surface-visibility";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const adminUserId = await requireAdminPage();
  const db = await getDb();
  const [profile, hidden, settings] = await Promise.all([
    getCurrentUserProfile(),
    getHiddenSurfaceKeys(),
    db.query.userSettings.findFirst({ where: eq(userSettings.userId, adminUserId) }),
  ]);

  return (
    <AdminShell
      adminEmail={profile?.email}
      hiddenSurfaceCount={hidden.size}
      ycMode={settings?.ycModeEnabled ?? false}
    >
      {children}
    </AdminShell>
  );
}
```

Note this changes `requireAdminPage()`'s return value from being discarded to being used —
confirm its return type is the admin's `userId` string (it is, per `src/lib/admin.ts`).

- [ ] **Step 5: Manual verification and commit**

Run the dev server, sign in as the admin user, visit `/admin`. Click the new "YC mode"
button in the header — expect a redirect to `/admin/yc` (a 404 is expected here until Task
6 adds the first page; that's fine, it confirms the toggle persisted and redirected).
Reload `/admin` directly — expect the header to still show "Exit YC mode" and `ADMIN_YC_NAV`
items, confirming the preference persisted server-side. Click "Exit YC mode" — expect a
redirect back to `/admin` with `ADMIN_NAV` restored.

```bash
git add src/components/admin/admin-nav.ts src/components/admin/admin-shell.tsx src/components/admin/yc-mode-toggle.tsx "src/app/(admin)/layout.tsx"
git commit -m "feat: add YC-mode toggle and nav switching to the admin shell"
```

---

## Task 6: Runway page

**Files:**
- Create: `src/app/(admin)/admin/yc/runway/page.tsx`
- Create: `src/components/admin/yc/runway-forms.tsx`

**Interfaces:**
- Consumes: `loadRunwayMetrics` (Task 3); `addStartupExpenseAction`, `setCashSnapshotAction`
  (Task 4); `AdminPageHeader`, `AdminPanel`, `MetricTile`, `AdminTable`, `Th`, `Td`,
  `EmptyState` (existing, `src/components/admin/primitives.tsx`).

- [ ] **Step 1: Write the two quick-add forms**

Create `src/components/admin/yc/runway-forms.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addStartupExpenseAction, setCashSnapshotAction } from "@/actions/admin-yc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LogExpenseForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [category, setCategory] = useState("");
  const [amountUsd, setAmountUsd] = useState("");
  const [note, setNote] = useState("");

  function submit() {
    const amount = Number(amountUsd);
    if (!category.trim() || !Number.isFinite(amount) || amount <= 0) return;
    start(async () => {
      await addStartupExpenseAction({
        category: category.trim(),
        amountUsd: amount,
        incurredAt: new Date().toISOString(),
        note: note.trim() || undefined,
      });
      setCategory("");
      setAmountUsd("");
      setNote("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <Label htmlFor="expense-category">Category</Label>
        <Input
          id="expense-category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Hosting"
          className="w-32"
        />
      </div>
      <div>
        <Label htmlFor="expense-amount">Amount (USD)</Label>
        <Input
          id="expense-amount"
          type="number"
          value={amountUsd}
          onChange={(e) => setAmountUsd(e.target.value)}
          placeholder="49.99"
          className="w-28"
        />
      </div>
      <div>
        <Label htmlFor="expense-note">Note</Label>
        <Input
          id="expense-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="optional"
          className="w-40"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Log expense
      </Button>
    </div>
  );
}

export function UpdateCashForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [balanceUsd, setBalanceUsd] = useState("");

  function submit() {
    const balance = Number(balanceUsd);
    if (!Number.isFinite(balance) || balance < 0) return;
    start(async () => {
      await setCashSnapshotAction({ balanceUsd: balance, asOf: new Date().toISOString() });
      setBalanceUsd("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <Label htmlFor="cash-balance">Current cash on hand (USD)</Label>
        <Input
          id="cash-balance"
          type="number"
          value={balanceUsd}
          onChange={(e) => setBalanceUsd(e.target.value)}
          placeholder="10000"
          className="w-36"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Update cash
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Write the page**

Create `src/app/(admin)/admin/yc/runway/page.tsx`:

```tsx
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  Td,
  Th,
} from "@/components/admin/primitives";
import { LogExpenseForm, UpdateCashForm } from "@/components/admin/yc/runway-forms";
import { loadRunwayMetrics } from "@/lib/admin-yc-metrics";

export const metadata = { title: "Admin · Runway" };

export default async function RunwayPage() {
  const { cashBalanceUsd, monthlyBurnUsd, runwayMonths, recentExpenses } =
    await loadRunwayMetrics();

  return (
    <>
      <AdminPageHeader
        title="Runway"
        subtitle="Cash on hand, burn, and months until it runs out."
      />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricTile label="Cash on hand" value={`$${cashBalanceUsd.toLocaleString()}`} />
          <MetricTile label="Monthly burn" value={`$${monthlyBurnUsd.toLocaleString()}`} hint="trailing 30 days" />
          <MetricTile
            label="Runway"
            value={runwayMonths === null ? "∞" : `${runwayMonths.toFixed(1)} mo`}
            tone={runwayMonths !== null && runwayMonths < 3 ? "danger" : "default"}
          />
        </div>

        <AdminPanel title="Update">
          <div className="space-y-4">
            <UpdateCashForm />
            <LogExpenseForm />
          </div>
        </AdminPanel>

        <AdminPanel title="Recent expenses (30d)">
          {recentExpenses.length === 0 ? (
            <EmptyState>No expenses logged in the last 30 days.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Category</Th>
                  <Th>Note</Th>
                  <Th numeric>Amount</Th>
                </>
              }
            >
              {recentExpenses.map((e) => (
                <tr key={e.id} className="border-b border-border/40 last:border-b-0">
                  <Td>{e.category}</Td>
                  <Td className="text-muted-foreground">{e.note ?? "—"}</Td>
                  <Td numeric>${e.amountUsd.toLocaleString()}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification**

With the dev server running and YC mode on (Task 5), visit `/admin/yc/runway`. Enter a cash
balance of `10000` and submit — expect the "Cash on hand" tile to update to `$10,000` after
`router.refresh()`. Log an expense of `2000` — expect "Monthly burn" to show `$2,000` and
"Runway" to show `5.0 mo`, matching the spec's worked example.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)/admin/yc/runway" src/components/admin/yc/runway-forms.tsx
git commit -m "feat: add YC-mode Runway page"
```

---

## Task 7: Revenue page

**Files:**
- Create: `src/app/(admin)/admin/yc/revenue/page.tsx`

**Interfaces:**
- Consumes: `loadRevenueGrowth` (Task 3); `AdminPageHeader`, `AdminPanel`, `MetricTile`
  (existing).

- [ ] **Step 1: Write the page**

This page has no manual-entry form — it's entirely derived from existing subscription data,
per the spec's decision to lean on data Orbit already tracks for Revenue specifically.

Create `src/app/(admin)/admin/yc/revenue/page.tsx`:

```tsx
import { AdminPageHeader, AdminPanel, MetricTile } from "@/components/admin/primitives";
import { loadRevenueGrowth } from "@/lib/admin-yc-metrics";

export const metadata = { title: "Admin · Revenue" };

export default async function RevenuePage() {
  const { mrrUsd, subscriberGrowthPct, newSubscribers30d, newSubscribersPrior30d } =
    await loadRevenueGrowth();

  return (
    <>
      <AdminPageHeader
        title="Revenue"
        subtitle="MRR and subscriber growth — Orbit's one flat price makes new-subscriber count the honest growth signal, not a claimed dollar MRR delta."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile label="MRR" value={`$${mrrUsd.toLocaleString()}`} />
        <MetricTile
          label="Subscriber growth"
          value={subscriberGrowthPct === null ? "—" : `${subscriberGrowthPct >= 0 ? "+" : ""}${subscriberGrowthPct.toFixed(0)}%`}
          hint="new subscribers, 30d vs. prior 30d"
          tone={subscriberGrowthPct !== null && subscriberGrowthPct < 0 ? "danger" : "default"}
        />
        <MetricTile
          label="New subscribers (30d)"
          value={newSubscribers30d}
          hint={`${newSubscribersPrior30d} in the prior 30 days`}
        />
      </div>
    </>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Visit `/admin/yc/revenue` with YC mode on. Expect MRR to match `/admin/billing`'s MRR figure
exactly (same `MONTHLY_AMOUNT × subscribed count` calculation) — if they diverge, that's a
bug in `loadRevenueGrowth`'s subscriber filter, not an acceptable discrepancy.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(admin)/admin/yc/revenue"
git commit -m "feat: add YC-mode Revenue page"
```

---

## Task 8: Unit Economics page

**Files:**
- Create: `src/app/(admin)/admin/yc/economics/page.tsx`
- Create: `src/components/admin/yc/economics-forms.tsx`

**Interfaces:**
- Consumes: `loadUnitEconomics` (Task 3); `addAcquisitionSpendAction`,
  `setEstimatedChurnAction` (Task 4).

- [ ] **Step 1: Write the two forms**

Create `src/components/admin/yc/economics-forms.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addAcquisitionSpendAction, setEstimatedChurnAction } from "@/actions/admin-yc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LogAcquisitionSpendForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [channel, setChannel] = useState("");
  const [amountUsd, setAmountUsd] = useState("");

  function submit() {
    const amount = Number(amountUsd);
    if (!channel.trim() || !Number.isFinite(amount) || amount <= 0) return;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    start(async () => {
      await addAcquisitionSpendAction({
        channel: channel.trim(),
        amountUsd: amount,
        periodStart: thirtyDaysAgo.toISOString(),
        periodEnd: now.toISOString(),
      });
      setChannel("");
      setAmountUsd("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <Label htmlFor="spend-channel">Channel</Label>
        <Input
          id="spend-channel"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          placeholder="Google Ads"
          className="w-36"
        />
      </div>
      <div>
        <Label htmlFor="spend-amount">Amount (USD, this period)</Label>
        <Input
          id="spend-amount"
          type="number"
          value={amountUsd}
          onChange={(e) => setAmountUsd(e.target.value)}
          placeholder="300"
          className="w-32"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Log spend
      </Button>
    </div>
  );
}

export function EstimatedChurnForm({ currentPct }: { currentPct: number | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pct, setPct] = useState(currentPct?.toString() ?? "");

  function submit() {
    const value = Number(pct);
    if (!Number.isFinite(value) || value < 0) return;
    start(async () => {
      await setEstimatedChurnAction({ monthlyChurnPct: value });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <Label htmlFor="churn-pct">Estimated monthly churn (%)</Label>
        <Input
          id="churn-pct"
          type="number"
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          placeholder="2"
          className="w-24"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Update estimate
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Write the page**

Create `src/app/(admin)/admin/yc/economics/page.tsx`:

```tsx
import { AdminPageHeader, AdminPanel, MetricTile } from "@/components/admin/primitives";
import {
  EstimatedChurnForm,
  LogAcquisitionSpendForm,
} from "@/components/admin/yc/economics-forms";
import { loadUnitEconomics } from "@/lib/admin-yc-metrics";

export const metadata = { title: "Admin · Unit Economics" };

export default async function UnitEconomicsPage() {
  const { cac, ltv, ltvToCac, spend30dUsd, newSubscribers30d, estimatedMonthlyChurnPct } =
    await loadUnitEconomics();

  return (
    <>
      <AdminPageHeader
        title="Unit Economics"
        subtitle="CAC from logged acquisition spend; LTV from a manual churn estimate — Orbit's subscriber count is too small to derive churn reliably from history."
      />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricTile
            label="CAC"
            value={cac === null ? "—" : `$${cac.toFixed(0)}`}
            hint={`$${spend30dUsd.toLocaleString()} / ${newSubscribers30d} new`}
          />
          <MetricTile label="LTV" value={ltv === null ? "—" : `$${ltv.toFixed(0)}`} />
          <MetricTile
            label="LTV : CAC"
            value={ltvToCac === null ? "—" : `${ltvToCac.toFixed(1)}x`}
            tone={ltvToCac !== null && ltvToCac < 3 ? "danger" : "default"}
          />
        </div>

        <AdminPanel title="Update">
          <div className="space-y-4">
            <EstimatedChurnForm currentPct={estimatedMonthlyChurnPct} />
            <LogAcquisitionSpendForm />
          </div>
        </AdminPanel>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Visit `/admin/yc/economics`. Set churn to `2` — expect LTV to show `$250` (ARPU $5 ÷ 2%).
Log $300 of spend — with 0 new subscribers in the last 30 days, expect CAC to show `—`
(undefined, not `$300` or `$0`), matching `computeCac`'s null-on-zero-subscribers behavior.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)/admin/yc/economics" src/components/admin/yc/economics-forms.tsx
git commit -m "feat: add YC-mode Unit Economics page"
```

---

## Task 9: Fundraising page

**Files:**
- Create: `src/app/(admin)/admin/yc/fundraising/page.tsx`
- Create: `src/components/admin/yc/fundraising-forms.tsx`

**Interfaces:**
- Consumes: `loadFundraisingSummary` (Task 3); `createFundraisingRoundAction`,
  `addFundraisingInvestorAction` (Task 4).

- [ ] **Step 1: Write the two forms**

Create `src/components/admin/yc/fundraising-forms.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addFundraisingInvestorAction,
  createFundraisingRoundAction,
} from "@/actions/admin-yc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateRoundForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [targetUsd, setTargetUsd] = useState("");

  function submit() {
    const target = Number(targetUsd);
    if (!name.trim() || !Number.isFinite(target) || target <= 0) return;
    start(async () => {
      await createFundraisingRoundAction({ name: name.trim(), targetUsd: target });
      setName("");
      setTargetUsd("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <Label htmlFor="round-name">Round name</Label>
        <Input
          id="round-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Pre-seed"
          className="w-32"
        />
      </div>
      <div>
        <Label htmlFor="round-target">Target (USD)</Label>
        <Input
          id="round-target"
          type="number"
          value={targetUsd}
          onChange={(e) => setTargetUsd(e.target.value)}
          placeholder="250000"
          className="w-32"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Open round
      </Button>
    </div>
  );
}

export function AddInvestorForm({ roundId }: { roundId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [amountUsd, setAmountUsd] = useState("");

  function submit() {
    const amount = Number(amountUsd);
    if (!name.trim() || !Number.isFinite(amount) || amount <= 0) return;
    start(async () => {
      await addFundraisingInvestorAction({
        roundId,
        name: name.trim(),
        amountUsd: amount,
        committedAt: new Date().toISOString(),
      });
      setName("");
      setAmountUsd("");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <Label htmlFor={`investor-name-${roundId}`}>Investor</Label>
        <Input
          id={`investor-name-${roundId}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Doe"
          className="w-32"
        />
      </div>
      <div>
        <Label htmlFor={`investor-amount-${roundId}`}>Amount (USD)</Label>
        <Input
          id={`investor-amount-${roundId}`}
          type="number"
          value={amountUsd}
          onChange={(e) => setAmountUsd(e.target.value)}
          placeholder="25000"
          className="w-28"
        />
      </div>
      <Button type="button" size="sm" disabled={pending} onClick={submit}>
        Add commitment
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Write the page**

Create `src/app/(admin)/admin/yc/fundraising/page.tsx`:

```tsx
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  Td,
  Th,
} from "@/components/admin/primitives";
import {
  AddInvestorForm,
  CreateRoundForm,
} from "@/components/admin/yc/fundraising-forms";
import { loadFundraisingSummary } from "@/lib/admin-yc-metrics";

export const metadata = { title: "Admin · Fundraising" };

export default async function FundraisingPage() {
  const { rounds } = await loadFundraisingSummary();

  return (
    <>
      <AdminPageHeader title="Fundraising" subtitle="Rounds, targets, and commitments." />

      <div className="space-y-6">
        <AdminPanel title="Open a round">
          <CreateRoundForm />
        </AdminPanel>

        {rounds.length === 0 ? (
          <AdminPanel>
            <EmptyState>No rounds yet — open one above.</EmptyState>
          </AdminPanel>
        ) : (
          rounds.map((round) => (
            <AdminPanel
              key={round.id}
              title={`${round.name} · ${round.status}`}
              action={
                <span className="text-xs text-muted-foreground">
                  ${round.raisedUsd.toLocaleString()} / ${round.targetUsd.toLocaleString()} ({round.progressPct.toFixed(0)}%)
                </span>
              }
            >
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <MetricTile label="Raised" value={`$${round.raisedUsd.toLocaleString()}`} />
                  <MetricTile label="Progress" value={`${round.progressPct.toFixed(0)}%`} />
                </div>

                <AddInvestorForm roundId={round.id} />

                {round.investors.length === 0 ? (
                  <EmptyState>No commitments yet.</EmptyState>
                ) : (
                  <AdminTable
                    head={
                      <>
                        <Th>Investor</Th>
                        <Th numeric>Amount</Th>
                      </>
                    }
                  >
                    {round.investors.map((i) => (
                      <tr key={i.id} className="border-b border-border/40 last:border-b-0">
                        <Td>{i.name}</Td>
                        <Td numeric>${i.amountUsd.toLocaleString()}</Td>
                      </tr>
                    ))}
                  </AdminTable>
                )}
              </div>
            </AdminPanel>
          ))
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Visit `/admin/yc/fundraising`. Open a round named "Pre-seed" with a $100,000 target. Add an
investor commitment of $25,000 — expect "Raised" to show `$25,000` and "Progress" to show
`25%`, matching `computeFundraisingProgress`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)/admin/yc/fundraising" src/components/admin/yc/fundraising-forms.tsx
git commit -m "feat: add YC-mode Fundraising page"
```

---

## Final check (after all tasks)

Run the project's full smoke suite plus type-check and lint to confirm nothing else broke:

```bash
npx tsc --noEmit
npx eslint .
npx tsx scripts/smoke-schema-ddl.ts
npx tsx scripts/smoke-admin-yc-calculations.ts
npx tsx scripts/smoke-admin-gate.ts
npx tsx scripts/smoke-admin-render.ts
```

Expected: all pass. `smoke-admin-render.ts` in particular should now also render the four
new `/admin/yc/*` pages if it iterates the admin route tree — check its contents before
this final pass and add the new routes to its list if it enumerates them explicitly rather
than discovering them.
