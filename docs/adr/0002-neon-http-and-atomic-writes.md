# 2. Neon HTTP driver with runAtomicWrite / runAtomicBatch (no interactive transactions)

Status: Accepted. Recorded retroactively from the code comments cited below; where the code does not say why, the text says "Rationale not recorded".

## Context

`getDb()` returns the `drizzle-orm/neon-http` instance whenever `DATABASE_URL` is set. That driver's session throws `No transactions support in neon-http driver` unconditionally, because Neon's HTTP endpoint has no cross-request session to hold a transaction open. It does offer `db.batch()`, which drizzle maps to one HTTP request that commits or rolls back together. PGlite's drizzle driver has no `batch`, only real transactions (comment above `runAtomicWrite`, `src/db/index.ts`). On neon-http every statement is its own HTTPS round trip.

## Decision

Never call `db.transaction` or `db.batch` directly. Group writes with `runAtomicWrite(db, build)` (or `runAtomicBatch` when the caller needs each statement's result), where `build` receives a writer and returns the statements. On Neon this runs `db.batch()`; on PGlite it runs a real transaction and awaits the statements in order. Read-modify-write sequences that need isolation are expressed as a row lock followed by a conditional write inside one batch (the credit hold is the example in the code).

## Consequences

- Callers write statement-builder callbacks rather than interactive transactions, and cannot branch on an intermediate read inside the group.
- Both drivers must be exercised: the smoke suite runs on PGlite, production runs on Neon HTTP.
- Sequential reads cost round trips, so pages avoid awaiting queries one after another (`ORBIT_SIM_DB_LATENCY_MS` simulates this locally).

## Revisit when

If Orbit moves to a pooled TCP driver (interactive transactions become available) or Neon's HTTP transport gains sessions.
