#!/usr/bin/env node
// Fails if the workspace packages under packages/* don't all share the same
// version. Keeps the monorepo's lockstep versioning from silently drifting when
// a release bump misses a package.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages");

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

if (byVersion.size <= 1) {
  const [version] = byVersion.keys();
  console.log(`All workspace packages are at ${version ?? "(no versioned packages found)"}.`);
  process.exit(0);
}

console.error("Workspace package versions are out of sync:");
for (const [version, names] of [...byVersion].sort()) {
  console.error(`  ${version}: ${names.sort().join(", ")}`);
}
console.error(
  "\nEvery package under packages/* must share one version. Bump the outliers to match."
);
process.exit(1);
