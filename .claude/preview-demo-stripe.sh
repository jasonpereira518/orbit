#!/usr/bin/env bash
# The demo-mode preview (see preview-demo.sh) plus Stripe TEST mode, for walking through
# checkout, packs and plan switches locally. The test key is read from the main checkout's
# .env.local at start and never written anywhere; the script refuses anything but sk_test_.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY="$(grep -E '^STRIPE_SECRET_KEY=' "${ORBIT_MAIN_ENV:-$HOME/Projects/orbit/.env.local}" | head -1 | cut -d= -f2-)"
case "$KEY" in
  sk_test_*) export STRIPE_SECRET_KEY="$KEY" ;;
  *) echo "preview-demo-stripe: need an sk_test_ key" >&2; exit 1 ;;
esac
# Webhooks: `stripe listen --forward-to localhost:3001/api/webhooks/stripe` signs with its
# own secret, which the CLI prints on request. Without the CLI, verify-on-return still works.
if command -v stripe >/dev/null 2>&1; then
  STRIPE_WEBHOOK_SECRET="$(stripe listen --print-secret 2>/dev/null || true)"
  export STRIPE_WEBHOOK_SECRET
fi
export DATABASE_URL=""
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=""
export CLERK_SECRET_KEY=""
export NODE_ENV="development"
exec ./node_modules/.bin/next dev --port "${PORT:-3001}"
