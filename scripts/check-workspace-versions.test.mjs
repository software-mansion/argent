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

import { pluginManifestMismatches, serverJsonMismatches } from "./check-workspace-versions.mjs";

const VERSION = "0.18.0";
const ARGENT_PKG = {
  name: "@swmansion/argent",
  mcpName: "io.github.software-mansion/argent",
  files: ["dist/", "skills/", "plugin.json", "mcp.json"],
};
const SERVER = {
  name: "io.github.software-mansion/argent",
  version: VERSION,
  packages: [{ identifier: "@swmansion/argent", version: VERSION }],
};
const PLUGIN = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "argent",
  version: VERSION,
};
const PLUGIN_MCP = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    argent: { type: "stdio", command: "npx", args: ["-y", `@swmansion/argent@${VERSION}`, "mcp"] },
  },
};

/** @param {(s: typeof SERVER) => void} mutate */
function server(mutate) {
  const copy = structuredClone(SERVER);
  mutate(copy);
  return copy;
}

/** @param {(p: typeof PLUGIN) => void} mutate */
function plugin(mutate) {
  const copy = structuredClone(PLUGIN);
  mutate(copy);
  return copy;
}

/** @param {(m: typeof PLUGIN_MCP) => void} mutate */
function pluginMcp(mutate) {
  const copy = structuredClone(PLUGIN_MCP);
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

// --- the Agent Plugins manifest pair ----------------------------------------
// plugin.json and mcp.json are read by plugin-aware clients, never by our build,
// so nothing in the repo exercises them — these are the only thing standing
// between a bump and a plugin that ships this release's skills next to a server
// pinned to the previous one.

test("an in-sync manifest pair reports nothing", () => {
  assert.deepEqual(pluginManifestMismatches(VERSION, ARGENT_PKG, PLUGIN, PLUGIN_MCP), []);
});

test("a plugin.json version left behind by a bump is caught", () => {
  const problems = pluginManifestMismatches(
    VERSION,
    ARGENT_PKG,
    plugin((p) => (p.version = "0.17.0")),
    PLUGIN_MCP
  );
  assert.deepEqual(problems, [
    "plugin.json version is 0.17.0, packages/argent/package.json is 0.18.0",
  ]);
});

// The failure this pair exists to prevent: the manifest says 0.18.0 while the
// server it launches is the previous release, so the skills and the tools they
// name come from different versions.
test("an npx pin left behind by a bump is caught", () => {
  const problems = pluginManifestMismatches(
    VERSION,
    ARGENT_PKG,
    PLUGIN,
    pluginMcp((m) => (m.mcpServers.argent.args = ["-y", "@swmansion/argent@0.17.0", "mcp"]))
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not pin @swmansion\/argent@0\.18\.0/);
});

// An unpinned `@latest` (or a bare name) passes every other check here while
// silently decoupling the server from the plugin it ships in.
test("an unpinned npx arg is caught", () => {
  for (const spec of ["@swmansion/argent", "@swmansion/argent@latest"]) {
    const problems = pluginManifestMismatches(
      VERSION,
      ARGENT_PKG,
      PLUGIN,
      pluginMcp((m) => (m.mcpServers.argent.args = ["-y", spec, "mcp"]))
    );
    assert.equal(problems.length, 1, `expected ${spec} to be caught`);
    assert.match(problems[0], /does not pin/);
  }
});

// The spec requires both $schema values to name the same spec version; a
// mismatch invalidates the MCP component while the rest of the plugin still
// loads, which is worse than failing outright.
test("either $schema drifting from the targeted spec version is caught", () => {
  const bumped = pluginManifestMismatches(
    VERSION,
    ARGENT_PKG,
    plugin((p) => (p.$schema = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json")),
    PLUGIN_MCP
  );
  assert.equal(bumped.length, 1);
  assert.match(bumped[0], /plugin\.json \$schema is/);

  const mcpBumped = pluginManifestMismatches(
    VERSION,
    ARGENT_PKG,
    PLUGIN,
    pluginMcp((m) => (m.$schema = "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json"))
  );
  assert.equal(mcpBumped.length, 1);
  assert.match(mcpBumped[0], /mcp\.json \$schema is/);
});

// npm ships package.json, README and LICENSE implicitly and nothing else, so a
// `files` array that forgets either file publishes a tarball that is not a
// plugin root at all — and every other check here would still pass.
test("a files array that would not ship the pair is caught", () => {
  const problems = pluginManifestMismatches(
    VERSION,
    { ...ARGENT_PKG, files: ["dist/", "skills/"] },
    PLUGIN,
    PLUGIN_MCP
  );
  assert.deepEqual(problems, [
    'packages/argent/package.json "files" does not list plugin.json — it would not ship in the tarball',
    'packages/argent/package.json "files" does not list mcp.json — it would not ship in the tarball',
  ]);
});

// Clients namespace a plugin server's tools by its mcp.json key, so renaming it
// renames every mcp__argent__* tool the bundled skills call for by name.
test("renaming the server key away from argent is caught", () => {
  const problems = pluginManifestMismatches(
    VERSION,
    ARGENT_PKG,
    PLUGIN,
    pluginMcp((m) => {
      m.mcpServers = /** @type {any} */ ({ "swm-argent": m.mcpServers.argent });
    })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /declares no "argent" server \(found: swm-argent\)/);
});

// Absent, null and array all leave the plugin exposing no tools, and reading
// through the last two would throw rather than report.
test("an mcp.json with no usable mcpServers object is caught", () => {
  const unusable = [
    pluginMcp((m) => delete (/** @type {any} */ (m).mcpServers)),
    pluginMcp((m) => (m.mcpServers = /** @type {any} */ (null))),
    pluginMcp((m) => (m.mcpServers = /** @type {any} */ ([]))),
  ];
  for (const broken of unusable) {
    const problems = pluginManifestMismatches(VERSION, ARGENT_PKG, PLUGIN, broken);
    assert.deepEqual(problems, [
      "mcp.json has no mcpServers object — the plugin would expose no tools",
    ]);
  }
});

// A transport the client cannot launch from a plugin directory, e.g. a hand-edit
// to an http URL that nothing in this repo serves.
test("a non-stdio transport is caught", () => {
  const problems = pluginManifestMismatches(
    VERSION,
    ARGENT_PKG,
    PLUGIN,
    pluginMcp((m) => (m.mcpServers.argent.type = "streamable-http"))
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /argent\.type is streamable-http, expected stdio/);
});

// Same vacuous-pass shape serverJsonMismatches guards: with no version to
// compare against, the version check and the pin check both compare undefined.
test("a version-less manifest fails instead of passing vacuously", () => {
  const problems = pluginManifestMismatches(undefined, ARGENT_PKG, PLUGIN, PLUGIN_MCP);
  assert.deepEqual(problems, [
    "packages/argent/package.json has no version — nothing for plugin.json to be checked against",
  ]);
});

test("every problem is reported at once, not just the first", () => {
  const problems = pluginManifestMismatches(
    VERSION,
    { ...ARGENT_PKG, files: ["dist/"] },
    plugin((p) => (p.version = "0.17.0")),
    pluginMcp((m) => (m.mcpServers.argent.args = ["-y", "@swmansion/argent@0.17.0", "mcp"]))
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
 *   pluginJson?: unknown, pluginMcpJson?: unknown, extraPackages?: Record<string, unknown> }} [options]
 *   serverJson / pluginJson / pluginMcpJson: an object to write as JSON, a
 *   string to write verbatim, or null to leave the file out entirely.
 *   argentVersion: null omits the version key. extraPackages: further
 *   packages/<dir> entries, a null value creating the directory with no
 *   package.json in it.
 * @returns {string} the repo root
 */
function fixtureRepo(
  t,
  {
    argentVersion = VERSION,
    otherVersion = VERSION,
    serverJson,
    pluginJson,
    pluginMcpJson,
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

  write(join(root, "packages", "argent", "package.json"), {
    ...ARGENT_PKG,
    ...(argentVersion === null ? {} : { version: argentVersion }),
  });
  write(join(root, "packages", "registry", "package.json"), {
    name: "@argent/registry",
    version: otherVersion,
  });
  for (const [dir, manifest] of Object.entries(extraPackages)) {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    if (manifest !== null) write(join(root, "packages", dir, "package.json"), manifest);
  }
  if (serverJson !== null) write(join(root, "server.json"), serverJson ?? SERVER);
  if (pluginJson !== null) {
    write(join(root, "packages", "argent", "plugin.json"), pluginJson ?? PLUGIN);
  }
  if (pluginMcpJson !== null) {
    write(join(root, "packages", "argent", "mcp.json"), pluginMcpJson ?? PLUGIN_MCP);
  }

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
  assert.match(
    result.stdout,
    /All workspace packages, server\.json and the plugin manifest are at 0\.18\.0\./
  );
});

test("[script] plugin manifest drift alone exits 1", (t) => {
  const root = fixtureRepo(t, { pluginJson: plugin((p) => (p.version = "0.17.0")) });
  const result = runScript(root);
  assert.equal(result.status, 1, `expected a failure, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /plugin\.json version is 0\.17\.0/);
  // Nothing else disagrees, so this is the only thing that could have failed it.
  assert.doesNotMatch(result.stderr, /server\.json is out of sync/);
  assert.doesNotMatch(result.stderr, /Workspace package versions are out of sync/);
});

test("[script] a half-finished bump reports server.json and the plugin pair in one run", (t) => {
  const root = fixtureRepo(t, {
    serverJson: server((s) => {
      s.version = "0.17.0";
      s.packages[0].version = "0.17.0";
    }),
    pluginMcpJson: pluginMcp(
      (m) => (m.mcpServers.argent.args = ["-y", "@swmansion/argent@0.17.0", "mcp"])
    ),
  });
  const result = runScript(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /server\.json version is 0\.17\.0/);
  assert.match(result.stderr, /does not pin @swmansion\/argent@0\.18\.0/);
});

test("[script] a missing plugin.json fails on-message", (t) => {
  const result = runScript(fixtureRepo(t, { pluginJson: null }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot read packages\/argent\/plugin\.json: /);
  assert.match(result.stderr, /git checkout -- packages\/argent\/plugin\.json/);
  assertNoStackTrace(result.stderr);
});

test("[script] a malformed mcp.json fails on-message", (t) => {
  const result = runScript(fixtureRepo(t, { pluginMcpJson: "{ not json" }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/argent\/mcp\.json is not valid JSON: /);
  assertNoStackTrace(result.stderr);
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
});

// The check the script existed for before this PR. Every other failing [script]
// test here reaches its exit 1 through a server.json problem, so this is the only
// one that pins the exit code to workspace drift on its own.
test("[script] packages/* drift alone exits 1", (t) => {
  const root = fixtureRepo(t, { otherVersion: "0.17.0" });
  const result = runScript(root);
  assert.equal(result.status, 1, `expected a failure, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /Workspace package versions are out of sync/);
  assert.match(result.stderr, /0\.17\.0: @argent\/registry/);
  // server.json agrees with packages/argent, so nothing else could have failed it.
  assert.doesNotMatch(result.stderr, /server\.json is out of sync/);
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

// JSON.parse succeeds on a file holding `null`, so the scan's try/catch never
// sees it and the version read below is what would throw.
test("[script] a packages/* manifest holding null does not crash the scan", (t) => {
  const root = fixtureRepo(t, {
    otherVersion: "0.17.0",
    extraPackages: { corrupt: "null" },
  });
  const result = runScript(root);
  assert.equal(result.status, 1, `expected a failure, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /0\.17\.0: @argent\/registry/);
  assertNoStackTrace(result.stderr);
});

// The report groups every package sharing a version onto one line, which is what
// makes a drift report readable at 17 packages.
test("[script] the drift report lists every package sharing a version", (t) => {
  const root = fixtureRepo(t, {
    otherVersion: "0.17.0",
    extraPackages: { alpha: { name: "@argent/alpha", version: VERSION } },
  });
  const result = runScript(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /0\.18\.0: @argent\/alpha, @swmansion\/argent\n/);
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
    assertNoStackTrace(result.stderr);
  }
});
