/**
 * Pins the cross-file links a registry publish depends on: server.json's version
 * and the npm coordinates it names have to match the workspace, and the ownership
 * proof (mcpName on the published tarball) has to be present on both sides.
 *
 * Run: node --test scripts/check-workspace-versions.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { serverJsonMismatches } from "./check-workspace-versions.mjs";

const VERSION = "0.18.0";
const ARGENT_PKG = { name: "@swmansion/argent", mcpName: "io.github.software-mansion/argent" };
const SERVER = {
  name: "io.github.software-mansion/argent",
  version: VERSION,
  packages: [{ identifier: "@swmansion/argent", version: VERSION }],
};

/** @param {(s: typeof SERVER) => void} mutate */
function server(mutate) {
  const copy = structuredClone(SERVER);
  mutate(copy);
  return copy;
}

test("an in-sync pair reports nothing", () => {
  assert.deepEqual(serverJsonMismatches(VERSION, ARGENT_PKG, SERVER), []);
});

test("server.json version drifting from the workspace is caught", () => {
  const problems = serverJsonMismatches(
    VERSION,
    ARGENT_PKG,
    server((s) => (s.version = "0.17.0"))
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /server\.json version is 0\.17\.0, workspace is 0\.18\.0/);
});

test("a packages[] version npm has never seen is caught", () => {
  const problems = serverJsonMismatches(
    VERSION,
    ARGENT_PKG,
    server((s) => (s.packages[0].version = "9.9.9"))
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /packages\[0\]\.version is 9\.9\.9/);
});

test("a packages[] identifier that is not the published package is caught", () => {
  const problems = serverJsonMismatches(
    VERSION,
    ARGENT_PKG,
    server((s) => (s.packages[0].identifier = "@swmansion/argnet"))
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /packages\[0\]\.identifier \(@swmansion\/argnet\)/);
});

test("a name that no longer matches mcpName is caught", () => {
  const problems = serverJsonMismatches(
    VERSION,
    ARGENT_PKG,
    server((s) => (s.name = "com.swmansion/argent"))
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /server\.json name \(com\.swmansion\/argent\)/);
});

test("dropping mcpName is caught even though server.json still names it", () => {
  const problems = serverJsonMismatches(VERSION, { name: ARGENT_PKG.name }, SERVER);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has no mcpName/);
});

// Both sides absent compares equal by ===, so the presence check is what catches
// it — the publish would be rejected for an unproven namespace.
test("dropping mcpName and the server.json name together is still caught", () => {
  const problems = serverJsonMismatches(
    VERSION,
    { name: ARGENT_PKG.name },
    server((s) => delete s.name)
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has no mcpName/);
});

test("a server.json with no packages at all is caught", () => {
  for (const emptied of [server((s) => delete s.packages), server((s) => (s.packages = []))]) {
    const problems = serverJsonMismatches(VERSION, ARGENT_PKG, emptied);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /lists no packages/);
  }
});

test("every problem is reported at once, not just the first", () => {
  const problems = serverJsonMismatches(
    VERSION,
    ARGENT_PKG,
    server((s) => {
      s.version = "0.17.0";
      s.name = "com.swmansion/argent";
      s.packages[0].version = "0.17.0";
      s.packages[0].identifier = "argent";
    })
  );
  assert.equal(problems.length, 4);
});
