#!/usr/bin/env node
// Fails if the workspace packages under packages/* don't all share the same
// version. Keeps the monorepo's lockstep versioning from silently drifting when
// a release bump misses a package.
//
// The root server.json (the MCP registry manifest) is held to the same version
// and cross-checked against packages/argent/package.json. It lives outside
// packages/*, so a release bump does not touch it; the registry rejects a
// publish whose `packages[].version` names a version npm has never seen, and
// rejects one whose `name` doesn't match the npm package's `mcpName`.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "packages");

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

const mismatches = [];
if (server.version !== workspaceVersion) {
  mismatches.push(`server.json version is ${server.version}, workspace is ${workspaceVersion}`);
}
if (server.name !== argentPkg.mcpName) {
  mismatches.push(
    `server.json name (${server.name}) != packages/argent/package.json mcpName (${argentPkg.mcpName})`
  );
}
for (const [i, pkg] of (server.packages ?? []).entries()) {
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

if (mismatches.length > 0) {
  console.error("server.json is out of sync with the workspace:");
  for (const line of mismatches) console.error(`  ${line}`);
  console.error(
    "\nserver.json is not under packages/*, so a release bump misses it — keep it in step\n" +
      "with packages/argent/package.json by hand."
  );
  process.exit(1);
}

// An empty packages/ can't reach here: reading packages/argent/package.json above
// throws first, so workspaceVersion is always a real version by this point.
console.log(`All workspace packages and server.json are at ${workspaceVersion}.`);
