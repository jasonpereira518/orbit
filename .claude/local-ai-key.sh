# Sourced by the demo-mode preview launchers (preview-demo.sh, preview-demo-stripe.sh).
#
# A worktree has no .env.local on purpose: that file carries the Neon DATABASE_URL and the
# Clerk keys, and a preview must not reach either. But with no .env.local the server also has
# no AI key, so the demo account showed "Add an AI API key" and nothing AI could run.
#
# This hands the preview the developer's Anthropic key, and ONLY that key, read from the main
# checkout's .env.local (override the file with ORBIT_MAIN_ENV). The gate (src/lib/ai-access.ts)
# already treats a localhost demo account as running on the dev server's own keys, and
# Anthropic comes first in MANAGED_PROVIDER_ORDER, so exporting it is all that is needed.
#
# - The file is never sourced: that would pull DATABASE_URL and the Clerk keys in with it.
# - The value is exported to the child server and never printed or written anywhere.
# - A key already in the environment wins, and ORBIT_DEMO_MANAGED_AI=off still turns the
#   whole localhost path off (the gate checks it), to see the production "add a key" states.
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  _orbit_env="${ORBIT_MAIN_ENV:-$HOME/Projects/orbit/.env.local}"
  if [ -f "$_orbit_env" ]; then
    _orbit_key="$(grep -E '^(export[[:space:]]+)?ANTHROPIC_API_KEY=' "$_orbit_env" | tail -n 1 | cut -d= -f2- || true)"
    # Quotes around the value are legal in a .env file.
    _orbit_key="${_orbit_key%\"}"; _orbit_key="${_orbit_key#\"}"
    _orbit_key="${_orbit_key%\'}"; _orbit_key="${_orbit_key#\'}"
    if [ -n "$_orbit_key" ]; then
      export ANTHROPIC_API_KEY="$_orbit_key"
    else
      echo "preview: no ANTHROPIC_API_KEY in $_orbit_env; AI stays off in this preview" >&2
    fi
  else
    echo "preview: $_orbit_env not found; AI stays off in this preview" >&2
  fi
  unset _orbit_env _orbit_key
fi
