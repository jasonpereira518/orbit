#!/usr/bin/env bash
# Demo-mode dev server for visual checks in this worktree.
#
# Runs against the local PGlite store as `demo-user` with no Clerk session, so a preview
# never reaches the shared Neon database or needs a real sign-in. `NEXT_PUBLIC_*` vars are
# inlined at build time from the environment, and a real env var beats a .env.local entry,
# so clearing the Clerk key here is what puts the app in demo mode.
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL=""
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=""
export CLERK_SECRET_KEY=""
export NODE_ENV="development"
# The local binary, exec'd — not `npx`. npx forks a child `next-server`, so stopping the
# preview kills the wrapper and orphans the server, which then blocks the next start.
exec ./node_modules/.bin/next dev --port "${PORT:-3001}"
