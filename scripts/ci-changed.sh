#!/usr/bin/env bash
# Reads changed file names on stdin; prints `code=true` when any of them is something the heavy
# CI jobs (typecheck, build, smoke, e2e) can be affected by, `code=false` when every file is
# docs, agent skills, the extension, or a workflow that does not touch the app.
# Fails open: empty input means "we could not tell", so it says code=true.
#
# docs/RUNBOOK.md counts as code because scripts/smoke-schedules.ts parses it.
# Used by .github/workflows/ci.yml; pinned by scripts/ci-changed.test.ts.
set -euo pipefail

files=$(cat)
if [ -z "$(printf '%s' "$files" | tr -d '[:space:]')" ]; then
  echo "code=true"
  exit 0
fi

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    docs/RUNBOOK.md) echo "code=true"; exit 0 ;;
    *.md | docs/* | .agents/* | .claude/* | extension/* | LICENSE) ;;
    .github/workflows/ops.yml | .github/workflows/extension.yml) ;;
    *) echo "code=true"; exit 0 ;;
  esac
done <<< "$files"

echo "code=false"
