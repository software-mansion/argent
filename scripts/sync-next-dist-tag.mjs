#!/usr/bin/env node
/**
 * Re-point the `next` npm dist-tag at the highest published version of
 * @swmansion/argent — whether that highest version is a prerelease or a
 * stable release.
 *
 * Why this exists: `npm publish` (stable) only moves `latest`, and
 * `npm publish --tag next` only moves `next` when a *prerelease* is shipped.
 * So once a prerelease was tagged `next`, every later stable release left
 * `next` frozen on an old prerelease (e.g. next=0.7.0-next.4 while
 * latest=0.11.0). Running this after every publish makes `next` self-heal to
 * the true maximum, so users who track `next` always get the newest build.
 *
 * Idempotent: if `next` already points at the maximum, it does nothing.
 *
 * Usage:
 *   node scripts/sync-next-dist-tag.mjs [package] [--dry-run]
 *     package    npm package name (default: @swmansion/argent)
 *     --dry-run  compute and report, but do not mutate the dist-tag
 *                (also honoured via DRY_RUN=1). `npm dist-tag add` needs auth;
 *                use --dry-run to exercise the logic without NODE_AUTH_TOKEN.
 */

import { execFileSync } from "node:child_process";
import { argv as processArgv, env } from "node:process";
import { pathToFileURL } from "node:url";

const TAG = "next";

// --- SemVer 2.0.0 precedence (build metadata ignored) ------------------------
// Self-contained so this script has zero npm dependencies: it must run in a
// lightweight CI job without `npm ci`. Verified against the `semver` library in
// scripts/sync-next-dist-tag.test.mjs.

export function parseSemver(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(version).trim()
  );
  if (!m) return null;
  return {
    main: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

function compareIdentifiers(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b)); // numeric: compare value
  if (an) return -1; // numeric identifiers rank lower than alphanumeric
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0; // alphanumeric: ASCII order
}

/** Returns <0 if va < vb, 0 if equal, >0 if va > vb. */
export function compareSemver(va, vb) {
  const a = parseSemver(va);
  const b = parseSemver(vb);
  for (let i = 0; i < 3; i++) {
    if (a.main[i] !== b.main[i]) return Math.sign(a.main[i] - b.main[i]);
  }
  // A prerelease has lower precedence than the associated normal version.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const len = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const c = compareIdentifiers(a.pre[i], b.pre[i]);
    if (c !== 0) return c;
  }
  // All shared identifiers equal: the longer set of fields has higher precedence.
  return Math.sign(a.pre.length - b.pre.length);
}

/**
 * Decide whether `next` should be re-pointed at `max`. Only ever *advances*:
 * returns true iff `max` is strictly newer than the current tag, or the current
 * tag is unset/unparseable.
 *
 * This never moves `next` backward. The post-publish sync can momentarily read a
 * stale (CDN-cached) packument that omits the version just published — so the
 * computed `max` can lag behind the freshly-tagged release. A plain
 * `current === max` check would then re-point `next` at the older `max`,
 * demoting the new build. Requiring a strict advance keeps the sync idempotent
 * and self-healing without that regression.
 */
export function shouldAdvanceTag(max, current) {
  if (current === undefined || current === null) return true;
  if (parseSemver(current) === null) return true;
  return compareSemver(max, current) > 0;
}

// --- npm registry I/O --------------------------------------------------------

function npmJson(args) {
  const out = execFileSync("npm", [...args, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out);
}

function getVersions(name) {
  const raw = npmJson(["view", name, "versions"]);
  // npm returns a bare string when a package has exactly one published version.
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((v) => parseSemver(v) !== null);
}

function getDistTags(name) {
  try {
    return npmJson(["view", name, "dist-tags"]);
  } catch {
    return {};
  }
}

// --- main --------------------------------------------------------------------

function main() {
  const argv = processArgv.slice(2);
  const dryRun = argv.includes("--dry-run") || env.DRY_RUN === "1";
  // First real package-name arg. Skip flags (anything starting with "-", so a
  // stray "-x" isn't handed to npm as a flag) and blank tokens (an empty/
  // whitespace arg must NOT become the package name — `npm view ""` silently
  // resolves to the squatted "undefined" package rather than erroring). When no
  // usable arg is present we fall back to the scoped default below.
  const pkg = argv.find((a) => a.trim() !== "" && !a.startsWith("-")) ?? "@swmansion/argent";

  const versions = getVersions(pkg);
  if (versions.length === 0) {
    console.log(`No published versions found for ${pkg}; nothing to do.`);
    return;
  }

  // Highest version overall, prerelease or stable.
  const max = versions.slice().sort((x, y) => compareSemver(y, x))[0];
  const current = getDistTags(pkg)[TAG];

  console.log(`Package:        ${pkg}`);
  console.log(`Highest version: ${max}`);
  console.log(`Current '${TAG}':   ${current ?? "(unset)"}`);

  if (!shouldAdvanceTag(max, current)) {
    console.log(
      `'${TAG}' (${current}) is already at or ahead of the highest published version (${max}); nothing to do.`
    );
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] would run: npm dist-tag add ${pkg}@${max} ${TAG}`);
    return;
  }

  console.log(`Updating '${TAG}': ${current ?? "(unset)"} -> ${max}`);
  execFileSync("npm", ["dist-tag", "add", `${pkg}@${max}`, TAG], {
    stdio: "inherit",
  });
  console.log(`Done. '${TAG}' now points at ${max}.`);
}

// Run only when invoked directly, not when imported by the test.
if (processArgv[1] && import.meta.url === pathToFileURL(processArgv[1]).href) {
  main();
}
