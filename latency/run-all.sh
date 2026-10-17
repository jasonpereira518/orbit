#!/usr/bin/env bash
# The whole benchmark, end to end, into latency/results/<label>/.
#
#   bash latency/run-all.sh baseline                # every tier, every bench
#   TIERS="500 5000" BENCHES="ops pages" bash latency/run-all.sh after-fix
#
# Phases per tier (PGlite is single-writer, so in-process benches and the dev server never
# run against the same directory at once):
#   seed        latency/seed.ts into latency/.data/tier-<n>  (skipped when the dir exists;
#               RESEED=1 forces)
#   ops         latency/server-ops.ts   (in-process, statements / depth / cpu)
#   ai          latency/ai.ts           (in-process, mock provider)
#   import      latency/import.ts       (in-process, 20k-row LinkedIn CSV)
#   pages       next dev in demo mode on this tier, then latency/pages.mjs (both profiles)
#   api         latency/api.mjs against the same server
# Once, not per tier:
#   build       next build (ORBIT_BENCH=1) → scripts/dev/bundle-report.mjs, cold-start-report.mjs
#   graph       constellation fixtures + static bench server + latency/constellation.mjs
#
# Needs: node 22+, deps installed, Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH), ports
# 3999 (mock AI), 3417 (static bench) and 3101 (dev server) free.
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL="${1:-run-$(date +%Y%m%d-%H%M%S)}"
OUT="latency/results/$LABEL"
TIERS="${TIERS:-new 500 5000 50000}"
BENCHES="${BENCHES:-build ops ai import pages api graph}"
DEV_PORT="${DEV_PORT:-3101}"
MOCK_PORT="${MOCK_PORT:-3999}"
BENCH_PORT="${BENCH_PORT:-3417}"
mkdir -p "$OUT" latency/.data
export NEXT_TELEMETRY_DISABLED=1
has() { [[ " $BENCHES " == *" $1 "* ]]; }
log() { echo "[$(date +%H:%M:%S)] $*" >&2; }

cleanup() { jobs -p | xargs -r kill 2>/dev/null || true; }
trap cleanup EXIT

wait_for() { # url, seconds
  local i=0; until curl -fsS "$1" >/dev/null 2>&1; do sleep 1; i=$((i+1)); [[ $i -ge $2 ]] && { log "timeout waiting for $1"; return 1; }; done
}

# ---- once: build + bundle/cold-start reports ----
if has build; then
  log "build (ORBIT_BENCH=1)"
  SENTRY_AUTH_TOKEN= ORBIT_BENCH=1 ./node_modules/.bin/next build > "$OUT/build.log" 2>&1
  node scripts/dev/bundle-report.mjs --json "$OUT/bundle-report.json" > "$OUT/bundle-report.txt"
  node scripts/dev/cold-start-report.mjs --runs 3 --json "$OUT/cold-start-report.json" > "$OUT/cold-start-report.txt" 2>&1 || true
fi

# ---- once: mock provider ----
MOCK_AI_PORT=$MOCK_PORT node latency/mock-providers.mjs > "$OUT/mock-ai.log" 2>&1 &
wait_for "http://127.0.0.1:$MOCK_PORT/health" 15
export GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:$MOCK_PORT"
export OPENAI_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1"
export ANTHROPIC_BASE_URL="http://127.0.0.1:$MOCK_PORT"
export GEMINI_API_KEY=mock OPENAI_API_KEY= ANTHROPIC_API_KEY= TYPESAFE_API_KEY=
export DATABASE_URL= NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY= CLERK_SECRET_KEY=
export ORBIT_JEV=off ORBIT_AI_RESULT_CACHE=off

for TIER in $TIERS; do
  DIR="latency/.data/tier-$TIER"
  export ORBIT_PGLITE_DIR="$PWD/$DIR"
  if [[ ! -d "$DIR" || "${RESEED:-0}" == "1" ]]; then
    log "seed tier=$TIER"
    rm -rf "$DIR"
    npx tsx latency/seed.ts --tier "$TIER" > "$OUT/seed-$TIER.log" 2>&1
  fi
  if has ops; then log "ops tier=$TIER"; npx tsx latency/server-ops.ts --tier "$TIER" --out "$OUT/server-ops-$TIER.json" > "$OUT/server-ops-$TIER.log" 2>&1 || log "ops failed (see log)"; fi
  if has ai && [[ "$TIER" != "new" ]]; then log "ai tier=$TIER"; npx tsx latency/ai.ts --tier "$TIER" --out "$OUT/ai-$TIER.json" > "$OUT/ai-$TIER.log" 2>&1 || log "ai failed (see log)"; fi
  if has import && [[ "$TIER" != "new" ]]; then log "import tier=$TIER"; npx tsx latency/import.ts --tier "$TIER" --rows "${IMPORT_ROWS:-20000}" --out "$OUT/import-$TIER.json" > "$OUT/import-$TIER.log" 2>&1 || log "import failed (see log)"; fi

  if has pages || has api; then
    log "dev server tier=$TIER on :$DEV_PORT"
    ORBIT_DEMO_DATA=off EXTENSION_DEV_SECRET=latency EXTENSION_DEV_USER_ID=demo-user \
      ./node_modules/.bin/next dev --port "$DEV_PORT" > "$OUT/dev-$TIER.log" 2>&1 &
    DEV_PID=$!
    wait_for "http://localhost:$DEV_PORT/api/health" 240 || { kill $DEV_PID || true; continue; }
    if has pages; then node latency/pages.mjs --base="http://localhost:$DEV_PORT" --profile=both --rounds="${ROUNDS:-3}" --out="$OUT/pages-$TIER.json" > "$OUT/pages-$TIER.log" 2>&1 || log "pages failed (see log)"; fi
    if has api; then node latency/api.mjs --base="http://localhost:$DEV_PORT" --key-file="latency/.data/tier-$TIER.api-key" --out="$OUT/api-$TIER.json" > "$OUT/api-$TIER.log" 2>&1 || log "api failed (see log)"; fi
    kill $DEV_PID 2>/dev/null || true; wait $DEV_PID 2>/dev/null || true
    # `next dev` rewrites the AGENTS.md block; keep the tree clean (see AGENTS.md).
    git checkout -- AGENTS.md 2>/dev/null || true
  fi
done

# ---- once: constellation ----
if has graph; then
  log "constellation"
  npx tsx scripts/bench/constellation-fixtures.ts "${GRAPH_SIZES:-500,5000,50000}" > "$OUT/constellation-fixtures.log" 2>&1
  node scripts/bench/serve-static-bench.mjs "$BENCH_PORT" > "$OUT/static-bench.log" 2>&1 &
  wait_for "http://localhost:$BENCH_PORT/bench/constellation" 15
  node latency/constellation.mjs --base="http://localhost:$BENCH_PORT" --sizes="${GRAPH_SIZES:-500,5000,50000}" --out="$OUT/constellation.json" > "$OUT/constellation.log" 2>&1 || log "constellation failed (see log)"
fi

node latency/report.mjs "$OUT" > "$OUT/REPORT.md"
log "done: $OUT/REPORT.md"
