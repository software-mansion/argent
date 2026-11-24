import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SUITE_CONFIG_FILE,
  SuiteConfigError,
  parseSuiteConfig,
  planDirectoryRun,
  unlistedWarning,
  type RunPlanEntry,
} from "../src/e2e-suite.js";

describe("parseSuiteConfig", () => {
  it.each(["", "# only a comment\n", "~\n"])(
    "reads an empty document %j as a suite in file name order",
    (text) => {
      expect(parseSuiteConfig(text)).toEqual({ continueOnFailure: false });
    }
  );

  it("reads both keys and strips a trailing .yaml from the entries", () => {
    expect(
      parseSuiteConfig("continueOnFailure: true\ntests:\n  - add-post\n  - delete-post.yaml\n")
    ).toEqual({ continueOnFailure: true, tests: ["add-post", "delete-post"] });
  });

  it.each([
    ["a YAML syntax error", "tests: [a", /^not valid YAML: /],
    ["a list document", "- a\n", /must be a YAML map/],
    ["a scalar document", "a\n", /must be a YAML map/],
    ["an unknown key", "test:\n  - a\n", /unknown key "test"/],
    ["a non-boolean continueOnFailure", "continueOnFailure: yes\n", /continueOnFailure must be/],
    ["a null continueOnFailure", "continueOnFailure:\n", /continueOnFailure must be/],
    ["an empty tests list", "tests: []\n", /tests must be a non-empty list/],
    ["a null tests", "tests:\n", /tests must be a non-empty list/],
    ["a string tests", "tests: a\n", /tests must be a non-empty list/],
    ["a map entry", "tests:\n  - a: 1\n", /^tests entry 1 is not a string/],
    [
      "a numeric entry",
      "tests:\n  - a\n  - 001\n",
      /^tests entry 2 is not a string; put the test name in quotes$/,
    ],
    ["an entry with a separator", "tests:\n  - sub/a\n", /"sub\/a" is not a valid test name/],
    ["an entry with a parent segment", "tests:\n  - ../a\n", /is not a valid test name/],
    ["an entry with another extension", "tests:\n  - a.yml\n", /is not a valid test name/],
    ["a duplicate entry", "tests:\n  - a\n  - a.yaml\n", /tests lists "a" more than once/],
  ])("rejects %s", (_, text, message) => {
    expect(() => parseSuiteConfig(text)).toThrow(SuiteConfigError);
    expect(() => parseSuiteConfig(text)).toThrow(message);
  });
});

describe("planDirectoryRun", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(tmpdir(), "argent-e2e-suite-"));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  async function writeManifest(rel: string, text: string): Promise<void> {
    await fsp.mkdir(path.join(dir, rel), { recursive: true });
    await fsp.writeFile(path.join(dir, rel, SUITE_CONFIG_FILE), text);
  }

  const order = (plan: Awaited<ReturnType<typeof planDirectoryRun>>): string[] =>
    plan.entries.map((entry) => (entry.kind === "test" ? entry.path : `!${entry.manifest}`));

  it("keeps the collected order and no suite when no directory has a manifest", async () => {
    const collected = ["a.yaml", "b/x.yaml", "c.yaml"];
    const plan = await planDirectoryRun(dir, collected, []);
    expect(plan.entries).toEqual(collected.map((p) => ({ kind: "test", path: p })));
    expect(plan.unlisted).toEqual([]);
  });

  it("runs a suite in manifest order at the position of its first collected file", async () => {
    await writeManifest("posts", "continueOnFailure: true\ntests:\n  - delete\n  - add\n");
    const plan = await planDirectoryRun(
      dir,
      ["a.yaml", "posts/add.yaml", "posts/delete.yaml", "z.yaml"],
      ["posts/suite.config.yaml"]
    );
    expect(order(plan)).toEqual(["a.yaml", "posts/delete.yaml", "posts/add.yaml", "z.yaml"]);
    const suite = { dir: "posts", manifest: "posts/suite.config.yaml", continueOnFailure: true };
    expect(plan.entries[0]).toEqual({ kind: "test", path: "a.yaml" });
    expect(plan.entries[1]).toEqual({ kind: "test", path: "posts/delete.yaml", suite });
    expect(plan.entries[2]).toEqual({ kind: "test", path: "posts/add.yaml", suite });
    const suiteOf = (entry: RunPlanEntry | undefined) =>
      entry?.kind === "test" ? entry.suite : undefined;
    expect(suiteOf(plan.entries[1])).toBe(suiteOf(plan.entries[2]));
  });

  it("keeps the tests of a suite contiguous when other paths sort between them", async () => {
    await writeManifest(".", "tests:\n  - d\n  - a\n  - c\n");
    const plan = await planDirectoryRun(
      dir,
      ["a.yaml", "b/x.yaml", "c.yaml", "d.yaml"],
      ["suite.config.yaml"]
    );
    expect(order(plan)).toEqual(["d.yaml", "a.yaml", "c.yaml", "b/x.yaml"]);
    expect(plan.entries[3]).toEqual({ kind: "test", path: "b/x.yaml" });
  });

  it("reads an empty manifest as a suite in file name order", async () => {
    await writeManifest("posts", "");
    const plan = await planDirectoryRun(
      dir,
      ["posts/add.yaml", "posts/delete.yaml"],
      ["posts/suite.config.yaml"]
    );
    const suite = { dir: "posts", manifest: "posts/suite.config.yaml", continueOnFailure: false };
    expect(plan.entries).toEqual([
      { kind: "test", path: "posts/add.yaml", suite },
      { kind: "test", path: "posts/delete.yaml", suite },
    ]);
  });

  it("does not put the tests of a subdirectory in the parent suite", async () => {
    await writeManifest(".", "");
    await writeManifest("sub/own", "");
    const plan = await planDirectoryRun(
      dir,
      ["a.yaml", "sub/b.yaml", "sub/own/c.yaml"],
      ["sub/own/suite.config.yaml", "suite.config.yaml"]
    );
    expect(plan.entries).toEqual([
      { kind: "test", path: "a.yaml", suite: expect.objectContaining({ dir: "." }) },
      { kind: "test", path: "sub/b.yaml" },
      { kind: "test", path: "sub/own/c.yaml", suite: expect.objectContaining({ dir: "sub/own" }) },
    ]);
  });

  it("leaves out an unlisted file and reports it with its suite", async () => {
    await writeManifest("posts", "tests:\n  - add\n");
    const plan = await planDirectoryRun(
      dir,
      ["posts/add.yaml", "posts/extra.yaml", "posts/other.yaml"],
      ["posts/suite.config.yaml"]
    );
    expect(order(plan)).toEqual(["posts/add.yaml"]);
    const suite = plan.entries[0]!.kind === "test" ? plan.entries[0]!.suite : undefined;
    expect(suite).toBeDefined();
    expect(plan.unlisted).toHaveLength(2);
    expect(plan.unlisted[0]).toEqual({ path: "posts/extra.yaml", suite });
    expect(plan.unlisted[0]!.suite).toBe(suite);
    expect(plan.unlisted[1]).toEqual({ path: "posts/other.yaml", suite });
    expect(unlistedWarning("posts/extra.yaml", "posts/suite.config.yaml")).toBe(
      "posts/extra.yaml is not listed in the tests of posts/suite.config.yaml and does not run"
    );
  });

  it("rejects an invalid manifest at the suite position and keeps the other tests", async () => {
    await writeManifest("posts", "tests: [add\n");
    const plan = await planDirectoryRun(
      dir,
      ["a.yaml", "posts/add.yaml", "posts/delete.yaml", "z.yaml"],
      ["posts/suite.config.yaml"]
    );
    expect(order(plan)).toEqual(["a.yaml", "!posts/suite.config.yaml", "z.yaml"]);
    expect(plan.entries[1]).toEqual({
      kind: "invalid-suite",
      dir: "posts",
      manifest: "posts/suite.config.yaml",
      message: expect.stringMatching(/^posts\/suite\.config\.yaml: not valid YAML: /),
      error: expect.stringMatching(/^not valid YAML: /),
      tests: ["posts/add.yaml", "posts/delete.yaml"],
    });
    expect(plan.unlisted).toEqual([]);
  });

  it("rejects an entry with no collected test directly in the directory", async () => {
    await writeManifest(".", "tests:\n  - a\n  - x\n");
    const plan = await planDirectoryRun(dir, ["a.yaml", "sub/x.yaml"], ["suite.config.yaml"]);
    expect(plan.entries).toEqual([
      {
        kind: "invalid-suite",
        dir: ".",
        manifest: "suite.config.yaml",
        message: 'suite.config.yaml: tests entry "x" names no e2e test in this directory',
        error: 'tests entry "x" names no e2e test in this directory',
        tests: ["a.yaml"],
      },
      { kind: "test", path: "sub/x.yaml" },
    ]);
  });

  it("rejects a manifest that names a test gone from a directory with no collected test", async () => {
    await writeManifest("posts", "tests:\n  - checkout\n");
    await writeManifest("empty", "");
    await writeManifest("ordered", "continueOnFailure: true\n");
    const plan = await planDirectoryRun(
      dir,
      ["smoke.yaml"],
      ["empty/suite.config.yaml", "ordered/suite.config.yaml", "posts/suite.config.yaml"]
    );
    expect(plan.entries).toEqual([
      {
        kind: "invalid-suite",
        dir: "posts",
        manifest: "posts/suite.config.yaml",
        message:
          'posts/suite.config.yaml: tests entry "checkout" names no e2e test in this directory',
        error: 'tests entry "checkout" names no e2e test in this directory',
        tests: [],
      },
      { kind: "test", path: "smoke.yaml" },
    ]);
    expect(plan.unlisted).toEqual([]);
  });

  it("rejects an invalid manifest with no collected test at the position of its path", async () => {
    await writeManifest("m", "bogus: 1\n");
    await writeManifest("posts", "tests:\n  - add\n");
    const plan = await planDirectoryRun(
      dir,
      ["a.yaml", "posts/add.yaml", "z.yaml"],
      ["m/suite.config.yaml", "posts/suite.config.yaml"]
    );
    expect(order(plan)).toEqual(["a.yaml", "!m/suite.config.yaml", "posts/add.yaml", "z.yaml"]);
    expect(plan.entries[1]).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/^m\/suite\.config\.yaml: unknown key "bogus"/),
        tests: [],
      })
    );
  });

  it.each([
    ["with", ["posts/add.yaml"]],
    ["without", []],
  ])("rejects a manifest symlink whose target is gone, %s collected tests", async (_, tests) => {
    await fsp.mkdir(path.join(dir, "posts"));
    await fsp.symlink(path.join(dir, "gone.yaml"), path.join(dir, "posts", SUITE_CONFIG_FILE));
    const plan = await planDirectoryRun(dir, [...tests, "smoke.yaml"], ["posts/suite.config.yaml"]);
    expect(plan.entries).toEqual([
      {
        kind: "invalid-suite",
        dir: "posts",
        manifest: "posts/suite.config.yaml",
        message: "posts/suite.config.yaml: could not read the file: ENOENT",
        error: "could not read the file: ENOENT",
        tests,
      },
      { kind: "test", path: "smoke.yaml" },
    ]);
  });
});
