# reliability/

Local-only harness used for the reliability audit (`RELIABILITY_AUDIT.md`, `RELIABILITY_PLAN.md`).
Nothing here is imported by the app, and nothing here may be pointed at production: every
entry point refuses a non-local database.

## What it is

`lib/neon-shim.mjs` is a stand-in for Neon's HTTP SQL endpoint, backed by a real local
Postgres, with fault injection. `lib/with-shim.mts` runs any repo script with the app's own
`@neondatabase/serverless` driver pointed at the shim. The app's real `src/db` code (migration
sweep, lease, `runAtomicWrite`, health) can then run, unmodified, against a scratch Postgres +
pgvector database.

| File | What it does |
|---|---|
| `lib/neon-shim.mjs` | Neon HTTP protocol → `pg`. `POST /__fault` switches between `none`, `hang`, `latency`, `http` (status) and `refuse` |
| `lib/with-shim.mts` | Runs a script against the shim. Refuses unless `DATABASE_URL` uses the fake host `shim.local` |
| `lib/traffic-probe.mjs` | Simulated app traffic (search_tsv search, trigram search, contact writes), recording per-second worst latency and errors |
| `seed-bulk.sql` | Fake data: 300 accounts, 600k contacts, 1.8M interactions, 1M usage events, 60k 1536-dim embeddings (about 3.5 GB) |
| `tests/migration-under-load.sh` | Forces the next deploy's schema sweep on the seeded DB under traffic, with an optional role `statement_timeout` |
| `tests/restore-drill.sh` | The `docs/RUNBOOK.md` restore procedure end to end (pg_dump → age → pg_restore), then a row count for every table plus content checksums |
| `tests/db-faults.mts` | App query and `checkHealth` behaviour when the DB is slow, returns 503, drops the connection, or hangs |
| `tests/llm-faults.mts` | Anthropic and OpenAI clients built the way `ai-access.ts` builds them, called with the app's `aiSignal()`, against a local fake provider that hangs, returns 529 or 500, or is slow |
| `tests/claim-race.mts` | Concurrent calls to the real `claimDueConnections`; counts any connection claimed twice |
| `tests/rate-limit-burst.mts` | 300 simultaneous requests through the real `consumeBucket` with a limit of 50 |
| `results/` | Output of the 2026-10-17 run (summarised in `RELIABILITY_AUDIT.md` §5) |

## Run it

Prerequisites: Postgres 16 with pgvector on 127.0.0.1, Node 24 (the root lockfile needs npm 11), `age`.

```bash
# once
sudo -u postgres psql -c "CREATE ROLE orbit LOGIN SUPERUSER PASSWORD 'orbit-local-only';"
sudo -u postgres createdb -O orbit orbit_rel
(cd reliability && npm install)
export PGPASSWORD=orbit-local-only
(cd reliability && SHIM_PORT=4444 SHIM_PGPASSWORD=$PGPASSWORD node lib/neon-shim.mjs &)

export NEON_SHIM_URL=http://127.0.0.1:4444/sql
export DATABASE_URL=postgresql://orbit:x@shim.local/orbit_rel
npx tsx reliability/lib/with-shim.mts scripts/migrate.ts          # real migration
psql -h 127.0.0.1 -U orbit -d orbit_rel -f reliability/seed-bulk.sql   # ~20 min

reliability/tests/migration-under-load.sh orbit_rel        # no statement_timeout
reliability/tests/migration-under-load.sh orbit_rel 20s    # the runbook's recommended setting
reliability/tests/restore-drill.sh orbit_rel
npx tsx reliability/lib/with-shim.mts reliability/tests/db-faults.mts
npx tsx reliability/lib/with-shim.mts reliability/tests/claim-race.mts
npx tsx reliability/lib/with-shim.mts reliability/tests/rate-limit-burst.mts
npx tsx reliability/tests/llm-faults.mts
```

After the `20s` run, the scratch database is left without `contacts.search_tsv`; that is the
finding. To repair it, `ALTER ROLE orbit RESET statement_timeout`, **restart the shim** (pooled
sessions keep the old setting), and run the migration again.

## Limits

- The shim is not Neon. It has no proxy-side timeouts, no compute suspend/resume and no network
  latency. Absolute timings are from one local machine with a fast disk; on Neon's smaller
  computes, rewrites and restores will be slower, so a statement timeout is hit at a smaller
  table size.
- The private ops repository's `backup.yml` was not available, so the restore drill rehearses
  the documented procedure, not the real artifact.
