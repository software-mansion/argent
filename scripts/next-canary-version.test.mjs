import { test } from "node:test";
import assert from "node:assert/strict";

import { computeCanaryVersion } from "./next-canary-version.mjs";

test("patch-bumps the highest stable release and appends the counter", () => {
  assert.equal(computeCanaryVersion(["0.12.0", "0.12.1", "0.13.0"], "41"), "0.13.1-next.41");
});

test("bases on the highest STABLE version, ignoring higher prereleases", () => {
  // 0.13.1-next.3 is already published, but the base is still the next patch
  // after the latest *stable* (0.13.0) — and 0.13.1-next.42 > 0.13.1-next.3.
  assert.equal(
    computeCanaryVersion(["0.13.0", "0.13.1-next.3", "0.7.0-next.4"], "42"),
    "0.13.1-next.42"
  );
});

test("falls back to the highest prerelease's target when no stable exists", () => {
  assert.equal(computeCanaryVersion(["0.1.0-next.0", "0.1.0-next.5"], "9"), "0.1.0-next.9");
});

test("skips unparseable versions", () => {
  assert.equal(computeCanaryVersion(["garbage", "1.2.3", ""], "7"), "1.2.4-next.7");
});

test("accepts a numeric counter", () => {
  assert.equal(computeCanaryVersion(["1.0.0"], 7), "1.0.1-next.7");
});

test("rejects a non-numeric counter", () => {
  assert.throws(() => computeCanaryVersion(["1.0.0"], "abc"), /counter/);
});

test("throws when there are no parseable versions", () => {
  assert.throws(() => computeCanaryVersion(["", "x"], "1"), /no parseable/);
});
