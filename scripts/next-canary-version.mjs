#!/usr/bin/env node
/**
 * Compute the version for a canary prerelease published on every push to main:
 *
 *   <patch-bump of the highest STABLE published version>-next.<counter>
 *
 * e.g. with latest=0.13.0 and counter=41 → `0.13.1-next.41`.
 *
 * Why patch-bump-of-stable: each main build is a preview of the next patch
 * release. A prerelease of 0.13.1 still outranks the 0.13.0 release by SemVer
 * precedence, so `next` always lands strictly above `latest`, while staying
 * below the eventual 0.13.1 stable. `counter` is the CI run number, so the
 * versions increase monotonically across pushes and never collide on npm.
 *
 * Zero npm dependencies (runs in a lightweight CI job without `npm ci`); the
 * SemVer helpers are shared with sync-next-dist-tag.mjs.
 *
 * Usage:
 *   node scripts/next-canary-version.mjs <counter>
 *     counter  prerelease counter (defaults to $GITHUB_RUN_NUMBER)
 */

import { execFileSync } from "node:child_process";
import { argv as processArgv, env } from "node:process";
import { pathToFileURL } from "node:url";
import { compareSemver, parseSemver } from "./sync-next-dist-tag.mjs";

const PACKAGE = "@swmansion/argent";

/**
 * Pure version math, separated from npm I/O so it can be unit-tested.
 * @param {string[]} versions  published versions (unparseable entries ignored)
 * @param {string|number} counter  prerelease counter (the CI run number)
 * @returns {string} the canary version, e.g. "0.13.1-next.41"
 */
export function computeCanaryVersion(versions, counter) {
  if (!/^\d+$/.test(String(counter))) {
    throw new Error(`counter must be a non-negative integer, got: ${counter}`);
  }
  const valid = versions.filter((v) => parseSemver(v) !== null);
  if (valid.length === 0) {
    throw new Error("no parseable published versions found");
  }

  const stable = valid.filter((v) => parseSemver(v).pre.length === 0);
  // Prefer the highest stable release and bump its patch. With no stable
  // release yet, preview the highest prerelease's own target version (no bump).
  const pool = stable.length > 0 ? stable : valid;
  const { main } = parseSemver(pool.slice().sort((a, b) => compareSemver(b, a))[0]);
  const [major, minor, patch] = main;
  const base = stable.length > 0 ? [major, minor, patch + 1] : [major, minor, patch];

  return `${base[0]}.${base[1]}.${base[2]}-next.${counter}`;
}

function main() {
  const counter = String(processArgv[2] ?? env.GITHUB_RUN_NUMBER ?? "").trim();
  const raw = JSON.parse(
    execFileSync("npm", ["view", PACKAGE, "versions", "--json"], { encoding: "utf8" })
  );
  // npm returns a bare string when a package has exactly one published version.
  const versions = Array.isArray(raw) ? raw : [raw];
  process.stdout.write(computeCanaryVersion(versions, counter) + "\n");
}

// Run only when invoked directly, not when imported by the test.
if (processArgv[1] && import.meta.url === pathToFileURL(processArgv[1]).href) {
  main();
}
