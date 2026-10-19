# 1. Hand-written idempotent DDL and SCHEMA_VERSION instead of drizzle-kit migrations

Status: Accepted. Recorded retroactively from the code comments cited below; where the code does not say why, the text says "Rationale not recorded".

## Context

`src/db/schema.ts` is a Drizzle model, but the database is not built from it. Orbit keeps one set of hand-written, idempotent SQL in `src/db/index.ts`: the `DDL` template, `SCALE_DDL`, the Neon `alters` list, `ADMIN_V2_STATEMENTS` and the PGlite `ensureColumn` calls. Some objects are not representable in `schema.ts` at all: `contact_embeddings.embedding_vector` and its HNSW index are created at runtime by `migratePgvector`. `drizzle-kit push` would drop them (`src/lib/env.ts`, `checkDrizzleCommand`). The comment above `SCHEMA_VERSION` records that `getDb()` once replayed ~165 statements on every serverless cold start, and that DDL which lands without a version bump never runs on an already-migrated instance (#41 shipped six `user_settings` columns that way and `/dashboard` 500'd).

## Decision

All schema changes are hand-written SQL in `src/db/index.ts`, applied by `reconcileSchema()` (`npm run db:migrate` in the Vercel build, and lazily at runtime). A one-row `schema_migrations` table records the version and a DDL fingerprint; when it already equals `SCHEMA_VERSION` the whole sweep is skipped. A `schema_migration_lock` lease keeps concurrent builds from sweeping together. `drizzle-kit push/migrate/drop` are refused unless `ALLOW_DRIZZLE_PUSH=1` and the target is not `PRODUCTION_DB_HOST`. `db:generate` output is reference only; the app never applies it.

## Consequences

- A schema change touches up to four places (`schema.ts`, `DDL`, `alters`, `ensureColumn`) and must bump `SCHEMA_VERSION`. `scripts/smoke-schema-ddl.ts` (`npm run db:check`) guards column coverage, unique-index parity and the version bump, using `scripts/schema-ddl.lock.json`.
- The fingerprint does not hash `ensureColumn` calls or `migratePgvector`, so a bump there relies on discipline.
- Drops are real and not rollback-safe (see ADR 0009).
- Cold starts pay one `SELECT` instead of the whole sweep.

## Revisit when

When the four-place duplication causes repeated drift, or when a migration tool can express the pgvector and generated-column objects and run safely against Neon HTTP. (Audit finding A2 and plan P9 propose single-sourcing the DDL.)
