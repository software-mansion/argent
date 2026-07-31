#!/usr/bin/env node
// Fails if the workspace packages under packages/* don't all share the same
// version. Keeps the monorepo's lockstep versioning from silently drifting when
// a release bump misses a package.
//
// The root server.json (the MCP registry manifest) is held to that same version
// and to the npm coordinates in packages/argent/package.json. It is checked here
// because it is the one such file outside packages/*, so a bump that sweeps the
// workspace leaves it behind — and the registry then rejects the publish, either
// because `packages[].version` names a version npm has never seen or because
// `name` doesn't match the tarball's `mcpName`.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { argv as processArgv } from "node:process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "packages");

/**
 * Everything server.json has to keep in step with the workspace, as one
 * human-readable line per problem. Pure, separated from the fs reads so it can
 * be unit-tested.
 * @param {string | undefined} workspaceVersion the single version every packages/* manifest carries
 * @param {{ name?: string, mcpName?: string }} argentPkg packages/argent/package.json
 * @param {{ name?: string, version?: string, packages?: { identifier?: string, version?: string }[] }} server server.json
 * @returns {string[]} empty when in sync
 */
export function serverJsonMismatches(workspaceVersion, argentPkg, server) {
  const mismatches = [];

  if (server.version !== workspaceVersion) {
    mismatches.push(`server.json version is ${server.version}, workspace is ${workspaceVersion}`);
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

  const packages = server.packages ?? [];
  if (packages.length === 0) {
    mismatches.push(
      "server.json lists no packages — the registry entry would name nothing to install"
    );
  }
  for (const [i, pkg] of packages.entries()) {
    if (pkg.version !== workspaceVersion) {
      mismatches.push(
        `server.json packages[${i}].version is ${pkg.version}, workspace is ${workspaceVersion}`
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

function main() {
  const byVersion = new Map(); // version -> package names
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(packagesDir, entry.name, "package.json"), "utf8"));
    } catch {
      continue; // directory without a package.json
    }
    if (!manifest.version) continue;
    const names = byVersion.get(manifest.version) ?? [];
    names.push(manifest.name ?? entry.name);
    byVersion.set(manifest.version, names);
  }

  if (byVersion.size > 1) {
    console.error("Workspace package versions are out of sync:");
    for (const [version, names] of [...byVersion].sort()) {
      console.error(`  ${version}: ${names.sort().join(", ")}`);
    }
    console.error(
      "\nEvery package under packages/* must share one version. Bump the outliers to match."
    );
    process.exit(1);
  }

  const [workspaceVersion] = byVersion.keys();

  const argentPkg = JSON.parse(readFileSync(join(packagesDir, "argent", "package.json"), "utf8"));
  const server = JSON.parse(readFileSync(join(repoRoot, "server.json"), "utf8"));

  const mismatches = serverJsonMismatches(workspaceVersion, argentPkg, server);
  if (mismatches.length > 0) {
    console.error("server.json is out of sync with the workspace:");
    for (const line of mismatches) console.error(`  ${line}`);
    console.error(
      "\nserver.json is not under packages/*, so a workspace bump leaves it behind — edit it\n" +
        "by hand to match packages/argent/package.json."
    );
    process.exit(1);
  }

  // An empty packages/ can't reach here: reading packages/argent/package.json above
  // throws first, so workspaceVersion is always a real version by this point.
  console.log(`All workspace packages and server.json are at ${workspaceVersion}.`);
}

// Run only when invoked directly, not when imported by the test.
if (processArgv[1] && import.meta.url === pathToFileURL(processArgv[1]).href) {
  main();
}
