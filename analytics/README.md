# analytics/

Drafts that accompany `ANALYTICS_AUDIT.md`, `TRACKING_PLAN.md` and `ANALYTICS_PLAN.md`.
Nothing in this directory is imported by the application. Nothing here reads production data.

| path | what it is |
|---|---|
| `checks/probe-known-distortions.ts` | Seeds fake rows into a throwaway local PGlite database and reports which audit findings reproduce. Run: `npx tsx analytics/checks/probe-known-distortions.ts` |
| `checks/reconciliation.sql` | Draft drift checks (ledger vs live MRR, funnel "paid" vs ledger, waitlist vs accounts, signed-in viewers vs accounts). Each returns rows only when something is wrong. |
| `schema/events.ts` | Draft zod schemas for the proposed `product_events` taxonomy and the `track()` helper's type. Property schemas admit ids, enums, numbers and booleans only. |
| `events/README.md` | The event ownership document: one section per event, kept in step with `schema/events.ts`. |

Rules the drafts follow: the smoke preamble (`scripts/smoke/_env.ts`) is imported first so `DATABASE_URL` is removed; `ANALYTICS_SALT` is set to a placeholder; no secrets are printed.
