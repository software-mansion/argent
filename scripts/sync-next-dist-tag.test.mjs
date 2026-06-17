/**
 * Proves the dependency-free SemVer comparator in sync-next-dist-tag.mjs orders
 * versions identically to the `semver` library. `semver` is a dev/transitive
 * dependency used only by this test — the script itself stays dependency-free.
 *
 * Run: node --test scripts/sync-next-dist-tag.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import semver from "semver";

import { compareSemver } from "./sync-next-dist-tag.mjs";

// Real published history of @swmansion/argent plus tricky prerelease cases that
// exercise every branch of SemVer precedence (numeric-vs-alphanumeric ids,
// field-count tiebreak, prerelease-vs-release, build metadata).
const VERSIONS = [
  "0.5.1",
  "0.5.2",
  "0.5.3",
  "0.6.0-next.1",
  "0.6.0-next.2",
  "0.6.0-next.10",
  "0.6.0",
  "0.6.1",
  "0.7.0-next.4",
  "0.7.0-alpha.1",
  "0.7.0-beta",
  "0.7.0-rc.1",
  "0.7.0",
  "0.7.1",
  "0.8.0",
  "1.0.0-next.0",
  "1.0.0+build.5",
  "1.0.0",
  "0.11.0",
];

test("compareSemver agrees with semver.compare for every pair", () => {
  for (const a of VERSIONS) {
    for (const b of VERSIONS) {
      assert.equal(
        Math.sign(compareSemver(a, b)),
        semver.compare(a, b),
        `mismatch comparing ${a} vs ${b}`
      );
    }
  }
});

test("max-by-compareSemver equals max-by-semver", () => {
  const mineMax = VERSIONS.slice().sort((x, y) => compareSemver(y, x))[0];
  const semverMax = VERSIONS.slice().sort(semver.rcompare)[0];
  assert.equal(mineMax, semverMax);
});

test("prerelease ranks below its release; numeric id below alphanumeric", () => {
  assert.ok(compareSemver("1.0.0-next.0", "1.0.0") < 0);
  assert.ok(compareSemver("1.0.0-next.0", "1.0.0-next.alpha") < 0);
  assert.ok(compareSemver("0.6.0-next.2", "0.6.0-next.10") < 0); // numeric, not lexical
});
