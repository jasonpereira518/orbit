#!/usr/bin/env bash
# Vercel "Ignored Build Step" (vercel.json `ignoreCommand`). Exit 0 SKIPS the build, exit 1
# builds it.
#
# Every deployment's function bundles are billed as Functions Storage for as long as it is
# retained, and the ~dozen `claude/*` branch pushes a day each used to build a full preview
# that nobody opened. A `claude/*` branch is now built only once it has a pull request.
#
# Everything unrecognised builds: main and every other branch, production, CLI deploys (no
# git ref), and any environment where these variables are absent. Skipping is the exception
# and needs every one of the conditions below to hold.
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

case "$ref" in
  claude/*) ;;
  *)
    echo "ignore-build: '${ref:-<no git ref>}' is not a claude/* branch, building"
    exit 1
    ;;
esac

if [ -n "${VERCEL_GIT_PULL_REQUEST_ID:-}" ]; then
  echo "ignore-build: $ref has pull request #${VERCEL_GIT_PULL_REQUEST_ID}, building"
  exit 1
fi

case "${VERCEL_GIT_COMMIT_MESSAGE:-}" in
  *"[deploy]"*)
    echo "ignore-build: commit message asks for a deploy, building"
    exit 1
    ;;
esac

echo "ignore-build: skipping $ref, it has no pull request (push with [deploy] in the message to build it anyway)"
exit 0
