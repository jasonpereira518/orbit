#!/usr/bin/env bash
# What a production deploy's migration does to live traffic.
#
# Forces the next build's full schema sweep (the same thing any SCHEMA_VERSION bump or DDL
# fingerprint change does) on a LOCAL seeded scratch database while traffic-probe.mjs plays
# app queries against it, then reports the worst latency and errors the "live deployment" saw.
#
#   reliability/tests/migration-under-load.sh orbit_rel [statement_timeout]
#
# Pass a statement_timeout (e.g. 20s, what docs/RUNBOOK.md asks to set on the Neon role) to
# see what the build does when the role carries it — migrations use the same role.
#
# LOCAL ONLY: requires the neon shim on 127.0.0.1:4444 and a database on 127.0.0.1.
set -euo pipefail
DB="${1:-orbit_rel}"
ST="${2:-}"
cd "$(dirname "$0")/../.."
export PGPASSWORD="${PGPASSWORD:-orbit-local-only}"
export NEON_SHIM_URL=http://127.0.0.1:4444/sql
export DATABASE_URL="postgresql://orbit:x@shim.local/${DB}"
PSQL="psql -h 127.0.0.1 -U orbit -d ${DB} -At"
tag="${ST:-none}"

if [ -n "$ST" ]; then $PSQL -c "ALTER ROLE orbit SET statement_timeout = '${ST}'"; fi

# Make the build believe the previous version is recorded, as after any SCHEMA_VERSION bump.
$PSQL -c "UPDATE schema_migrations SET version = version - 1, fingerprint = 'previous-build'"
echo "contacts rows: $($PSQL -c 'select count(*) from contacts')"

node reliability/lib/traffic-probe.mjs "$DB" "reliability/results/migration-under-load-${tag}.probe.json" &
probe=$!
sleep 5

start=$(date +%s.%N)
set +e
npx tsx reliability/lib/with-shim.mts scripts/migrate.ts > "reliability/results/migration-under-load-${tag}.migrate.log" 2>&1
code=$?
set -e
end=$(date +%s.%N)
sleep 5
kill -TERM $probe; wait $probe || true

if [ -n "$ST" ]; then $PSQL -c "ALTER ROLE orbit RESET statement_timeout"; fi

echo "migrate exit=$code wall=$(echo "$end - $start" | bc)s"
grep -E "migrate:|✗" "reliability/results/migration-under-load-${tag}.migrate.log" | head -20
echo "search_tsv present after: $($PSQL -c "select count(*) from information_schema.columns where table_name='contacts' and column_name='search_tsv'")"
echo "contacts_name_trgm present after: $($PSQL -c "select count(*) from pg_indexes where indexname='contacts_name_trgm'")"
echo "contacts_search_gin present after: $($PSQL -c "select count(*) from pg_indexes where indexname='contacts_search_gin'")"
echo "recorded version after: $($PSQL -c 'select version from schema_migrations')"
