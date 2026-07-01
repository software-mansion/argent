import { test } from "node:test";
import assert from "node:assert/strict";

import { computeCanaryVersion } from "./next-canary-version.mjs";

test("first canary of a new base starts at 0", () => {
  assert.equal(computeCanaryVersion(["0.12.0", "0.12.1", "0.13.0"]), "0.13.1-next.0");
});

test("increments the counter within the same base", () => {
  assert.equal(computeCanaryVersion(["0.13.0", "0.13.1-next.0", "0.13.1-next.1"]), "0.13.1-next.2");
});

test("resets to 0 when the base advances (a new stable shipped)", () => {
  // 0.13.1 is now stable; its old 0.13.1-next.* belong to a finished line.
  assert.equal(
    computeCanaryVersion(["0.13.0", "0.13.1-next.0", "0.13.1-next.1", "0.13.1"]),
    "0.13.2-next.0"
  );
});

test("continues after the highest existing next.k (tolerates gaps)", () => {
  assert.equal(computeCanaryVersion(["0.13.0", "0.13.1-next.0", "0.13.1-next.5"]), "0.13.1-next.6");
});

test("counts manual-dispatch canaries of the same base too", () => {
  assert.equal(computeCanaryVersion(["0.13.0", "0.13.1-next.3"]), "0.13.1-next.4");
});

test("ignores non-next prereleases of the same base", () => {
  assert.equal(computeCanaryVersion(["0.13.0", "0.13.1-beta.9", "0.13.1-next.0"]), "0.13.1-next.1");
});

test("no stable yet: continues the highest prerelease's lineage", () => {
  assert.equal(computeCanaryVersion(["0.1.0-next.0", "0.1.0-next.5"]), "0.1.0-next.6");
});

test("skips unparseable versions", () => {
  assert.equal(computeCanaryVersion(["garbage", "1.2.3", ""]), "1.2.4-next.0");
});

test("throws when there are no parseable versions", () => {
  assert.throws(() => computeCanaryVersion(["", "x"]), /no parseable/);
});
