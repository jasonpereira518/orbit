# Architecture decision records

Short records of choices that are not obvious from the code. Each has Context, Decision, Consequences and
Revisit when. They were collected from comments in the code in one pass; where a comment does not give the
reason, the record says "Rationale not recorded; inferred: ...". Add a new record when you make a decision a
newcomer would otherwise have to reverse-engineer, number it next, and add it here.

| # | Decision |
|---|---|
| 0001 | [Hand-written idempotent DDL and SCHEMA_VERSION instead of drizzle-kit migrations](0001-hand-written-ddl.md) |
| 0002 | [Neon HTTP driver with runAtomicWrite / runAtomicBatch (no interactive transactions)](0002-neon-http-and-atomic-writes.md) |
| 0003 | [PGlite for local development and tests; demo mode without Clerk](0003-pglite-and-demo-mode.md) |
| 0004 | [Tenancy by user_id column, without foreign keys or row-level security](0004-tenancy-by-user-id-column.md) |
| 0005 | [GitHub Actions as the scheduler, with after() self-continuation, leases and time budgets](0005-github-actions-scheduler.md) |
| 0006 | [Server actions for app mutations; route handlers only for what an action cannot do](0006-server-actions-vs-route-handlers.md) |
| 0007 | [BYOK and managed AI keys, credits, and the Jev decision chain](0007-ai-keys-credits-and-decision-chain.md) |
| 0008 | [Custom smoke harness instead of a test framework](0008-custom-smoke-harness.md) |
| 0009 | [Migrations run in the Vercel build, before next build](0009-migrate-in-the-vercel-build.md) |
| 0010 | [Stripe apiVersion left to the SDK](0010-stripe-api-version-unpinned.md) |
| 0011 | [Backups run from a private repository](0011-backups-in-a-private-repo.md) |
| 0012 | [Stealth host and app_surface_flags for gating unreleased surfaces](0012-stealth-and-surface-flags.md) |

See also [ARCHITECTURE.md](../ARCHITECTURE.md).
