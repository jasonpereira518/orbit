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
  amountCents: integer("amount_cents").notNull(),
  incurredAt: timestamp("incurred_at", { withTimezone: true }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const cashSnapshots = pgTable("cash_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  balanceCents: integer("balance_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const acquisitionSpend = pgTable("acquisition_spend", {
  id: uuid("id").defaultRandom().primaryKey(),
  channel: text("channel").notNull(),
  amountCents: integer("amount_cents").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const fundraisingRounds = pgTable("fundraising_rounds", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(), // "Pre-seed", "Seed", etc.
  targetCents: integer("target_cents").notNull(),
  status: text("status").$type<"open" | "closed">().notNull().default("open"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const fundraisingInvestors = pgTable("fundraising_investors", {
  id: uuid("id").defaultRandom().primaryKey(),
  roundId: uuid("round_id").notNull().references(() => fundraisingRounds.id),
  name: text("name").notNull(),
  amountCents: integer("amount_cents").notNull(),
  committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
  note: text("note"),
});
```

Money is stored as integer cents to avoid float rounding. The implementation plan should
confirm this matches whatever convention `admin-metrics.ts` / `ai-pricing.ts` already use
for billing amounts, so Revenue's numbers are computed consistently with the rest.

One column addition, alongside `theme` on `userSettings`:

```ts
ycModeEnabled: boolean("yc_mode_enabled").default(false),
```

## Section content

- **Runway** (`/admin/yc/runway`) — latest `cashSnapshots` balance, trailing-30-day sum
  from `startupExpenses` as monthly burn, `runway = balance / burn`. A form to log a new
  expense or record a cash snapshot. Burn trend as a sparkline over recent months.
- **Revenue** (`/admin/yc/revenue`) — MRR/ARR and MoM growth %, computed from existing
  billing/subscription data. No new table — this is the one section built on data Orbit
  already tracks, per the decision to lean new tracking elsewhere.
- **Unit Economics** (`/admin/yc/economics`) — CAC = sum(`acquisitionSpend` for a period)
  ÷ new users in that period (existing user-creation data); LTV = ARPU ÷ churn rate
  (existing revenue + retention data); LTV:CAC ratio as the headline number. A form to
  log acquisition spend by channel.
- **Fundraising** (`/admin/yc/fundraising`) — round list with target vs. raised (sum of
  `fundraisingInvestors.amountCents` per round), forms to open a round and add an
  investor commitment.

## Styling

Deck-style presentation (large hero numbers, trend sparklines, YC vocabulary) scoped
entirely to `/admin/yc/*` components. No changes to shared admin chrome beyond the nav
swap and the toggle itself — Users, Health, Product, and Audit are untouched and remain
reachable by toggling back off.

## Testing

- A DDL smoke test (matching the project's existing schema-DDL smoke-test pattern) to
  verify the four new tables and the `userSettings` column create cleanly against a
  fresh PGlite instance.
- Manual verification: toggle on/off persists across reload, nav swaps correctly, and
  each page's calculation is checked against manually-entered fixture data (e.g. a
  $10,000 cash snapshot plus a $2,000 expense should show a 5-month runway).

## Out of scope

- Automated bank, accounting, or ad-spend integrations — all entry is manual.
- North Star metric and cohort retention curves.
- A global (all-admins-affected) mode — this is strictly per-admin.
