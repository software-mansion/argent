/**
 * Pins the cross-file links a registry publish depends on: server.json's version
 * and the npm coordinates it names have to match the workspace, and the ownership
 * proof (mcpName on the published tarball) has to be present on both sides.
 *
 * Two layers, because the pure function is not what CI runs: unit tests over
 * serverJsonMismatches(), then spawned runs of the real script against a
 * miniature repo, which are the only thing that pins main() — its exit codes,
 * its output and the guard deciding whether it runs at all.
 *
 * Run: node --test scripts/check-workspace-versions.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

test("server.json version drifting from the workspace names both versions", () => {
  const problems = serverJsonMismatches(
    VERSION,
    ARGENT_PKG,
    server((s) => (s.version = "0.17.0"))
  );
  assert.deepEqual(problems, [
    "server.json version is 0.17.0, packages/argent/package.json is 0.18.0",
  ]);
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

// Only packages[0] exists today, so nothing else here would notice a check that
// silently stopped after the first entry — which becomes live the moment a
// second distribution channel is added.
test("every packages[] entry is validated, not just the first", () => {
  const problems = serverJsonMismatches(
    VERSION,
    ARGENT_PKG,
    server((s) => s.packages.push({ identifier: "@attacker/pkg", version: "6.6.6" }))
  );
  assert.deepEqual(problems, [
    "server.json packages[1].version is 6.6.6, packages/argent/package.json is 0.18.0",
    "server.json packages[1].identifier (@attacker/pkg) != published package name (@swmansion/argent)",
  ]);
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

// The object form is what a hand-edit that drops the brackets produces. It has no
// .entries(), so catching it here is what keeps the loop below from throwing.
test("a server.json with no usable packages array is caught", () => {
  const unusable = [
    server((s) => delete s.packages),
    server((s) => (s.packages = [])),
    server(
      (s) =>
        (s.packages = /** @type {any} */ ({ identifier: "@swmansion/argent", version: VERSION }))
    ),
  ];
  for (const emptied of unusable) {
    const problems = serverJsonMismatches(VERSION, ARGENT_PKG, emptied);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no packages array/);
  }
});

// The name half of the same shape: with neither side naming a package, the
// identifier comparison is undefined === undefined and server.json passes while
// pointing at nothing installable.
test("a packages/argent manifest with no name is caught", () => {
  const problems = serverJsonMismatches(
    VERSION,
    { mcpName: ARGENT_PKG.mcpName },
    server((s) => delete s.packages[0].identifier)
  );
  assert.deepEqual(problems, [
    "packages/argent/package.json has no name — server.json's identifier has nothing to point at",
  ]);
});

// packages/argent/package.json is the sole source of the version everything else
// is compared against, so losing it turns every comparison below into
// undefined === undefined and the whole check passes vacuously.
test("a packages/argent manifest with no version is caught", () => {
  const problems = serverJsonMismatches(undefined, ARGENT_PKG, SERVER);
  assert.deepEqual(problems, [
    "packages/argent/package.json has no version — nothing for server.json to be checked against",
    "server.json packages[0].version is 0.18.0, packages/argent/package.json is undefined",
  ]);
});

// A hand-edit that empties an entry rather than the array leaves the array shape
// intact, so the check above passes it through to the loop that reads .version
// off it.
test("a packages[] entry that is not an object is caught", () => {
  for (const [entry, shown] of [
    [null, "null"],
    ["@swmansion/argent", "string"],
    // typeof [] === "object", so an array only fails the shape check if it is
    // tested for separately.
    [["@swmansion/argent", VERSION], "an array"],
  ]) {
    const problems = serverJsonMismatches(
      VERSION,
      ARGENT_PKG,
      server((s) => (s.packages = [/** @type {any} */ (entry)]))
    );
    assert.deepEqual(problems, [
      `server.json packages[0] is ${shown}, not an object naming a registry and identifier`,
    ]);
  }
});

// Reporting the bad entry must not cost the entries after it, or one stray null
// would quietly shrink the report the sibling test above relies on being complete.
test("a non-object packages[] entry does not stop the entries after it", () => {
  const problems = serverJsonMismatches(
    VERSION,
    ARGENT_PKG,
    server(
      (s) =>
        (s.packages = [
          /** @type {any} */ (null),
          { identifier: "@attacker/pkg", version: "6.6.6" },
        ])
    )
  );
  assert.deepEqual(problems, [
    "server.json packages[0] is null, not an object naming a registry and identifier",
    "server.json packages[1].version is 6.6.6, packages/argent/package.json is 0.18.0",
    "server.json packages[1].identifier (@attacker/pkg) != published package name (@swmansion/argent)",
  ]);
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

// --- the real script, spawned -----------------------------------------------
// main() is what repo-hygiene.yml runs and none of the above touches it, so a
// fail-open edit there (an exit(0) on the failure path, a guard that skips
// main() altogether) would pass every other check in the repo. These run the
// script for real against a throwaway repo and assert on exit codes.

const SCRIPT_PATH = fileURLToPath(new URL("./check-workspace-versions.mjs", import.meta.url));

/**
 * A miniature repo: a copy of the real script, two packages/* manifests and a
 * server.json. Realpath'd so the tests below isolate the behaviour they name —
 * macOS's own tmpdir is behind a /var -> /private/var symlink, which the
 * symlink test then reintroduces deliberately.
 * @param {import("node:test").TestContext} t
 * @param {{ argentVersion?: string | null, otherVersion?: string, serverJson?: unknown,
 *   argentManifest?: unknown, extraPackages?: Record<string, unknown> }} [options]
 *   serverJson: an object to write as JSON, a string to write verbatim, or null
 *   to leave the file out entirely. argentVersion: null omits the version key.
 *   argentManifest: replaces packages/argent/package.json wholesale, same
 *   object/string/null convention, and overrides argentVersion.
 *   extraPackages: further packages/<dir> entries, a null value creating the
 *   directory with no package.json in it.
 * @returns {string} the repo root
 */
function fixtureRepo(
  t,
  {
    argentVersion = VERSION,
    otherVersion = VERSION,
    serverJson,
    argentManifest,
    extraPackages = {},
  } = {}
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "check-workspace-versions-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "packages", "argent"), { recursive: true });
  mkdirSync(join(root, "packages", "registry"), { recursive: true });
  copyFileSync(SCRIPT_PATH, join(root, "scripts", "check-workspace-versions.mjs"));

  const write = (/** @type {string} */ path, /** @type {unknown} */ value) =>
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));

  if (argentManifest === undefined) {
    write(join(root, "packages", "argent", "package.json"), {
      ...ARGENT_PKG,
      ...(argentVersion === null ? {} : { version: argentVersion }),
    });
  } else if (argentManifest !== null) {
    write(join(root, "packages", "argent", "package.json"), argentManifest);
  }
  write(join(root, "packages", "registry", "package.json"), {
    name: "@argent/registry",
    version: otherVersion,
  });
  for (const [dir, manifest] of Object.entries(extraPackages)) {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    if (manifest !== null) write(join(root, "packages", dir, "package.json"), manifest);
  }
  if (serverJson !== null) write(join(root, "server.json"), serverJson ?? SERVER);

  return root;
}

/** @param {string} root the path to invoke through, which need not be the real one */
function runScript(root) {
  return spawnSync(process.execPath, [join(root, "scripts", "check-workspace-versions.mjs")], {
    encoding: "utf8",
  });
}

/** @param {string} stderr */
function assertNoStackTrace(stderr) {
  assert.doesNotMatch(stderr, /^\s+at /m, `expected guidance, got a stack trace:\n${stderr}`);
}

test("[script] an in-sync repo passes quietly", (t) => {
  const result = runScript(fixtureRepo(t));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /All workspace packages and server\.json are at 0\.18\.0\./);
});

test("[script] server.json drift alone exits 1", (t) => {
  const root = fixtureRepo(t, {
    serverJson: server((s) => {
      s.version = "0.17.0";
      s.packages[0].version = "0.17.0";
    }),
  });
  const result = runScript(root);
  assert.equal(result.status, 1, `expected a failure, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /server\.json version is 0\.17\.0/);
  assert.match(result.stderr, /server\.json packages\[0\]\.version is 0\.17\.0/);
  assert.match(result.stderr, /Every line above starts with the file to edit\./);
});

// The check the script existed for before this PR. The fixture leaves server.json
// agreeing with packages/argent, so workspace drift is the only thing that can
// produce the exit code — that is what makes it pin this branch rather than the
// server.json one every other failing [script] test also trips.
test("[script] packages/* drift alone exits 1", (t) => {
  const root = fixtureRepo(t, { otherVersion: "0.17.0" });
  const result = runScript(root);
  assert.equal(result.status, 1, `expected a failure, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /Workspace package versions are out of sync/);
  assert.match(result.stderr, /0\.17\.0: @argent\/registry/);
  assert.match(result.stderr, /Bump the outliers to match\./);
  // server.json agrees with packages/argent, so nothing else could have failed it.
  assert.doesNotMatch(result.stderr, /server\.json is out of sync/);
});

// The manifest is what names a package in the report; the directory name is only
// the fallback for one that does not name itself.
test("[script] a versioned manifest with no name is reported by its directory", (t) => {
  const root = fixtureRepo(t, {
    otherVersion: "0.17.0",
    extraPackages: { unnamed: { version: "0.16.0" } },
  });
  const result = runScript(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /0\.16\.0: unnamed/);
});

// A manifest with no version is not a workspace package for lockstep purposes, so
// it must stay out of the version map entirely rather than joining it as
// `undefined` and making every repo look drifted.
test("[script] a version-less manifest is excluded, not counted as its own version", (t) => {
  const root = fixtureRepo(t, { extraPackages: { noversion: { name: "@argent/noversion" } } });
  const result = runScript(root);
  assert.equal(result.status, 0, `expected a clean repo, got:\n${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, "");
});

// packages/docs carries its own standalone version (0.0.0 in the real repo) and
// is excluded from lockstep by NON_WORKSPACE_DIRS. Deleting that skip would
// otherwise read it as drift on every release, since it never matches the rest
// of the workspace.
test("[script] packages/docs is excluded from lockstep, not read as drift", (t) => {
  const root = fixtureRepo(t, {
    extraPackages: { docs: { name: "@argent/docs", version: "0.0.0" } },
  });
  const result = runScript(root);
  assert.equal(result.status, 0, `expected a clean repo, got:\n${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, "");
});

// A manifest that exists but cannot be parsed is not the same as a directory with
// no manifest: dropping it silently would take a real package out of the lockstep
// comparison and pass a workspace that had drifted.
test("[script] an unparseable packages/* manifest fails instead of being skipped", (t) => {
  const root = fixtureRepo(t, {
    extraPackages: { broken: '{ "name": "@argent/broken", "version": "9.9.9",, }' },
  });
  const result = runScript(root);
  assert.equal(result.status, 1, `expected a failure, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /Cannot read packages\/broken\/package\.json: /);
  assert.match(result.stderr, /git checkout -- packages\/broken\/package\.json/);
  assertNoStackTrace(result.stderr);
});

// packages/argent-private is exactly this in the real repo: a submodule directory
// carrying no package.json. The scan has to step over an unusable directory and
// keep going, or every package sorting after it silently leaves the comparison.
test("[script] an unusable packages/* directory does not stop the scan", (t) => {
  const root = fixtureRepo(t, {
    otherVersion: "0.17.0",
    extraPackages: { nomanifest: null, noversion: { name: "@argent/noversion" } },
  });
  const result = runScript(root);
  assert.equal(result.status, 1, `expected a failure, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /0\.17\.0: @argent\/registry/);
});

// JSON.parse succeeds on a file holding `null`, a bare scalar or an array, so
// none of them reach the scan's try/catch — yet each is a manifest that is
// *there but unusable*, and skipping one would drop a real package out of the
// lockstep comparison and pass a workspace that had drifted. Same shape the
// readTrackedJson guard rejects for server.json and packages/argent; all three
// forms are asserted here so the scalar arm is pinned like the other two sites.
test("[script] a packages/* manifest that is not an object fails on-message, not silently skipped", (t) => {
  for (const [content, shape] of [
    ["null", "null"],
    ['"0.18.0"', "string"],
    ['["@swmansion/argent", "0.18.0"]', "an array"],
  ]) {
    const root = fixtureRepo(t, {
      otherVersion: "0.17.0",
      extraPackages: { corrupt: content },
    });
    const result = runScript(root);
    assert.equal(
      result.status,
      1,
      `expected a failure for ${content}, got:\n${result.stdout}${result.stderr}`
    );
    assert.equal(
      result.stderr.split("\n")[0],
      `packages/corrupt/package.json is ${shape}, not a JSON object`
    );
    assert.match(result.stderr, /git checkout -- packages\/corrupt\/package\.json/);
    assertNoStackTrace(result.stderr);
  }
});

// The report groups every package sharing a version onto one alphabetised line,
// which is what makes a drift report readable at 17 packages. Directory `aaa`
// holds a package named `@zzz/...`, so the scan reaches it first and the names
// come out in the opposite order to the one asserted unless they are sorted.
test("[script] the drift report lists every package sharing a version, sorted", (t) => {
  const root = fixtureRepo(t, {
    otherVersion: "0.17.0",
    extraPackages: { aaa: { name: "@zzz/scanned-first", version: VERSION } },
  });
  const result = runScript(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /0\.18\.0: @swmansion\/argent, @zzz\/scanned-first\n/);
});

// The one shape where every comparison the script makes is vacuously satisfied:
// with no version on the manifest and none in server.json, each `!==` compares
// undefined against undefined and the repo passes with nothing checked.
test("[script] a version-less manifest fails instead of passing vacuously", (t) => {
  const root = fixtureRepo(t, {
    argentVersion: null,
    serverJson: server((s) => {
      delete s.version;
      delete s.packages[0].version;
    }),
  });
  const result = runScript(root);
  assert.equal(result.status, 1, `expected a failure, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /packages\/argent\/package\.json has no version/);
  assert.doesNotMatch(result.stdout, /at undefined/);
});

test("[script] a half-finished bump reports packages/* and server.json in one run", (t) => {
  const root = fixtureRepo(t, {
    otherVersion: "0.17.0",
    serverJson: server((s) => {
      s.version = "0.17.0";
      s.packages[0].version = "0.17.0";
    }),
  });
  const result = runScript(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Workspace package versions are out of sync/);
  assert.match(result.stderr, /@argent\/registry/);
  assert.match(result.stderr, /server\.json version is 0\.17\.0/);
});

// node realpaths the main module before setting import.meta.url but leaves
// process.argv[1] as typed, so a self-invocation guard comparing them raw skips
// main() here and exits 0 with no output — a drifted repo indistinguishable
// from a clean one.
test("[script] a run through a symlinked path still catches drift", (t) => {
  const root = fixtureRepo(t, { serverJson: server((s) => (s.version = "0.17.0")) });
  const aliasParent = realpathSync(mkdtempSync(join(tmpdir(), "check-workspace-versions-alias-")));
  t.after(() => rmSync(aliasParent, { recursive: true, force: true }));
  const alias = join(aliasParent, "repo");
  symlinkSync(root, alias, "dir");

  const result = runScript(alias);
  assert.equal(result.status, 1, `expected a failure, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /server\.json version is 0\.17\.0/);
});

test("[script] a missing server.json fails on-message", (t) => {
  const result = runScript(fixtureRepo(t, { serverJson: null }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot read server\.json: /);
  assert.match(result.stderr, /git checkout -- server\.json/);
  assertNoStackTrace(result.stderr);
});

test("[script] a corrupt server.json does not swallow the packages/* drift", (t) => {
  const result = runScript(fixtureRepo(t, { otherVersion: "0.17.0", serverJson: null }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Workspace package versions are out of sync/);
  assert.match(result.stderr, /Cannot read server\.json/);
});

test("[script] a malformed server.json fails on-message", (t) => {
  const result = runScript(fixtureRepo(t, { serverJson: "{ not json" }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /server\.json is not valid JSON: /);
  assert.match(result.stderr, /git checkout -- server\.json/);
  assertNoStackTrace(result.stderr);
});

// `null`, a bare scalar and an array all parse cleanly, so the read has to reject
// them itself — every field lookup after it would either throw or quietly match
// undefined.
test("[script] a server.json that parses but is not an object fails on-message", (t) => {
  for (const [content, shape] of [
    ["null", "null"],
    ['"0.18.0"', "string"],
    ["[]", "an array"],
  ]) {
    const result = runScript(fixtureRepo(t, { serverJson: content }));
    assert.equal(result.status, 1, `expected a failure for ${content}, got:\n${result.stdout}`);
    assert.equal(result.stderr.split("\n")[0], `server.json is ${shape}, not a JSON object`);
    assert.match(result.stderr, /git checkout -- server\.json/);
    assertNoStackTrace(result.stderr);
  }
});

// readTrackedJson has two call sites and every test above drives only the
// server.json one, so nothing observed that packages/argent/package.json is read
// the same hardened way rather than by a bare JSON.parse. (Its malformed-JSON arm
// is unreachable from this side — the scan reads the same file first and stops
// there — so these two cover the arms that are.)
test("[script] a missing packages/argent/package.json fails on-message", (t) => {
  const result = runScript(fixtureRepo(t, { argentManifest: null }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot read packages\/argent\/package\.json: /);
  assert.match(result.stderr, /git checkout -- packages\/argent\/package\.json/);
  assertNoStackTrace(result.stderr);
});

test("[script] a packages/argent/package.json that is not an object fails on-message", (t) => {
  const result = runScript(fixtureRepo(t, { argentManifest: "null" }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/argent\/package\.json is null, not a JSON object/);
  assert.match(result.stderr, /git checkout -- packages\/argent\/package\.json/);
  assertNoStackTrace(result.stderr);
});
