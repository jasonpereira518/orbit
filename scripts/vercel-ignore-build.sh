#!/usr/bin/env bash
# Vercel "Ignored Build Step" (vercel.json `ignoreCommand`). Exit 0 SKIPS the build, exit 1
# builds it.
#
# Hobby allows 100 deployments a day, and cancelled and failed builds count against it. Every
# retained deployment's function bundles are also billed as Functions Storage. A PREVIEW build
# is skipped when nobody is going to open it or nothing a visitor could see changed:
#
#   1. A branch other than main with no pull request (claude/*, refine_*, anything else).
#   2. A dependabot/* branch. CI already typechecks, lints and builds it.
#   3. A push that only touched files the app never reads (CI config, docs, e2e specs, smoke
#      scripts, the extension). Diffed against the branch's last build
#      (VERCEL_GIT_PREVIOUS_SHA), so skipped docs pushes followed by a code push still build
#      all of it; without that variable, against the push's parent commit.
#
# `[deploy]` in the commit message always builds. Production ALWAYS builds (the post-deploy
# workflow and /api/health's sha expect every main push to land). Everything unrecognised
# builds: CLI deploys (no git ref), an unknown file, a failed `git diff` (previous SHA missing
# from the clone), an empty diff (a merge), and any environment where these variables are
# absent. Skipping is the exception.
#
# Vercel sets VERCEL_GIT_PULL_REQUEST_ID to "" for a deployment created before its PR
# existed, so opening the PR does not build the branch by itself. Push again, put [deploy]
# in the commit message, or redeploy from the dashboard.
set -u

ref="${VERCEL_GIT_COMMIT_REF:-}"

if [ "${VERCEL_ENV:-}" = "production" ]; then
  echo "ignore-build: production deploys always build"
  exit 1
fi

if [ -z "$ref" ]; then
  echo "ignore-build: no git ref (CLI deploy?), building"
  exit 1
fi

case "${VERCEL_GIT_COMMIT_MESSAGE:-}" in
  *"[deploy]"*)
    echo "ignore-build: commit message asks for a deploy, building"
    exit 1
    ;;
esac

if [ "$ref" = "main" ]; then
  echo "ignore-build: main always builds"
  exit 1
fi

case "$ref" in
  dependabot/*)
    echo "ignore-build: skipping $ref, CI covers dependency bumps (push with [deploy] in the message to build it)"
    exit 0
    ;;
esac

if [ -z "${VERCEL_GIT_PULL_REQUEST_ID:-}" ]; then
  echo "ignore-build: skipping $ref, it has no pull request (push with [deploy] in the message to build it anyway)"
  exit 0
fi

# Skip only when ALL changed files match. An unknown file, a failed `git diff` or an empty
# diff leaves $changed empty or unmatched, which builds.
NON_APP='^(\.github/|docs/|e2e/|extension/|playwright\.config\.ts$|\.gitleaks\.toml$|[^/]*\.md$|scripts/smoke-[^/]*$)'
base="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
if changed=$(git diff --name-only "$base" HEAD 2>/dev/null) && [ -n "$changed" ] \
  && ! printf '%s\n' "$changed" | grep -Evq "$NON_APP"; then
  echo "ignore-build: skipping $ref, only non-app files changed since $base"
  exit 0
fi

echo "ignore-build: $ref has pull request #${VERCEL_GIT_PULL_REQUEST_ID}, building"
exit 1
