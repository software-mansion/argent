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
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { argv as processArgv } from "node:process";

const selfPath = realpathSync(fileURLToPath(import.meta.url));
const repoRoot = join(dirname(selfPath), "..");
const packagesDir = join(repoRoot, "packages");
const argentManifestPath = join(packagesDir, "argent", "package.json");
const serverJsonPath = join(repoRoot, "server.json");

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

  if (failed) process.exit(1);

  console.log(`All workspace packages and server.json are at ${argentPkg.version}.`);
}

// Run only when invoked directly, not when imported by the test. Both sides are
// realpath'd: node realpaths the main module before setting import.meta.url but
// leaves process.argv[1] as typed, so comparing them raw makes a path through a
// symlink skip main() and exit 0 with no output — a silent pass.
if (processArgv[1] && realpathSync(processArgv[1]) === selfPath) {
  main();
}
