#!/usr/bin/env bash
set -euo pipefail

# Prints the argent-private-releases tag of the newest argent-private `main`
# build: the signed native binaries and the trace-processor bundle.
#
# The org enforces immutable GitHub releases, so a published release can't be
# updated and argent-private can't keep refreshing one floating tag. Each push
# to its main publishes a new argent-main-<sha> release instead, where <sha> is
# the full commit SHA. The old argent-main release is frozen at a 2026-11-17
# build.
#
# Usage: ./scripts/resolve-main-binaries-tag.sh
#
# Requires:
#   - gh CLI, logged in with `gh auth login`

REPO="software-mansion-labs/argent-private-releases"

# A release's createdAt is the date of its target commit, which is the same for
# every release in that repo, so pick by publishedAt. gh still returns the most
# recently created releases first (the tie falls back to release id), so the
# newest build is among the first 100. Drafts are builds still uploading.
if ! TAG="$(gh release list --repo "${REPO}" --exclude-drafts --limit 100 \
  --json tagName,publishedAt \
  --jq '[.[] | select(.tagName | test("^argent-main-[0-9a-f]{40}$"))] | sort_by(.publishedAt) | last | .tagName // empty')"; then
  echo "Error: could not list the releases of ${REPO}. Is gh logged in (gh auth login)?" >&2
  exit 1
fi

if [[ -z "${TAG}" ]]; then
  echo "Error: no argent-main-<sha> release found in ${REPO}." >&2
  echo "argent-private publishes one for every push to its main branch." >&2
  exit 1
fi

echo "${TAG}"
