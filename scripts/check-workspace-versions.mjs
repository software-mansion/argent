#!/usr/bin/env node
// Fails if the workspace packages under packages/* don't all share the same
// version. Keeps the monorepo's lockstep versioning from silently drifting when
// a release bump misses a package.
//
// The root server.json (the MCP registry manifest) is held to the version and
// the npm coordinates in packages/argent/package.json, the package it points at.
// It is checked here because it is the one such file outside packages/*, so a
// bump that sweeps the workspace leaves it behind — and the registry then
// rejects the publish, either because `packages[].version` names a version npm
// has never seen or because `name` doesn't match the tarball's `mcpName`.
//
// packages/argent/plugin.json + mcp.json (the Agent Plugins manifest pair, which
// makes the published tarball a loadable plugin root) are checked for the same
// reason: plugin.json carries its own `version`, and mcp.json pins the exact npm
// version its stdio server runs. Both are inert at build time, so nothing else
// notices when a bump leaves them behind — the plugin would just keep launching
// the previous release, next to skills shipped from this one.
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { argv as processArgv } from "node:process";

const selfPath = realpathSync(fileURLToPath(import.meta.url));
const repoRoot = join(dirname(selfPath), "..");
const packagesDir = join(repoRoot, "packages");
const argentManifestPath = join(packagesDir, "argent", "package.json");
const serverJsonPath = join(repoRoot, "server.json");
const pluginManifestPath = join(packagesDir, "argent", "plugin.json");
const pluginMcpPath = join(packagesDir, "argent", "mcp.json");

// The Agent Plugins spec version the manifest pair targets. Both files declare
// it, and the spec requires them to agree — a mismatch invalidates the MCP
// component while leaving the rest of the plugin loadable, which is exactly the
// half-broken state this check exists to prevent.
const PLUGIN_SPEC_VERSION = "1.0.0";
const PLUGIN_SCHEMA = `https://agent-plugins.org/schemas/${PLUGIN_SPEC_VERSION}/plugin.schema.json`;
const PLUGIN_MCP_SCHEMA = `https://agent-plugins.org/schemas/${PLUGIN_SPEC_VERSION}/mcp.schema.json`;

// Same key `argent init` writes into every editor config (MCP_SERVER_KEY in
// packages/argent-installer). Clients namespace a plugin server's tools by this
// id, so renaming it here would rename every `mcp__argent__*` tool the bundled
// skills call for by name.
const PLUGIN_MCP_SERVER_KEY = "argent";

/**
 * Everything server.json has to keep in step with the npm package it points at,
 * as one human-readable line per problem. Pure, separated from the fs reads so
 * it can be unit-tested.
 * @param {string | undefined} publishedVersion the version packages/argent/package.json carries
 * @param {{ name?: string, mcpName?: string }} argentPkg packages/argent/package.json
 * @param {{ name?: string, version?: string, packages?: { identifier?: string, version?: string }[] }} server server.json
 * @returns {string[]} empty when in sync
 */
export function serverJsonMismatches(publishedVersion, argentPkg, server) {
  const mismatches = [];

  // Without a version on the manifest there is no target to compare against, and
  // every comparison below would pass by matching undefined against undefined —
  // so its absence is a mismatch in its own right, exactly like mcpName's.
  if (!publishedVersion) {
    mismatches.push(
      "packages/argent/package.json has no version — nothing for server.json to be checked against"
    );
  } else if (server.version !== publishedVersion) {
    mismatches.push(
      `server.json version is ${server.version}, packages/argent/package.json is ${publishedVersion}`
    );
  }

  // mcpName on the published npm tarball is what proves to the registry that the
  // io.github.software-mansion namespace is ours, so its absence is as fatal as a
  // mismatch — and an absent one equals an absent server.json name by ===.
  if (!argentPkg.mcpName) {
    mismatches.push(
      "packages/argent/package.json has no mcpName — the registry reads it off the published tarball to prove the namespace"
    );
  } else if (server.name !== argentPkg.mcpName) {
    mismatches.push(
      `server.json name (${server.name}) != packages/argent/package.json mcpName (${argentPkg.mcpName})`
    );
  }

  // Every packages[].identifier below is compared against this name, so without
  // it those comparisons pass on undefined === undefined and server.json is free
  // to name no installable package at all.
  if (!argentPkg.name) {
    mismatches.push(
      "packages/argent/package.json has no name — server.json's identifier has nothing to point at"
    );
  }

  // Absent, empty and non-array all leave the registry entry naming nothing to
  // install, so they get one message rather than a TypeError out of the loop.
  const packages = server.packages;
  if (!Array.isArray(packages) || packages.length === 0) {
    mismatches.push(
      "server.json has no packages array — the registry entry would name nothing to install"
    );
    return mismatches;
  }

  for (const [i, pkg] of packages.entries()) {
    // Same reason as the array check above: an entry that is not an object has
    // no coordinates to read, and reading through it would throw out of the loop.
    if (typeof pkg !== "object" || pkg === null) {
      mismatches.push(
        `server.json packages[${i}] is ${pkg === null ? "null" : typeof pkg}, not an object naming a registry and identifier`
      );
      continue;
    }
    if (pkg.version !== publishedVersion) {
      mismatches.push(
        `server.json packages[${i}].version is ${pkg.version}, packages/argent/package.json is ${publishedVersion}`
      );
    }
    if (pkg.identifier !== argentPkg.name) {
      mismatches.push(
        `server.json packages[${i}].identifier (${pkg.identifier}) != published package name (${argentPkg.name})`
      );
    }
  }

  return mismatches;
}

/**
 * Everything the Agent Plugins manifest pair has to keep in step with the npm
 * package it ships inside, as one human-readable line per problem. Pure, like
 * serverJsonMismatches() above, so the whole matrix is unit-testable.
 * @param {string | undefined} publishedVersion the version packages/argent/package.json carries
 * @param {{ name?: string, files?: string[] }} argentPkg packages/argent/package.json
 * @param {{ $schema?: string, name?: string, version?: string }} plugin packages/argent/plugin.json
 * @param {{ $schema?: string, mcpServers?: Record<string, { type?: string, command?: string, args?: string[] }> }} mcp packages/argent/mcp.json
 * @returns {string[]} empty when in sync
 */
export function pluginManifestMismatches(publishedVersion, argentPkg, plugin, mcp) {
  const mismatches = [];

  // Mirrors the publishedVersion guard in serverJsonMismatches: with no version
  // to compare against, every check below would pass on undefined === undefined.
  if (!publishedVersion) {
    mismatches.push(
      "packages/argent/package.json has no version — nothing for plugin.json to be checked against"
    );
  } else if (plugin.version !== publishedVersion) {
    mismatches.push(
      `plugin.json version is ${plugin.version}, packages/argent/package.json is ${publishedVersion}`
    );
  }

  if (plugin.$schema !== PLUGIN_SCHEMA) {
    mismatches.push(`plugin.json $schema is ${plugin.$schema}, expected ${PLUGIN_SCHEMA}`);
  }
  if (mcp.$schema !== PLUGIN_MCP_SCHEMA) {
    mismatches.push(`mcp.json $schema is ${mcp.$schema}, expected ${PLUGIN_MCP_SCHEMA}`);
  }

  // Both files ship inside the tarball, but only if `files` names them — npm
  // includes package.json, README and LICENSE implicitly and nothing else. A
  // plugin root missing either file is not a plugin at all.
  const files = Array.isArray(argentPkg.files) ? argentPkg.files : [];
  for (const entry of ["plugin.json", "mcp.json"]) {
    if (!files.includes(entry)) {
      mismatches.push(
        `packages/argent/package.json "files" does not list ${entry} — it would not ship in the tarball`
      );
    }
  }

  // Absent and non-object both mean the plugin declares no MCP server, and
  // reading through the latter would throw rather than report.
  const servers = mcp.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    mismatches.push("mcp.json has no mcpServers object — the plugin would expose no tools");
    return mismatches;
  }

  const keys = Object.keys(servers);
  if (!keys.includes(PLUGIN_MCP_SERVER_KEY)) {
    mismatches.push(
      `mcp.json declares no "${PLUGIN_MCP_SERVER_KEY}" server (found: ${keys.join(", ") || "none"}) — ` +
        `plugin tools would not be named mcp__${PLUGIN_MCP_SERVER_KEY}__*, which the bundled skills call for`
    );
    return mismatches;
  }

  const entry = servers[PLUGIN_MCP_SERVER_KEY];
  if (entry.type !== "stdio") {
    mismatches.push(`mcp.json ${PLUGIN_MCP_SERVER_KEY}.type is ${entry.type}, expected stdio`);
  }

  // The npx form is deliberate: a plugin directory can reach a client by a route
  // that never runs `npm install` (a git clone, a marketplace copy), so the
  // server cannot be assumed to be resolvable next to the manifest. The pin is
  // what keeps the launched server on the same release as the skills sitting
  // beside it in the same plugin.
  const pin = `${argentPkg.name}@${publishedVersion}`;
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (publishedVersion && argentPkg.name && !args.includes(pin)) {
    mismatches.push(
      `mcp.json ${PLUGIN_MCP_SERVER_KEY}.args does not pin ${pin} (found: ${args.join(" ") || "none"})`
    );
  }

  return mismatches;
}

/**
 * Reads a tracked JSON file, reporting a missing or malformed one as a sentence
 * instead of a raw stack trace. Both only happen by hand-corrupting a file git
 * tracks, and the fix is the same either way.
 * @param {string} path
 * @returns {any}
 */
function readTrackedJson(path) {
  const shown = relative(repoRoot, path);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`Cannot read ${shown}: ${error.message}`);
    console.error(`\nIt is tracked in git — restore it with \`git checkout -- ${shown}\`.`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`${shown} is not valid JSON: ${error.message}`);
    console.error(`\nIt is tracked in git — restore it with \`git checkout -- ${shown}\`.`);
    process.exit(1);
  }

  // JSON.parse returns whatever the file holds, so a scalar, null or an array
  // parses cleanly and then either throws or compares equal to undefined on
  // every field read below. Both callers want an object or nothing.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const shape = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    console.error(`${shown} is ${shape}, not a JSON object`);
    console.error(`\nIt is tracked in git — restore it with \`git checkout -- ${shown}\`.`);
    process.exit(1);
  }
  return parsed;
}

function main() {
  const byVersion = new Map(); // version -> package names
  // Sorted so the scan visits packages/* in the same order on every machine —
  // readdir order is filesystem-dependent, and a scan that stops early would
  // otherwise drop a different set of packages each run.
  const entries = readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(packagesDir, entry.name, "package.json"), "utf8"));
    } catch {
      continue; // directory without a package.json
    }
    // `?.` because JSON.parse succeeds on a file holding `null`, which the catch
    // above never sees — the same shape readTrackedJson rejects for the two
    // manifests it reads.
    if (!manifest?.version) continue;
    const names = byVersion.get(manifest.version) ?? [];
    names.push(manifest.name ?? entry.name);
    byVersion.set(manifest.version, names);
  }

  let failed = false;

  // Reported before the reads below, so a corrupt server.json can't swallow it.
  if (byVersion.size > 1) {
    console.error("Workspace package versions are out of sync:");
    for (const [version, names] of [...byVersion].sort()) {
      console.error(`  ${version}: ${names.sort().join(", ")}`);
    }
    console.error(
      "\nEvery package under packages/* must share one version. Bump the outliers to match.\n"
    );
    failed = true;
  }

  // An empty packages/ never gets past this read. It only proves the file parses,
  // though — a manifest missing its version is caught as a mismatch below.
  const argentPkg = readTrackedJson(argentManifestPath);
  const server = readTrackedJson(serverJsonPath);
  const plugin = readTrackedJson(pluginManifestPath);
  const pluginMcp = readTrackedJson(pluginMcpPath);

  // server.json names the npm coordinates of packages/argent, so that manifest
  // is what it has to agree with. Reported even when packages/* disagree, so a
  // half-finished bump surfaces every remaining edit in one run.
  const mismatches = serverJsonMismatches(argentPkg.version, argentPkg, server);
  if (mismatches.length > 0) {
    console.error("server.json is out of sync with packages/argent/package.json:");
    for (const line of mismatches) console.error(`  ${line}`);
    console.error(
      "\nserver.json is not under packages/*, so a workspace bump leaves it behind — edit it\n" +
        "by hand to match packages/argent/package.json."
    );
    failed = true;
  }

  // Reported alongside the server.json result rather than instead of it, for the
  // same reason: one run should list every file a half-finished bump left behind.
  const pluginProblems = pluginManifestMismatches(argentPkg.version, argentPkg, plugin, pluginMcp);
  if (pluginProblems.length > 0) {
    console.error(
      "packages/argent/plugin.json + mcp.json are out of sync with packages/argent/package.json:"
    );
    for (const line of pluginProblems) console.error(`  ${line}`);
    console.error(
      "\nThe Agent Plugins manifest pair carries its own version and pins the npm version its\n" +
        "server runs, so a workspace bump leaves both behind — edit them by hand to match."
    );
    failed = true;
  }

  if (failed) process.exit(1);

  console.log(
    `All workspace packages, server.json and the plugin manifest are at ${argentPkg.version}.`
  );
}

// Run only when invoked directly, not when imported by the test. Both sides are
// realpath'd: node realpaths the main module before setting import.meta.url but
// leaves process.argv[1] as typed, so comparing them raw makes a path through a
// symlink skip main() and exit 0 with no output — a silent pass.
if (processArgv[1] && realpathSync(processArgv[1]) === selfPath) {
  main();
}
