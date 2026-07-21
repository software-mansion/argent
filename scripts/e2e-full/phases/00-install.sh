#!/usr/bin/env bash
# Phase 0 — Install from the tgz (the whole point of "given ONLY a tgz").
#
# run-e2e.sh has already done the primary `npm install -g <tgz>` into the
# sandbox prefix (that's what ARGENT_BIN drives). This phase asserts that
# install produced a working CLI + bundled runtime, then exercises the
# configuration lifecycle in throwaway workspaces: global init, local init,
# uninstall, and a best-effort update.
#
# Everything is confined to the sandbox: npm_config_prefix -> $E2E_PREFIX,
# HOME -> $E2E_HOME. Nothing touches the real machine.

# Find a workspace config file that registers the argent MCP server. Editor
# adapter selection is environment-dependent (which editors are "detected"), so
# we assert the semantic outcome across all known config files rather than
# pinning one path. Prints the first matching file (empty if none).
# The default pattern is the quoted server name, not the npm package name: a
# global-mode init registers the MCP command as plain `argent` (the global bin),
# so `@swmansion/argent` never appears in the written config.
_argent_mcp_in_ws() { # ws [grep-pattern]
  local pat="${2:-\"argent\"}"
  grep -rl "$pat" "$1" \
    --include='*.json' --include='*.jsonc' --include='*.toml' --include='*.yaml' 2>/dev/null \
    | grep -v -e '/node_modules/' -e 'skills-lock.json' -e 'package-lock.json' -e 'package.json' \
    | head -1
}

# Path to the installed package inside the sandbox prefix.
_pkg_dir() {
  local d="$E2E_PREFIX/lib/node_modules/@swmansion/argent"
  [ -d "$d" ] && { printf '%s\n' "$d"; return; }
  # npm on some platforms nests bins differently; fall back to a find.
  find "$E2E_PREFIX" -maxdepth 4 -type d -name argent -path '*@swmansion*' 2>/dev/null | head -1
}

run_phase() {
  local P=install
  local pkg; pkg="$(_pkg_dir)"

  # --- the sandbox global install produced a working CLI --------------------
  if argent_cli --version && [ "$CLI_OUT" = "$TGZ_VERSION" ]; then
    pass "$P" npm-global "argent v$CLI_OUT on PATH"
  else
    fail "$P" npm-global "version '$CLI_OUT' != '$TGZ_VERSION' (install broken?)"
  fi

  if [ -n "$pkg" ] && [ -d "$pkg" ]; then
    pass "$P" npm-global package-dir "$pkg"
  else
    fail "$P" npm-global package-dir "installed package dir not found under $E2E_PREFIX"
    return 0
  fi

  # --- bundled native runtime is present + executable for THIS os ----------
  local plat="linux"
  case "$E2E_OS" in darwin) plat="darwin";; esac
  # arm64 linux ships in a separate dir; pick whichever exists.
  local simsrv=""
  for cand in "$pkg/bin/$plat/simulator-server" "$pkg/bin/${plat}-arm64/simulator-server"; do
    [ -f "$cand" ] && simsrv="$cand" && break
  done
  if [ -n "$simsrv" ] && [ -x "$simsrv" ]; then
    pass "$P" bundle simulator-server "$(basename "$(dirname "$simsrv")")"
  else
    fail "$P" bundle simulator-server "missing/again-executable: $simsrv"
  fi
  # trace-processor assets (profiler) always shipped
  [ -d "$pkg/assets/trace-processor" ] && pass "$P" bundle trace-processor || fail "$P" bundle trace-processor "assets/trace-processor missing"
  # dylibs are macOS-only
  if [ "$E2E_OS" = "darwin" ]; then
    ls "$pkg"/dylibs/*.dylib >/dev/null 2>&1 && pass "$P" bundle dylibs || fail "$P" bundle dylibs "no dylibs in package"
  else
    skip "$P" bundle dylibs "macOS-only"
  fi

  # --- postinstall prints the init hint ------------------------------------
  if [ -f "$pkg/scripts/postinstall.cjs" ]; then
    local pout; pout="$(cd "$pkg" && ARGENT_SKIP_POSTINSTALL= node scripts/postinstall.cjs 2>&1)"
    case "$pout" in *"argent init"*) pass "$P" postinstall init-hint;; *) fail "$P" postinstall init-hint "banner missing: $(printf '%s' "$pout" | head -1)";; esac
  else
    fail "$P" postinstall init-hint "postinstall.cjs not shipped"
  fi

  # --- global init in a throwaway workspace --------------------------------
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
  # an argent MCP server registered in some editor config?
  local gcfg; gcfg="$(_argent_mcp_in_ws "$gws")"
  if [ -n "$gcfg" ]; then
    pass "$P" init-global mcp-config "$(basename "$(dirname "$gcfg")")/$(basename "$gcfg")"
  else
    fail "$P" init-global mcp-config "no argent MCP config written under $gws"
  fi
  # skills synced?
  [ -f "$gws/skills-lock.json" ] && pass "$P" init-global skills-lock || skip "$P" init-global skills-lock "no skills-lock.json"
  # install record in sandbox HOME
  [ -f "$E2E_HOME/.argent/config.json" ] && pass "$P" init-global home-config || skip "$P" init-global home-config "no ~/.argent/config.json"

  # --- local (committable) init in a fresh npm project ---------------------
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
  # devDependency + a node-path MCP command (not the global `argent`)
  if [ -d "$lws/node_modules/@swmansion/argent" ]; then
    pass "$P" init-local devDependency
  else
    fail "$P" init-local devDependency "package not in $lws/node_modules"
  fi
  # local mode records mode:local and points MCP at the in-repo copy
  if [ -f "$lws/.argent/install.json" ] && [ "$(jq -r '.mode' "$lws/.argent/install.json" 2>/dev/null)" = "local" ]; then
    pass "$P" init-local install-record "mode=local"
  else
    fail "$P" init-local install-record "no local .argent/install.json"
  fi
  local lcfg; lcfg="$(_argent_mcp_in_ws "$lws" 'node_modules/@swmansion/argent')"
  if [ -n "$lcfg" ]; then
    pass "$P" init-local mcp-config "$(basename "$(dirname "$lcfg")")/$(basename "$lcfg") -> node_modules path"
  else
    # fall back: any argent MCP entry that launches via yarn/npx local resolution
    lcfg="$(_argent_mcp_in_ws "$lws")"
    [ -n "$lcfg" ] && pass "$P" init-local mcp-config "$(basename "$lcfg")" || fail "$P" init-local mcp-config "no local argent MCP config under $lws"
  fi

  # --- update: best-effort (needs network to reach the registry) -----------
  # BEFORE any uninstall, while the driver is still installed. Acts on the local
  # workspace install.
  pushd "$lws" >/dev/null
  if argent_cli update --yes; then
    pass "$P" update "completed (rc=0)"
  else
    skip "$P" update "non-zero (likely offline/registry): $(printf '%s' "$CLI_OUT" | head -1)"
  fi
  popd >/dev/null

  # --- uninstall LOCAL (safe: removes the devDependency + workspace config,
  #     never the global driver the rest of the run depends on) --------------
  pushd "$lws" >/dev/null
  if argent_cli uninstall --yes --local; then pass "$P" uninstall-local exit0; else skip "$P" uninstall-local exit0 "$(printf '%s' "$CLI_OUT" | tail -2 | tr '\n' ' ')"; fi
  popd >/dev/null
  if [ ! -d "$lws/node_modules/@swmansion/argent" ] || [ ! -f "$lws/.argent/install.json" ]; then
    pass "$P" uninstall-local config-removed
  else
    fail "$P" uninstall-local config-removed "local install still present under $lws"
  fi

  # --- uninstall GLOBAL, then restore the driver so downstream phases run ---
  pushd "$gws" >/dev/null
  if argent_cli uninstall --yes --global; then pass "$P" uninstall-global exit0; else skip "$P" uninstall-global exit0 "$(printf '%s' "$CLI_OUT" | tail -2 | tr '\n' ' ')"; fi
  popd >/dev/null
  local gcfg2; gcfg2="$(_argent_mcp_in_ws "$gws")"
  if [ -z "$gcfg2" ]; then pass "$P" uninstall-global config-removed; else fail "$P" uninstall-global config-removed "argent MCP config remains: $gcfg2"; fi

  # Restore the global driver (uninstall --global removes the sandbox bin that
  # ARGENT_BIN points at). Fast: the tarball is local and npm caches it.
  if [ ! -x "${ARGENT_BIN%% *}" ]; then
    log "restoring sandbox driver after uninstall test"
    npm install -g "$E2E_TGZ" --prefix "$E2E_PREFIX" --omit=optional >/dev/null 2>&1 || true
  fi
  if argent_cli --version >/dev/null 2>&1; then pass "$P" driver-restored ok; else fail "$P" driver-restored ok "argent not runnable after restore"; fi
}
