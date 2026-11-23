#!/usr/bin/env bash
set -euo pipefail

# Prints the simulator-server-releases tag of the newest Radon build from one
# channel: `main` (pushes to Radon's main branch) or `daily` (the nightly).
#
# The org enforces immutable GitHub releases, so a published release can't be
# updated and Radon's build-sim-server.yml can't keep refreshing one floating
# tag. Each build publishes a new radon-<channel>-<sha> release instead, where
# <sha> is the full commit SHA it was built from. The old floating radon-main
# and radon-daily releases are frozen.
#
# Usage: ./scripts/resolve-sim-server-release-tag.sh <channel>
#
# Requires:
#   - gh CLI, logged in with `gh auth login`

CHANNEL="${1:?usage: $0 <channel>, for example main or daily}"
REPO="software-mansion-labs/simulator-server-releases"

# The channel goes into a jq regex below, so keep it to plain name characters.
if ! [[ "${CHANNEL}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Error: invalid channel '${CHANNEL}'. Use letters, digits, '-' or '_', for example main or daily." >&2
  exit 1
fi

# A release's createdAt is the date of its target commit in the releases repo,
# which is the same for every release there, so pick by publishedAt. gh still
# returns the most recently created releases first (the tie falls back to
# release id), so the newest build is among the first 100. Drafts are builds
# still uploading.
if ! TAG="$(gh release list --repo "${REPO}" --exclude-drafts --limit 100 \
  --json tagName,publishedAt \
  --jq "[.[] | select(.tagName | test(\"^radon-${CHANNEL}-[0-9a-f]{40}\$\"))] | sort_by(.publishedAt) | last | .tagName // empty")"; then
  echo "Error: could not list the releases of ${REPO}. Is gh logged in (gh auth login)?" >&2
  exit 1
fi

if [[ -z "${TAG}" ]]; then
  echo "Error: no radon-${CHANNEL}-<sha> release found in ${REPO}." >&2
  echo "Radon's build-sim-server.yml publishes one for every build of that channel." >&2
  exit 1
fi

echo "${TAG}"
