# YC Startup console mode: a per-admin toggle with new startup-tracking sections

**Date:** 2026-08-29
**Status:** Approved design, not yet implemented

## Problem / motivation

Orbit's admin console (`src/app/(admin)/admin/*`) is built entirely around operating
the product — user roster, health, feature-surface toggles, growth/billing telemetry,
audit log. None of it tracks Orbit as a business: there's no cash balance, burn,
CAC/LTV, or fundraising state anywhere in the schema. The goal is to actually track
Orbit like a fundable startup, in a dedicated "YC mode" reachable via a toggle in the
admin header, without disturbing the existing operational sections.

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Scope | New sections: Runway, Revenue, Unit Economics, Fundraising | Real tracking, not a cosmetic reskin |
| Nav behavior | Full nav replacement — YC mode swaps `ADMIN_NAV` for a new `ADMIN_YC_NAV` | Chosen over "add alongside" to keep each mode's nav uncluttered |
| Persistence | Per-admin preference, boolean column on `userSettings` | Mirrors the existing `theme` column exactly; chosen over a global setting |
| Data entry | Manual forms within each YC page | Orbit has no bank/accounting/ad-spend integration; automating that is out of scope |
| Excluded from v1 | North Star metric & cohort retention | Not selected; existing Growth page already covers adoption/retention at a coarse level |

## Toggle: `YCModeToggle`

Follows the `ViewAsUserButton` pattern (`src/components/admin/surface-toggles.tsx:134-160`)
rather than the simpler `ThemeToggle` pattern (`src/components/theme-toggle.tsx`),
because switching modes has to navigate — mode governs which nav array and which route
tree render, not just a restyle in place:

- Client component, `useTransition`.
- On click: persist via a new server action `setYcModeAction({ on: boolean })` (same
  shape as `setViewAsUserAction`), writing to a new `ycModeEnabled` boolean column on
  `userSettings` via `onConflictDoUpdate` — the same upsert `saveThemePreference` already
  uses for `theme`.
- On success: `router.push("/admin/yc")` when turning on, `router.push("/admin")` when
  turning off, so the operator lands on the route that matches the new nav immediately,
  rather than `router.refresh()` leaving them on a now-mismatched page.
- Rendered in `AdminShell`'s existing top-right block (`admin-shell.tsx:97-110`, the
  `ml-auto flex items-center gap-4` div that currently holds the admin email and the
  "Open app" link).
- Mode is read server-side in `(admin)/layout.tsx` (alongside the existing
  `requireAdminPage()` call) from `userSettings.ycModeEnabled`, so the correct nav
  renders with no client flash — no mount-guard needed since this picks a nav array
  server-side, unlike theme's client-only CSS variable.

## Nav & routing

New route group `src/app/(admin)/admin/yc/*`, sibling to the existing admin pages, each
page behind the same `requireAdminPage()` gate (re-asserted per Server Action, since
layouts don't re-run on POST — matching the existing convention in `src/lib/admin.ts`).
New `ADMIN_YC_NAV` array, kept next to `ADMIN_NAV` in `admin-nav.ts`, with four items:

- `/admin/yc/runway` — Runway
- `/admin/yc/revenue` — Revenue
- `/admin/yc/economics` — Unit Economics
- `/admin/yc/fundraising` — Fundraising

`AdminShell` renders `ADMIN_NAV` or `ADMIN_YC_NAV` based on the mode flag passed down
from the layout.

## Data model

Four new tables, following the `appSurfaceFlags` convention (plain `pgTable`, explicit
columns, no relations magic) — added to `src/db/schema.ts` and to the `DDL` template in
`src/db/index.ts`, plus the required `SCHEMA_VERSION` bump (currently 12 → 13). Per the
doc comment at `src/db/index.ts:601-614`, skipping that bump means the new DDL never
runs on already-migrated databases.

```ts
export const startupExpenses = pgTable("startup_expenses", {
  id: uuid("id").defaultRandom().primaryKey(),
  category: text("category").notNull(),
  amountUsd: real("amount_usd").notNull(),
  incurredAt: timestamp("incurred_at", { withTimezone: true }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const cashSnapshots = pgTable("cash_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  balanceUsd: real("balance_usd").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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
  name: text("name").notNull(), // "Pre-seed", "Seed", etc.
  targetUsd: real("target_usd").notNull(),
  status: text("status").$type<"open" | "closed">().notNull().default("open"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const fundraisingInvestors = pgTable("fundraising_investors", {
  id: uuid("id").defaultRandom().primaryKey(),
  roundId: uuid("round_id").notNull().references(() => fundraisingRounds.id),
  name: text("name").notNull(),
  amountUsd: real("amount_usd").notNull(),
  committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
  note: text("note"),
});
```

Money is stored as plain-dollar `real` columns (`amountUsd`, `balanceUsd`, `targetUsd`), not
integer cents — confirmed against the codebase's actual convention (`MONTHLY_AMOUNT = 5` in
`plan-copy.ts`, `priceUsd` in `lifetime-offer.ts`; nothing in Orbit scales money by 100).
Matching that convention keeps Revenue's numbers consistent with the rest of the console
instead of introducing a second, incompatible money representation.

Two column additions, alongside `theme` on `userSettings`:

```ts
ycModeEnabled: boolean("yc_mode_enabled").default(false),
// Orbit has no real churn data at this scale (a handful of subscribers) to derive this
// reliably, so it's a manual estimate feeding the LTV calculation on Unit Economics —
// same "manual input, real math" posture as the expense/spend forms.
estimatedMonthlyChurnPct: real("estimated_monthly_churn_pct"),
```

## Section content

- **Runway** (`/admin/yc/runway`) — latest `cashSnapshots` balance, trailing-30-day sum
  from `startupExpenses` as monthly burn, `runway = balance / burn`. A form to log a new
  expense or record a cash snapshot. Burn trend as a sparkline over recent months.
- **Revenue** (`/admin/yc/revenue`) — MRR (subscribed count × `MONTHLY_AMOUNT`, the same
  calculation `/admin/billing` already shows) as the headline. Growth is a new-subscriber
  count comparison (trailing 30 days vs. the 30 before, via the existing `windowCount`
  helper) rather than a claimed dollar MRR delta — Orbit has one flat price and no historical
  MRR series stored anywhere, so subscriber growth is the honest proxy for revenue growth at
  this stage. No new table — built entirely on data Orbit already tracks.
- **Unit Economics** (`/admin/yc/economics`) — CAC = sum(`acquisitionSpend` for the trailing
  30 days) ÷ new active subscribers signed up in that window (existing user rows). LTV =
  ARPU (`MONTHLY_AMOUNT`, Orbit's flat $5/mo price) ÷ `userSettings.estimatedMonthlyChurnPct`
  — a manual estimate, since Orbit's subscriber count is too small to derive a reliable
  churn rate from cancellation history. LTV:CAC ratio as the headline number. A form to log
  acquisition spend by channel, and a small input to update the churn estimate.
- **Fundraising** (`/admin/yc/fundraising`) — round list with target vs. raised (sum of
  `fundraisingInvestors.amountCents` per round), forms to open a round and add an
  investor commitment.

## Styling

Reuses the existing admin visual primitives (`AdminPageHeader`, `AdminPanel`, `MetricTile`,
`TrendBars` in `src/components/admin/primitives.tsx`) with YC vocabulary in the copy —
consistent with the codebase's own stated posture of not adding new UI abstractions for a
single call site. No changes to shared admin chrome beyond the nav swap and the toggle
itself — Users, Health, Product, and Audit are untouched and remain reachable by toggling
back off.

## Testing

- The project's existing `scripts/smoke-schema-ddl.ts` guard (already run via `npm run
  db:check`) verifies DDL/schema/version consistency generically — it needs no new code,
  only a lock-file regenerate (`--update`) once the new DDL lands.
- Each pure calculation (runway, subscriber-growth, unit economics, fundraising progress)
  gets a `scripts/smoke-*.ts` script in the project's existing no-framework convention
  (plain `check(label, condition)` assertions, `main(); process.exit(0);` — see
  `scripts/smoke-lifetime-pricing.ts`), run against fixed inputs, no database required.
- Manual verification: toggle on/off persists across reload, nav swaps correctly, and each
  page renders real numbers after using its form to enter fixture data (e.g. a $10,000 cash
  snapshot plus a $2,000 expense should show a 5-month runway).

## Out of scope

- Automated bank, accounting, or ad-spend integrations — all entry is manual.
- North Star metric and cohort retention curves.
- A global (all-admins-affected) mode — this is strictly per-admin.
