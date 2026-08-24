#!/usr/bin/env node
// Fails if the packages under packages/* don't all share one version, or if the
// root server.json (the MCP registry manifest) has drifted from the version and
// npm coordinates of packages/argent, the package it points at. server.json is
// checked here because it is the one such file outside packages/*, so a workspace
// bump leaves it behind and the registry then rejects the publish.
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { argv as processArgv } from "node:process";

const selfPath = realpathSync(fileURLToPath(import.meta.url));
const repoRoot = join(dirname(selfPath), "..");
const packagesDir = join(repoRoot, "packages");
const argentManifestPath = join(packagesDir, "argent", "package.json");
const serverJsonPath = join(repoRoot, "server.json");

// Not workspace members, so not part of the lockstep versioning: the docs site is
// excluded from the root `workspaces` glob (it keeps its own lockfile) and carries
// a standalone version that must not be read as drift.
const NON_WORKSPACE_DIRS = new Set(["docs"]);

/**
 * Everything server.json has to keep in step with the npm package it points at,
 * one line per problem. Kept free of fs reads so it can be unit-tested.
 * @param {string | undefined} publishedVersion the version packages/argent/package.json carries
 * @param {{ name?: string, mcpName?: string }} argentPkg packages/argent/package.json
 * @param {{ name?: string, version?: string, packages?: { identifier?: string, version?: string }[] }} server server.json
 * @returns {string[]} empty when in sync
 */
export function serverJsonMismatches(publishedVersion, argentPkg, server) {
  const mismatches = [];

  // Without it every comparison below would pass by matching undefined against
  // undefined, so its absence is a mismatch in its own right.
  if (!publishedVersion) {
    mismatches.push(
      "packages/argent/package.json has no version — nothing for server.json to be checked against"
    );
  } else if (server.version !== publishedVersion) {
    mismatches.push(
      `server.json version is ${server.version}, packages/argent/package.json is ${publishedVersion}`
    );
  }

  // mcpName on the published tarball is what proves to the registry that the
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

  // Every packages[].identifier below is compared against this name, so without it
  // those comparisons pass on undefined === undefined.
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
    // `null` would throw out of the loop; a scalar or an array reads as undefined
    // on every field and would be reported as a pile of missing values rather than
    // the wrong shape it is.
    if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
      const shape = pkg === null ? "null" : Array.isArray(pkg) ? "an array" : typeof pkg;
      mismatches.push(
        `server.json packages[${i}] is ${shape}, not an object naming a registry and identifier`
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
 * instead of a raw stack trace.
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

  // A scalar, null or an array parses cleanly and then either throws or compares
  // equal to undefined on every field read. Both callers want an object.
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
  // readdir order is filesystem-dependent; sorted so a scan that exits on a bad
  // manifest stops at the same package on every machine.
  const entries = readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (NON_WORKSPACE_DIRS.has(entry.name)) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      // No package.json at all means the directory is not a workspace package —
      // an unchecked-out submodule, a stray build directory. A manifest that is
      // there but unusable is different: skipping it would drop a real package
      // out of the comparison and pass a workspace that drifted.
      if (error.code === "ENOENT") continue;
      console.error(`Cannot read packages/${entry.name}/package.json: ${error.message}`);
      console.error(
        `\nIt is tracked in git — restore it with \`git checkout -- ${relative(repoRoot, manifestPath)}\`.`
      );
      process.exit(1);
    }
    // `?.` would mask a manifest that parses to `null`, a bare scalar or an array:
    // there but unusable, and none of them reach the catch above. Dropping one
    // would take a real package out of the lockstep comparison.
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      const shape =
        manifest === null ? "null" : Array.isArray(manifest) ? "an array" : typeof manifest;
      console.error(`packages/${entry.name}/package.json is ${shape}, not a JSON object`);
      console.error(
        `\nIt is tracked in git — restore it with \`git checkout -- ${relative(repoRoot, manifestPath)}\`.`
      );
      process.exit(1);
    }
    if (!manifest.version) continue;
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
  // though — a missing version is caught as a mismatch below.
  const argentPkg = readTrackedJson(argentManifestPath);
  const server = readTrackedJson(serverJsonPath);

  // Reported even when packages/* already disagree, so a half-finished bump
  // surfaces every remaining edit in one run.
  const mismatches = serverJsonMismatches(argentPkg.version, argentPkg, server);
  if (mismatches.length > 0) {
    console.error("server.json is out of sync with packages/argent/package.json:");
    for (const line of mismatches) console.error(`  ${line}`);
    console.error(
      "\nEvery line above starts with the file to edit. server.json is usually the one:\n" +
        "it is not under packages/*, so a workspace bump sweeps past and leaves it behind."
    );
    failed = true;
  }

  if (failed) process.exit(1);

  console.log(`All workspace packages and server.json are at ${argentPkg.version}.`);
}

// Run only when invoked directly, not when imported by the test. Both sides are
// realpath'd: node realpaths the main module before setting import.meta.url but
// leaves process.argv[1] as typed, so comparing them raw makes a path through a
// symlink skip main() and exit 0 with no output.
if (processArgv[1] && realpathSync(processArgv[1]) === selfPath) {
  main();
}
