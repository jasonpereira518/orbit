# 3. PGlite for local development and tests; demo mode without Clerk

Status: Accepted. Recorded retroactively from the code comments cited below; where the code does not say why, the text says "Rationale not recorded".

## Context

With `DATABASE_URL` unset, `getDb()` opens an on-disk PGlite database in `.data/pglite` (`ORBIT_PGLITE_DIR` overrides it). `docs/DEVELOPMENT.md` describes the resulting local modes. `src/lib/demo-account.ts` defines demo mode as no Clerk publishable key plus `NODE_ENV=development`, and states that a Clerk-less deployment that is not `next dev` gets no exemption, because that would put every anonymous visitor on the shared `demo-user` with paid access. PGlite is single-writer and is built with `pg_trgm` but without pgvector (comment in `src/db/index.ts`).

## Decision

Local development and the whole smoke suite run on PGlite. A fresh clone needs no database and no Clerk keys: `next dev` signs every request in as `demo-user`, lifts plan gates on localhost and seeds a demo workspace (`ORBIT_DEMO_DATA=off` starts empty). Smoke scripts load `scripts/smoke/_env.ts`, which deletes `DATABASE_URL` and provider keys unless explicitly allowed. Demo status never applies on a deployment, apart from the opt-in showcase account (`DEMO_ACCOUNT_USER_ID`, forbidden in production by `src/lib/env.ts`).

## Consequences

- Zero-setup onboarding and hermetic tests.
- Local behaviour differs from production: no pgvector (a JS fallback is used), a single writer per directory, no HTTP round trips.
- A `.env.local` that points `DATABASE_URL` at a remote database makes `db:migrate` and every `scripts/backfill-*` write to it; only the smoke harness is fenced.

## Revisit when

If PGlite's divergence from Neon hides production bugs, or when a pgvector build is available for the installed PGlite.
