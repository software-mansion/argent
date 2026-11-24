#!/usr/bin/env bash
set -euo pipefail

# Prints the simulator-server-releases tag of the newest complete Radon build
# from one channel: `main` (pushes to Radon's main branch) or `daily` (the
# nightly).
#
# The org enforces immutable GitHub releases, so a published release can't be
# updated and Radon's build-sim-server.yml can't keep refreshing one floating
# tag. Each build publishes a new radon-<channel>-<sha> release instead, where
# <sha> is the full commit SHA it was built from. The floating radon-main and
# radon-daily releases stop updating once that change is in.
#
# Radon publishes a build even when some of its legs failed, and an immutable
# release can't be completed afterwards. So when assets are named, a release
# that lacks any of them is skipped in favor of the newest one that has them
# all.
#
# Usage: ./scripts/resolve-sim-server-release-tag.sh <channel> [asset...]
#
#   asset  a release asset name the build must have, for example
#          simulator-server-argent-linux. download-simulator-server.sh passes
#          every asset it downloads.
#
# Requires:
#   - gh CLI, logged in with `gh auth login`

CHANNEL="${1:?usage: $0 <channel> [asset...], for example main or daily}"
shift
REQUIRED_ASSETS=("$@")
REPO="software-mansion-labs/simulator-server-releases"

# The channel goes into a jq regex below, so keep it to plain name characters.
if ! [[ "${CHANNEL}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Error: invalid channel '${CHANNEL}'. Use letters, digits, '-' or '_', for example main or daily." >&2
  exit 1
fi

# A release's createdAt is the date of its target commit in the releases repo,
# which is the same for every release there, so order by publishedAt, newest
# first. gh still returns the most recently created releases first (the tie
# falls back to release id), so the newest builds are among the first 100.
# Drafts are builds still uploading.
if ! CANDIDATES="$(gh release list --repo "${REPO}" --exclude-drafts --limit 100 \
  --json tagName,publishedAt \
  --jq "[.[] | select(.tagName | test(\"^radon-${CHANNEL}-[0-9a-f]{40}\$\"))] | sort_by(.publishedAt) | reverse | .[].tagName")"; then
  echo "Error: could not list the releases of ${REPO}. Is gh logged in (gh auth login)?" >&2
  exit 1
fi

if [[ -z "${CANDIDATES}" ]]; then
  echo "Error: no radon-${CHANNEL}-<sha> release found in ${REPO}." >&2
  echo "Radon's build-sim-server.yml publishes one for every build of that channel." >&2
  exit 1
fi

# `gh release list` has no assets field, so look each candidate up, newest
# first, until one has every required asset. An asset still uploading isn't
# there yet.
while IFS= read -r TAG; do
  if [[ ${#REQUIRED_ASSETS[@]} -eq 0 ]]; then
    echo "${TAG}"
    exit 0
  fi
  if ! ASSETS="$(gh release view "${TAG}" --repo "${REPO}" --json assets \
    --jq '.assets[] | select(.state == "uploaded") | .name')"; then
    echo "Error: could not read the assets of ${TAG} in ${REPO}." >&2
    exit 1
  fi
  MISSING=()
  for asset in "${REQUIRED_ASSETS[@]}"; do
    grep -qxF -- "${asset}" <<<"${ASSETS}" || MISSING+=("${asset}")
  done
  if [[ ${#MISSING[@]} -eq 0 ]]; then
    echo "${TAG}"
    exit 0
  fi
  echo "Skipping ${TAG}: missing ${MISSING[*]}" >&2
done <<<"${CANDIDATES}"

echo "Error: no radon-${CHANNEL}-<sha> release in ${REPO} has all of: ${REQUIRED_ASSETS[*]}." >&2
exit 1
