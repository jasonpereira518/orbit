#!/usr/bin/env bash
# Start a PRODUCTION build (`next start`) in demo mode on a throwaway copy of a seeded
# PGlite snapshot, for the page/interaction benchmarks.
#
#   scripts/dev/perf/serve-demo.sh <snapshot-dir> <port> [db-latency-ms] [workdir]
#
# Needs the two measurement-only edits described in README.md (ORBIT_MEASURE), applied
# before `next build`. They are never committed. Prints the server's pid and run directory.
set -euo pipefail
SNAP="$1"; PORT="$2"; LAT="${3:-20}"; WORK="${4:-$PWD}"
RUN="$(mktemp -d)"
cp -R "$SNAP" "$RUN/pglite"
cd "$WORK"
env -i PATH="$PATH" HOME="$HOME" \
  NODE_ENV=production ORBIT_MEASURE=1 ORBIT_DEMO_DATA=off NEXT_TELEMETRY_DISABLED=1 \
  DATABASE_URL= NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY= CLERK_SECRET_KEY= \
  ORBIT_PGLITE_DIR="$RUN/pglite" ORBIT_SIM_DB_LATENCY_MS="$LAT" \
  nohup ./node_modules/.bin/next start --port "$PORT" > "$RUN/server.log" 2>&1 &
echo "pid=$! run=$RUN port=$PORT"
