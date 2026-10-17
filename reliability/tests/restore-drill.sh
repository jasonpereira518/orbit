#!/usr/bin/env bash
# Restore drill, rehearsed locally against FAKE data. It follows docs/RUNBOOK.md →
# "Restore the database" step for step:
#   pg_dump -Fc  →  age encrypt  →  age decrypt  →  pg_restore --clean --if-exists
#   --no-owner --no-privileges into a NEW database
# then compares exact row counts for every table, checks extensions, indexes, constraints
# and the schema version, and runs the app's migration against the restored copy.
#
#   reliability/tests/restore-drill.sh orbit_rel
#
# It does not test the private ops repository's backup.yml (not visible from here) and
# it is not a production drill. Production drill: docs in RELIABILITY_PLAN.md (P1.3).
set -euo pipefail
SRC="${1:-orbit_rel}"
DST="${SRC}_restored"
cd "$(dirname "$0")/../.."
export PGPASSWORD="${PGPASSWORD:-orbit-local-only}"
R=reliability/results
H="-h 127.0.0.1 -U orbit"
ts() { date +%s.%N; }
el() { echo "$(echo "$2 - $1" | bc | xargs printf '%.1f')"; }

age-keygen -o "$R/drill.key" 2>/dev/null
PUB=$(grep -o 'age1[0-9a-z]*' "$R/drill.key" | head -1)

t0=$(ts)
pg_dump $H -Fc -d "$SRC" -f "$R/drill.dump"
t1=$(ts)
age -r "$PUB" -o "$R/drill.dump.age" "$R/drill.dump"
rm "$R/drill.dump"
t2=$(ts)
age -d -i "$R/drill.key" -o "$R/drill.dump" "$R/drill.dump.age"
t3=$(ts)
dropdb $H --if-exists "$DST"
createdb $H "$DST"
pg_restore $H --clean --if-exists --no-owner --no-privileges -d "$DST" "$R/drill.dump" 2> "$R/restore-drill.pg_restore.log" || true
t4=$(ts)

echo "dump=$(el $t0 $t1)s encrypt=$(el $t1 $t2)s decrypt=$(el $t2 $t3)s restore=$(el $t3 $t4)s"
echo "db size: $(psql $H -d "$SRC" -At -c "select pg_size_pretty(pg_database_size('$SRC'))"), dump size (encrypted): $(du -h "$R/drill.dump.age" | cut -f1)"
echo "pg_restore stderr lines: $(wc -l < "$R/restore-drill.pg_restore.log")"

count_all() {
  psql $H -d "$1" -At -c "
    select string_agg(format('%s=%s', table_name,
      (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text), ' ' order by table_name)
    from information_schema.tables where table_schema='public' and table_type='BASE TABLE'" | tr ' ' '\n'
}
count_all "$SRC" > "$R/drill.src.counts"
count_all "$DST" > "$R/drill.dst.counts"
if diff -q "$R/drill.src.counts" "$R/drill.dst.counts" >/dev/null; then
  echo "row counts: ALL $(wc -l < "$R/drill.src.counts") tables match"
else
  echo "row counts: MISMATCH"; diff "$R/drill.src.counts" "$R/drill.dst.counts" | head
fi
for q in "select count(*) from pg_indexes where schemaname='public'" \
         "select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where nspname='public'" \
         "select string_agg(extname, ',' order by extname) from pg_extension" \
         "select version from schema_migrations"; do
  a=$(psql $H -d "$SRC" -At -c "$q"); b=$(psql $H -d "$DST" -At -c "$q")
  [ "$a" = "$b" ] && echo "match: $q -> $a" || echo "DIFF:  $q -> src=$a dst=$b"
done
# Spot-check content, not only counts.
for q in "select md5(string_agg(id::text||full_name||coalesce(email,''), ',' order by id)) from contacts" \
         "select md5(string_agg(id::text||coalesce(embedding_vector::text,''), ',' order by id)) from contact_embeddings"; do
  a=$(psql $H -d "$SRC" -At -c "$q"); b=$(psql $H -d "$DST" -At -c "$q")
  [ "$a" = "$b" ] && echo "content match: ${q:0:60}…" || echo "CONTENT DIFF: ${q:0:60}…"
done
rm -f "$R/drill.dump" "$R/drill.dump.age" "$R/drill.key" "$R/drill.src.counts" "$R/drill.dst.counts"
