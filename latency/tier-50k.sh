#!/usr/bin/env bash
# The 50,000-contact tier, into latency/results/<label>/ (default baseline): seed, ops, ai,
# import (20k rows), pages, api.
#
#   bash latency/tier-50k.sh [label]
#
# Separate from run-all.sh because two things must be skipped at this size on PGlite:
# - `contacts duplicates count` (DB-16 in LATENCY_PLAN.md): a nested-loop self-join that is
#   O(n²) — 30 s at 5,000, ~50 min at 50,000 — and PGlite runs statements one at a time, so a
#   single /contacts request would freeze every other request for the rest of the run.
#   So: the op is skipped in server-ops, and /contacts (which streams that count) and the
#   sidebar tour (which clicks it) are skipped in pages/api. Everything else runs as usual.
set -uo pipefail
cd "$(dirname "$0")/.."
LABEL="${1:-baseline}"
OUT="latency/results/$LABEL"
mkdir -p "$OUT"
export NEXT_TELEMETRY_DISABLED=1 GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3999 OPENAI_BASE_URL=http://127.0.0.1:3999/v1 ANTHROPIC_BASE_URL=http://127.0.0.1:3999
export GEMINI_API_KEY=mock OPENAI_API_KEY= ANTHROPIC_API_KEY= TYPESAFE_API_KEY= DATABASE_URL= NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY= CLERK_SECRET_KEY= ORBIT_JEV=off ORBIT_AI_RESULT_CACHE=off
export ORBIT_PGLITE_DIR="$PWD/latency/.data/tier-50000"
log() { echo "[$(date +%H:%M:%S)] $*"; }
wait_for() { local i=0; until curl -fsS "$1" >/dev/null 2>&1; do sleep 1; i=$((i+1)); if [[ $i -ge $2 ]]; then log "timeout waiting for $1"; return 1; fi; done; return 0; }
MOCK_AI_PORT=3999 node latency/mock-providers.mjs >> "$OUT/mock-ai.log" 2>&1 & MOCK=$!
wait_for http://127.0.0.1:3999/health 15

if [[ ! -d latency/.data/tier-50000 || "${RESEED:-0}" == "1" ]]; then
  log "seed tier=50000"; rm -rf latency/.data/tier-50000
  npx tsx latency/seed.ts --tier 50000 > "$OUT/seed-50000.log" 2>&1 || log "seed 50000 failed"
  { free -m; du -sh latency/.data/tier-50000; } > "$OUT/free-after-seed-50000.txt" 2>&1
fi
log "ops tier=50000";    npx tsx latency/server-ops.ts --tier 50000 --skip duplicates --out "$OUT/server-ops-50000.json" > "$OUT/server-ops-50000.log" 2>&1 || log "ops 50000 failed"
log "ai tier=50000";     npx tsx latency/ai.ts --tier 50000 --out "$OUT/ai-50000.json" > "$OUT/ai-50000.log" 2>&1 || log "ai 50000 failed"
log "import tier=50000"; npx tsx latency/import.ts --tier 50000 --rows "${IMPORT_ROWS:-20000}" --out "$OUT/import-50000.json" > "$OUT/import-50000.log" 2>&1 || log "import 50000 failed"
log "dev server tier=50000"
ORBIT_DEMO_DATA=off EXTENSION_DEV_SECRET=latency EXTENSION_DEV_USER_ID=demo-user ./node_modules/.bin/next dev --port 3101 > "$OUT/dev-50000.log" 2>&1 & DEV=$!
if wait_for http://localhost:3101/api/health 300; then
  node latency/pages.mjs --base=http://localhost:3101 --profile=both --rounds="${ROUNDS:-3}" --skip=/contacts,nav --out="$OUT/pages-50000.json" > "$OUT/pages-50000.log" 2>&1 || log "pages 50000 failed"
  node latency/api.mjs --base=http://localhost:3101 --key-file=latency/.data/tier-50000.api-key --skip="doc /contacts,doc /contacts?q=hopper" --out="$OUT/api-50000.json" > "$OUT/api-50000.log" 2>&1 || log "api 50000 failed"
else log "dev server 50000 never healthy"; fi
kill $DEV 2>/dev/null; wait $DEV 2>/dev/null; git checkout -- AGENTS.md 2>/dev/null
kill $MOCK 2>/dev/null
node latency/report.mjs "$OUT" > "$OUT/REPORT.md"
log "tier-50k done"
