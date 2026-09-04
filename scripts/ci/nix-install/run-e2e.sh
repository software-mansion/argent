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
#                           # (A2 covers the same command with no terminal)
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
failed_assertions=()

fail() {
  failed_assertions+=("$1")
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
#
# Both strip ANSI first. picocolors colours whenever CI is set — which Actions
# always sets, TTY or not — so a `pc.dim(...)` span puts an escape inside lines
# like `Running: <dim>npm install -g …`, and a raw grep for a fragment that
# straddles one can never match. An `absent` that can never match passes for
# the wrong reason, which is the failure mode this whole file exists to catch.
#
# Stripped into a here-string rather than piped: `grep -q` exits at the first
# match, and with `pipefail` the SIGPIPE that kills sed makes the pipeline 141
# once a log outgrows the pipe buffer — which reads as "no match" and passes
# every `absent` for a string that is there.
#
# A log that cannot be read answers 2, not "no match": the command substitution
# throws sed's status away, so a scenario whose output never landed would
# otherwise pass every `absent` in it.
plain() { LC_ALL=C sed $'s/\x1b\[[0-9;?]*[a-zA-Z]//g' "$1"; }
found() {
  local text
  text="$(plain "$1")" || return 2
  grep -qF -- "$2" <<<"$text"
}
contains() {
  local rc=0
  found "$1" "$2" || rc=$?
  case "$rc" in
    0) pass "output contains: $2" ;;
    2) fail "cannot read $1, looking for: $2" ;;
    *) fail "output MISSING: $2" ;;
  esac
}
absent() {
  local rc=0
  found "$1" "$2" || rc=$?
  case "$rc" in
    0) fail "output should NOT contain: $2" ;;
    2) fail "cannot read $1, checking absence of: $2" ;;
    *) pass "output free of: $2" ;;
  esac
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

# -d as well as -w: `test -w` is false for a path that does not exist, which
# would let a mistyped root pass this guard without proving anything.
[[ -d "$GLOBAL_ROOT" ]] || require "$GLOBAL_ROOT does not exist — nothing to prove unwritable"
[[ ! -w "$GLOBAL_ROOT" ]] || require "$GLOBAL_ROOT is writable — this is not the failure mode under test"
pass "npm global root is not writable"

# The npx-style copy the scenarios drive: extracted, never globally installed.
RUNNER="$WORK/runner"
rm -rf "$RUNNER"
mkdir -p "$RUNNER"
tar -xzf "$TGZ" -C "$RUNNER" || require "could not extract $TGZ"
CLI="$RUNNER/package/dist/cli.js"
[[ -f "$CLI" ]] || require "$TGZ has no dist/cli.js — pack the installer package first"
PACKED_VERSION="$(node -p "require('$RUNNER/package/package.json').version")" || require "could not read the packed version from $TGZ"
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
  # Through npx, because this run reached the preflight without a global
  # install: a bare `argent` is not on PATH for whoever reads this.
  contains "$out" "npx @swmansion/argent init --local"
  absent "$out" "npm error"
  absent "$out" "EACCES"

  # A Dockerfile or CI step runs the same command with no terminal behind it.
  # A menu there would never be answered: the run would end at a rendered
  # prompt, exit 0, and have installed nothing.
  begin "A2. argent init --global with no terminal to prompt on"
  home="$(new_home a2)"
  project="$(new_project a2)"
  out="$WORK/a2.log"
  (cd "$project" && HOME="$home" node "$CLI" init --global --no-telemetry </dev/null) >"$out" 2>&1
  exit_is "$?" 1
  contains "$out" "cannot install @swmansion/argent globally"
  contains "$out" "npx @swmansion/argent init --local"
  absent "$out" "How would you like to proceed"

  # The same, without --global. This one reaches the install-mode selector
  # first, which is a menu of its own — it has to be skipped for the same
  # reason, or the run ends there having installed nothing and exits 0.
  begin "A3. argent init with no mode flag and no terminal to prompt on"
  home="$(new_home a3)"
  project="$(new_project a3)"
  out="$WORK/a3.log"
  (cd "$project" && HOME="$home" node "$CLI" init --no-telemetry </dev/null) >"$out" 2>&1
  exit_is "$?" 1
  contains "$out" "cannot install @swmansion/argent globally"
  contains "$out" "npx @swmansion/argent init --local"
  absent "$out" "How should argent be installed"
  absent "$out" "How would you like to proceed"
  if [[ -d "$project/node_modules/@swmansion/argent" ]]; then
    fail "a run that could not ask installed anyway"
  else
    pass "nothing installed"
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

  # The other half of the preflight. npm links its commands into <prefix>/bin,
  # which the package-directory probe never walks, and an earlier
  # `sudo npm i -g` leaves exactly that split: writable where the package goes,
  # root-owned where the shim does. Every other scenario runs on a Nix node,
  # where the package directory is blocked first and this check is never
  # reached.
  begin "B2. a writable prefix whose bin directory is not"
  home="$(new_home b2)"
  project="$(new_project b2)"
  out="$WORK/b2.log"
  prefix="$home/.npm-global"
  mkdir -p "$prefix/lib/node_modules" "$prefix/bin"
  chmod 0555 "$prefix/bin"
  (
    cd "$project" || exit 1
    HOME="$home" npm config set prefix "$prefix"
    # Same reason as B: should this check ever regress, the run would download
    # argent's optional dependencies before dying on the bin link.
    HOME="$home" npm_config_omit=optional node "$CLI" init --global --yes --no-telemetry --from "$TGZ"
  ) >"$out" 2>&1
  exit_is "$?" 1
  contains "$out" "it cannot write to $prefix/bin"
  # Pointing npm at the prefix it already uses is no remedy; taking ownership
  # of the directory that is blocking it is.
  contains "$out" "Take ownership of the directory"
  absent "$out" "npm config set prefix"
  # No "nothing installed" check: npm rolls the staged package back when the bin
  # link fails, so it holds whether or not the refusal happened.
  absent "$out" "npm error"
  absent "$out" "EACCES"
  chmod 0755 "$prefix/bin"

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
  # Here argent IS on PATH — the reader can run it directly, unlike A/A2/A3.
  contains "$out" "argent init --local"
  absent "$out" "npx @swmansion/argent init --local"
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

  # Same assertion D makes, for the other write path into the same directory:
  # refusing the install has to leave the one already there alone.
  still="$(argent --version 2>&1 | tail -1)"
  if [[ "$still" == "$PACKED_VERSION" ]]; then
    pass "the store install is untouched at v$still"
  else
    fail "global argent now reports '$still', expected '$PACKED_VERSION'"
  fi

else
  require "unknown phase '$PHASE' (expected preinstall or update)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

printf '\n'
if [[ "$failures" -gt 0 ]]; then
  printf '%s assertion(s) failed in phase %s:\n' "$failures" "$PHASE"
  printf '  x %s\n' "${failed_assertions[@]}"
  printf 'Logs in %s\n' "$WORK"
  exit 1
fi
printf 'Phase %s passed.\n' "$PHASE"
