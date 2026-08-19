#!/usr/bin/env bash
# Installing and updating argent on a Nix-managed toolchain.
#
# npm derives its global prefix from the node binary's own location. Under Nix
# that is a store path — root-owned, mode 0555, and a read-only mount on NixOS
# and nix-darwin — so `npm install -g` there dies with EACCES for the developer
# running it. Without the preflight in
# packages/argent-installer/src/global-prefix.ts, both `argent init --global`
# and `argent update` run the install anyway and hand the user npm's raw EACCES
# stack trace.
#
# Two phases, because one of them needs a global install sitting in the store,
# which takes the root the store's mode bits reserve. The provisioner owns that
# escalation:
#
#   run-e2e.sh preinstall   # scenarios A-C, no global argent must exist yet
#                           # (A2 covers a run with no terminal to prompt on)
#   <root> npm install -g --omit=optional --ignore-scripts "$ARGENT_TGZ"
#   run-e2e.sh update       # scenarios D-E, against the store-resident install
#
# Preconditions are re-asserted in both phases so the suite can never pass
# vacuously on a machine whose node did not come from Nix.
#
# Usage: ARGENT_TGZ=/path/to/swmansion-argent-<v>.tgz run-e2e.sh <phase>
#
# CI provisions all three steps in .github/workflows/nix-install-e2e.yml. To run
# it by hand on a machine with Nix, put the fixture project's own Node first on
# PATH and do the same:
#
#   nix-build scripts/ci/nix-install/project/toolchain.nix -o /tmp/nix-node
#   export PATH=/tmp/nix-node/bin:$PATH ARGENT_TGZ=<tarball>
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TGZ="${ARGENT_TGZ:?ARGENT_TGZ must point at a packed @swmansion/argent tarball}"
PHASE="${1:?usage: run-e2e.sh <preinstall|update>}"
WORK="${ARGENT_E2E_WORK:-$(mktemp -d)}"

failures=0

fail() {
  printf '  x %s\n' "$1"
  failures=$((failures + 1))
}
pass() { printf '  + %s\n' "$1"; }

# A precondition that does not hold makes every assertion below meaningless, so
# it aborts rather than counting as a failure to be summarised.
require() {
  printf '  ! %s\n' "$1"
  exit 1
}

begin() { printf '\n=== %s ===\n' "$1"; }

# Assertions read the captured output of the run under test. `absent` is what
# pins the actual regression: the fix is that npm's error never reaches the user.
contains() {
  if grep -qF -- "$2" "$1"; then pass "output contains: $2"; else fail "output MISSING: $2"; fi
}
absent() {
  if grep -qF -- "$2" "$1"; then fail "output should NOT contain: $2"; else pass "output free of: $2"; fi
}
exit_is() {
  if [[ "$1" == "$2" ]]; then pass "exit code $2"; else fail "exit code $1, expected $2"; fi
}

# One scratch HOME per scenario: `npm config set prefix` writes ~/.npmrc, and a
# leaked prefix would silently invalidate every later scenario.
new_home() {
  local home="$WORK/home-$1"
  rm -rf "$home"
  mkdir -p "$home"
  printf '%s' "$home"
}

# A fresh copy of the Nix-managed fixture project, so a scenario's init never
# writes into the repo checkout.
new_project() {
  local dir="$WORK/project-$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  cp "$HERE"/project/*.nix "$HERE"/project/package.json "$dir/"
  printf '%s' "$dir"
}

# ── Preconditions ─────────────────────────────────────────────────────────────

printf '=== Preconditions (%s) ===\n' "$PHASE"

[[ "$(id -u)" != "0" ]] || require "running as root: root can write to the Nix store, so nothing here would fail"
pass "running as non-root uid $(id -u)"

GLOBAL_ROOT="$(npm root -g)"
STORE_DIR="${NIX_STORE_DIR:-/nix/store}"
printf '  npm root -g = %s\n' "$GLOBAL_ROOT"

[[ "$GLOBAL_ROOT" == "$STORE_DIR"/* ]] || require "npm global root is not under $STORE_DIR — node did not come from Nix"
pass "npm global root is inside the Nix store"

[[ ! -w "$GLOBAL_ROOT" ]] || require "$GLOBAL_ROOT is writable — this is not the failure mode under test"
pass "npm global root is not writable"

# The npx-style copy the scenarios drive: extracted, never globally installed.
RUNNER="$WORK/runner"
rm -rf "$RUNNER"
mkdir -p "$RUNNER"
tar -xzf "$TGZ" -C "$RUNNER"
CLI="$RUNNER/package/dist/cli.js"
PACKED_VERSION="$(node -p "require('$RUNNER/package/package.json').version")"
pass "runner copy at v$PACKED_VERSION"

if [[ "$PHASE" == "preinstall" ]]; then
  ! command -v argent >/dev/null || require "argent is already on PATH; the preinstall phase needs a machine without a global install"
  pass "no global argent on PATH"
fi

# ── Phase: preinstall ─────────────────────────────────────────────────────────

if [[ "$PHASE" == "preinstall" ]]; then

  begin "A. argent init --global on a Nix toolchain"
  home="$(new_home a)"
  project="$(new_project a)"
  out="$WORK/a.log"
  (cd "$project" && HOME="$home" node "$CLI" init --global --yes --no-telemetry) >"$out" 2>&1
  exit_is "$?" 1
  contains "$out" "cannot install @swmansion/argent globally"
  contains "$out" "read-only Nix store"
  contains "$out" "$GLOBAL_ROOT"
  contains "$out" "argent init --local"
  absent "$out" "npm error"
  absent "$out" "EACCES"

  # A Dockerfile or CI step runs the same command with no terminal behind it.
  # A prompt there is never answered: the run would end at a rendered menu, exit
  # 0, and have installed and configured nothing. Not Nix-specific — this suite
  # is simply where an end-to-end init runs. Scenario A is the same command with
  # --yes, which gets as far as the store and reports what blocks it there.
  begin "A2. argent init --global with no terminal to prompt on"
  home="$(new_home a2)"
  project="$(new_project a2)"
  out="$WORK/a2.log"
  (cd "$project" && HOME="$home" node "$CLI" init --global --no-telemetry </dev/null) >"$out" 2>&1
  exit_is "$?" 2
  contains "$out" "stdin is not a terminal"
  contains "$out" "--yes"
  absent "$out" "How would you like to proceed"
  if [[ -e "$project/node_modules" || -e "$home/.npmrc" ]]; then
    fail "the refused run left state behind"
  else
    pass "nothing installed, no npm prefix written"
  fi

  # The writable prefix argent tells the user to configure has to actually
  # work, and the preflight must not stand in its way once it is set.
  begin "B. the advised writable prefix installs globally"
  home="$(new_home b)"
  project="$(new_project b)"
  out="$WORK/b.log"
  (
    cd "$project" || exit 1
    export HOME="$home"
    npm config set prefix "$home/.npm-global"
    export PATH="$home/.npm-global/bin:$PATH"
    # Inherited by the install argent runs. Where the package lands is what is
    # under test; argent's optional deps (a ~100MB electron download, a
    # node-gyp build of node-pty) only add ways for this to fail for unrelated
    # reasons — the same reason the provisioner seeds with --omit=optional.
    export npm_config_omit=optional
    node "$CLI" init --global --yes --no-telemetry --from "$TGZ"
  ) >"$out" 2>&1
  exit_is "$?" 0
  absent "$out" "read-only Nix store"
  installed="$("$home/.npm-global/bin/argent" --version 2>&1 | tail -1)"
  if [[ "$installed" == "$PACKED_VERSION" ]]; then
    pass "globally installed argent reports v$installed"
  else
    fail "globally installed argent reports '$installed', expected '$PACKED_VERSION'"
  fi

  begin "C. argent init --local in the Nix-managed project"
  home="$(new_home c)"
  project="$(new_project c)"
  out="$WORK/c.log"
  (cd "$project" && HOME="$home" npm_config_omit=optional node "$CLI" init --local --yes --no-telemetry --from "$TGZ") >"$out" 2>&1
  exit_is "$?" 0
  if [[ -f "$project/node_modules/@swmansion/argent/package.json" ]]; then
    pass "argent is a devDependency of the Nix-managed project"
  else
    fail "argent was not installed into $project/node_modules"
  fi

# ── Phase: update ─────────────────────────────────────────────────────────────
# The reported bug verbatim: argent already lives in the store (it got there
# under sudo) and `argent update` tries to replace it.

elif [[ "$PHASE" == "update" ]]; then

  seeded="$(command -v argent || true)"
  [[ -n "$seeded" ]] || require "no argent on PATH; the provisioner must install one globally first"
  [[ "$(readlink -f "$seeded")" == "$STORE_DIR"/* ]] || require "argent at $seeded does not resolve into the Nix store"
  pass "global argent resolves inside the Nix store"

  begin "D. argent update against an install inside the Nix store"
  home="$(new_home d)"
  project="$(new_project d)"
  out="$WORK/d.log"
  # An explicit --version keeps the run off the registry, so the assertion is
  # about the preflight and not about whatever is published today.
  (cd "$project" && HOME="$home" argent update --yes --no-telemetry --version 9.9.9) >"$out" 2>&1
  exit_is "$?" 1
  contains "$out" "cannot update @swmansion/argent globally"
  contains "$out" "read-only Nix store"
  contains "$out" "$GLOBAL_ROOT"
  # No EACCES check here: the pinned --version means npm rejects the target
  # before it ever touches the filesystem, so its absence would prove nothing.
  # That the install is not even attempted is the assertion that bites.
  absent "$out" "Running: npm install -g"
  absent "$out" "npm error"

  still="$(argent --version 2>&1 | tail -1)"
  if [[ "$still" == "$PACKED_VERSION" ]]; then
    pass "the store install is untouched at v$still"
  else
    fail "global argent now reports '$still', expected '$PACKED_VERSION'"
  fi

  # Reinstalling over the store install writes to the same directory the update
  # could not, and reaches it through init's tarball path rather than update's.
  begin "E. argent init --global --from over the install inside the Nix store"
  home="$(new_home e)"
  project="$(new_project e)"
  out="$WORK/e.log"
  (cd "$project" && HOME="$home" node "$CLI" init --global --yes --no-telemetry --from "$TGZ") >"$out" 2>&1
  exit_is "$?" 1
  contains "$out" "cannot install @swmansion/argent globally"
  contains "$out" "read-only Nix store"
  absent "$out" "npm error"
  absent "$out" "EACCES"

else
  require "unknown phase '$PHASE' (expected preinstall or update)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

printf '\n'
if [[ "$failures" -gt 0 ]]; then
  printf '%s assertion(s) failed in phase %s. Logs in %s\n' "$failures" "$PHASE" "$WORK"
  exit 1
fi
printf 'Phase %s passed.\n' "$PHASE"
