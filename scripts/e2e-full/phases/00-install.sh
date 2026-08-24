#!/usr/bin/env bash
# Phase 0 — install assertions for the tgz.
#
# run-e2e.sh already ran the primary `npm install -g <tgz>` into the sandbox
# prefix; that install is what ARGENT_BIN drives and what this phase checks.

# Find a workspace config file that registers the argent MCP server. Which
# editor adapters run depends on which editors are detected, so match any known
# config file rather than pinning one path.
# The default pattern is the server key, not the package name: a global-mode
# init writes the MCP command as plain `argent`.
_argent_mcp_in_ws() { # ws [grep-pattern]
  local pat="${2:-\"argent\"}"
  grep -rl "$pat" "$1" \
    --include='*.json' --include='*.jsonc' --include='*.toml' --include='*.yaml' 2>/dev/null \
    | grep -v -e '/node_modules/' -e 'skills-lock.json' -e 'package-lock.json' -e 'package.json' \
    | head -1
}

_pkg_dir() {
  local d="$E2E_PREFIX/lib/node_modules/@swmansion/argent"
  [ -d "$d" ] && { printf '%s\n' "$d"; return; }
  find "$E2E_PREFIX" -maxdepth 4 -type d -name argent -path '*@swmansion*' 2>/dev/null | head -1
}

run_phase() {
  local P=install
  local pkg; pkg="$(_pkg_dir)"

  if argent_cli --version && [ "$CLI_OUT" = "$TGZ_VERSION" ]; then
    pass "$P" npm-global version "argent v$CLI_OUT on PATH"
  else
    fail "$P" npm-global version "got '$CLI_OUT' want '$TGZ_VERSION' (install broken?)"
  fi

  if [ -n "$pkg" ] && [ -d "$pkg" ]; then
    pass "$P" npm-global package-dir "$pkg"
  else
    fail "$P" npm-global package-dir "installed package dir not found under $E2E_PREFIX"
    return 0
  fi

  local plat="linux"
  case "$E2E_OS" in darwin) plat="darwin";; esac
  # arm64 linux ships in its own dir.
  local simsrv=""
  for cand in "$pkg/bin/$plat/simulator-server" "$pkg/bin/${plat}-arm64/simulator-server"; do
    [ -f "$cand" ] && simsrv="$cand" && break
  done
  if [ -n "$simsrv" ] && [ -x "$simsrv" ]; then
    pass "$P" bundle simulator-server "$(basename "$(dirname "$simsrv")")"
  else
    fail "$P" bundle simulator-server "missing/non-executable: $simsrv"
  fi
  # trace-processor assets (profiler) always shipped
  [ -d "$pkg/assets/trace-processor" ] && pass "$P" bundle trace-processor || fail "$P" bundle trace-processor "assets/trace-processor missing"
  if [ "$E2E_OS" = "darwin" ]; then
    ls "$pkg"/dylibs/*.dylib >/dev/null 2>&1 && pass "$P" bundle dylibs || fail "$P" bundle dylibs "no dylibs in package"
  else
    skip "$P" bundle dylibs "macOS-only"
  fi

  # The postinstall was dropped in #510 and its jobs moved to runtime, because
  # installs passing --ignore-scripts skip it silently. Pin the absence so it
  # cannot creep back in.
  # Parse the manifest first: `jq -e` exits non-zero for an unreadable file just
  # as it does for an absent key, so an install missing its package.json would
  # otherwise report "no hook" — an absence check passing because it could not
  # look.
  if ! jq -e . "$pkg/package.json" >/dev/null 2>&1; then
    fail "$P" postinstall no-hook "package.json missing or unparseable at $pkg"
  elif [ -f "$pkg/scripts/postinstall.cjs" ] || jq -e '.scripts.postinstall' "$pkg/package.json" >/dev/null 2>&1; then
    fail "$P" postinstall no-hook "package ships a postinstall hook again (dropped in #510)"
  else
    pass "$P" postinstall no-hook
  fi

  local gws="$E2E_WORK/ws/global"
  mkdir -p "$gws"; ( cd "$gws" && git init -q >/dev/null 2>&1 || true )
  printf '{"name":"e2e-global-probe","private":true}\n' > "$gws/package.json"
  pushd "$gws" >/dev/null
  if argent_cli init --yes --global --no-telemetry --from "$E2E_TGZ"; then
    pass "$P" init-global exit0
  else
    fail "$P" init-global exit0 "$(printf '%s' "$CLI_OUT" | tail -3 | tr '\n' ' ')"
  fi
  popd >/dev/null
  local gcfg; gcfg="$(_argent_mcp_in_ws "$gws")"
  if [ -n "$gcfg" ]; then
    pass "$P" init-global mcp-config "$(basename "$(dirname "$gcfg")")/$(basename "$gcfg")"
  else
    fail "$P" init-global mcp-config "no argent MCP config written under $gws"
  fi
  [ -f "$gws/skills-lock.json" ] && pass "$P" init-global skills-lock || skip "$P" init-global skills-lock "no skills-lock.json"
  [ -f "$E2E_HOME/.argent/config.json" ] && pass "$P" init-global home-config || skip "$P" init-global home-config "no ~/.argent/config.json"

  local lws="$E2E_WORK/ws/local"
  mkdir -p "$lws"
  printf '{"name":"e2e-local-probe","private":true,"version":"0.0.0"}\n' > "$lws/package.json"
  pushd "$lws" >/dev/null
  if argent_cli init --yes --local --no-telemetry --from "$E2E_TGZ"; then
    pass "$P" init-local exit0
  else
    fail "$P" init-local exit0 "$(printf '%s' "$CLI_OUT" | tail -3 | tr '\n' ' ')"
  fi
  popd >/dev/null
  if [ -d "$lws/node_modules/@swmansion/argent" ]; then
    pass "$P" init-local devDependency
  else
    fail "$P" init-local devDependency "package not in $lws/node_modules"
  fi
  if [ -f "$lws/.argent/install.json" ] && [ "$(jq -r '.mode' "$lws/.argent/install.json" 2>/dev/null)" = "local" ]; then
    pass "$P" init-local install-record "mode=local"
  else
    fail "$P" init-local install-record "no local .argent/install.json"
  fi
  local lcfg; lcfg="$(_argent_mcp_in_ws "$lws" 'node_modules/@swmansion/argent')"
  if [ -n "$lcfg" ]; then
    pass "$P" init-local mcp-config "$(basename "$(dirname "$lcfg")")/$(basename "$lcfg") -> node_modules path"
  else
    # fall back: yarn-PnP and npx modes write no node_modules path.
    lcfg="$(_argent_mcp_in_ws "$lws")"
    [ -n "$lcfg" ] && pass "$P" init-local mcp-config "$(basename "$lcfg")" || fail "$P" init-local mcp-config "no local argent MCP config under $lws"
  fi

  # Before the uninstall tests, while the driver is still installed.
  pushd "$lws" >/dev/null
  if argent_cli update --yes; then
    pass "$P" update ran "completed (rc=0)"
  else
    skip "$P" update ran "non-zero (likely offline/registry): $(printf '%s' "$CLI_OUT" | head -1)"
  fi
  popd >/dev/null

  # Safe first: this removes the devDependency and workspace config, never the
  # global driver the rest of the run depends on.
  pushd "$lws" >/dev/null
  if argent_cli uninstall --yes --local; then pass "$P" uninstall-local exit0; else skip "$P" uninstall-local exit0 "$(printf '%s' "$CLI_OUT" | tail -2 | tr '\n' ' ')"; fi
  popd >/dev/null
  if [ ! -d "$lws/node_modules/@swmansion/argent" ] || [ ! -f "$lws/.argent/install.json" ]; then
    pass "$P" uninstall-local config-removed
  else
    fail "$P" uninstall-local config-removed "local install still present under $lws"
  fi

  pushd "$gws" >/dev/null
  if argent_cli uninstall --yes --global; then pass "$P" uninstall-global exit0; else skip "$P" uninstall-global exit0 "$(printf '%s' "$CLI_OUT" | tail -2 | tr '\n' ' ')"; fi
  popd >/dev/null
  local gcfg2; gcfg2="$(_argent_mcp_in_ws "$gws")"
  if [ -z "$gcfg2" ]; then pass "$P" uninstall-global config-removed; else fail "$P" uninstall-global config-removed "argent MCP config remains: $gcfg2"; fi

  # uninstall --global removed the sandbox bin ARGENT_BIN points at.
  if [ ! -x "${ARGENT_BIN%% *}" ]; then
    log "restoring driver after uninstall test"
    # Put back exactly what run-e2e.sh installed — same prefix, same
    # optional-dep policy. Hardcoding --omit=optional drops electron on a full
    # run and the chromium tier then skips itself as "electron not installed";
    # hardcoding the sandbox prefix under --system leaves the machine's real
    # global argent missing.
    # shellcheck disable=SC2086
    npm install -g "$E2E_TGZ" ${E2E_NPM_PREFIX_ARGS:-} ${E2E_NPM_OMIT:-} >/dev/null 2>&1 || true
  fi
  if argent_cli --version >/dev/null 2>&1; then pass "$P" driver-restored ok; else fail "$P" driver-restored ok "argent not runnable after restore"; fi
}
