#!/usr/bin/env node
/**
 * Compute the version for a canary prerelease published on every push to main:
 *
 *   <patch-bump of the highest STABLE published version>-next.<counter>
 *
 * e.g. with latest=0.13.0 and no canaries yet → `0.13.1-next.0`.
 *
 * Why patch-bump-of-stable: each main build is a preview of the next patch
 * release. A prerelease of 0.13.1 still outranks the 0.13.0 release by SemVer
 * precedence, so `next` always lands strictly above `latest`, while staying
 * below the eventual 0.13.1 stable.
 *
 * The counter resets per base: it's the next index after the highest
 * `<base>-next.<k>` already on npm, or 0 if this base has no canaries yet. So
 * each new patch line starts at `.0` and increments per publish:
 *   0.13.1-next.0, 0.13.1-next.1, ...  then 0.13.1 ships stable  ...
 *   0.13.2-next.0, 0.13.2-next.1, ...
 * Deriving the counter from the registry (rather than a global CI counter)
 * means publishes MUST be serialized — see the `concurrency` group in
 * publish-next.yml — or two racing reads could pick the same index and collide.
 *
 * Zero npm dependencies (runs in a lightweight CI job without `npm ci`); the
 * SemVer helpers are shared with sync-next-dist-tag.mjs.
 *
 * Usage: node scripts/next-canary-version.mjs
 */

import { execFileSync } from "node:child_process";
import { argv as processArgv } from "node:process";
import { pathToFileURL } from "node:url";
import { compareSemver, parseSemver } from "./sync-next-dist-tag.mjs";

const PACKAGE = "@swmansion/argent";

/**
 * Pure version math, separated from npm I/O so it can be unit-tested.
 * @param {string[]} versions  published versions (unparseable entries ignored)
 * @returns {string} the canary version, e.g. "0.13.1-next.0"
 */
export function computeCanaryVersion(versions) {
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

  // Counter resets per base: next index after the highest existing
  // `<base>-next.<k>`, or 0 if this base has no canaries yet.
  let counter = 0;
  for (const v of valid) {
    const { main: m, pre } = parseSemver(v);
    const sameBase = m[0] === base[0] && m[1] === base[1] && m[2] === base[2];
    if (sameBase && pre.length === 2 && pre[0] === "next" && /^\d+$/.test(pre[1])) {
      counter = Math.max(counter, Number(pre[1]) + 1);
    }
  }

  return `${base[0]}.${base[1]}.${base[2]}-next.${counter}`;
}

function main() {
  const raw = JSON.parse(
    execFileSync("npm", ["view", PACKAGE, "versions", "--json"], { encoding: "utf8" })
  );
  // npm returns a bare string when a package has exactly one published version.
  const versions = Array.isArray(raw) ? raw : [raw];
  process.stdout.write(computeCanaryVersion(versions) + "\n");
}

// Run only when invoked directly, not when imported by the test.
if (processArgv[1] && import.meta.url === pathToFileURL(processArgv[1]).href) {
  main();
}
