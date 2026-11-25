import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore, CLIENT_FILE_MARKER, type ToolContext } from "@argent/registry";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowSetEnvTool } from "../../src/tools/flows/flow-set-env";
import { flowAddScriptTool } from "../../src/tools/flows/flow-add-script";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";

/**
 * The recording side of environment values: `e2e-set-env` edits the test's
 * top-level `env:`, `e2e-start-recording` seeds it, and `e2e-add-script` runs
 * its script with it and records the step's own `env`.
 */

vi.setConfig({ testTimeout: 30_000 });

const SECRET = "sk-live-9f8e7d6c5b4a3210";
let root: string;

async function write(relative: string, contents: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
}

async function onDisk(name: string) {
  return parseFlow(await fs.readFile(path.join(root, ".argent", "e2e", `${name}.yaml`), "utf8"));
}

const setEnv = (name: string, env: Record<string, string | null>, ctx?: ToolContext) =>
  flowSetEnvTool.execute({}, { name, project_root: root, env }, ctx);

beforeEach(async () => {
  __resetRecordingsForTesting();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-set-env-")));
  await write(".argent/secrets.env", `API_KEY=${SECRET}\n`);
});
afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

describe("e2e-set-env", () => {
  it("merges names into the file's env:, removes a null one, and drops an empty map", async () => {
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root });
    await flowInsertEchoTool.execute({}, { name: "t", project_root: root, message: "hi" });

    const first = await setEnv("t", { A: "1", KEY: "{{secret:API_KEY}}" });
    expect(first.env).toEqual({ A: "1", KEY: "{{secret:API_KEY}}" });
    const second = await setEnv("t", { A: null, B: "2" });
    expect(second.env).toEqual({ KEY: "{{secret:API_KEY}}", B: "2" });
    expect((await onDisk("t")).env).toEqual({ KEY: "{{secret:API_KEY}}", B: "2" });
    // The steps recorded so far stay.
    expect((await onDisk("t")).steps).toEqual([{ kind: "echo", message: "hi" }]);

    await setEnv("t", { KEY: null, B: null });
    expect((await onDisk("t")).env).toBeUndefined();
  });

  it.each([
    ["an invalid name", { "1X": "a" }, /invalid variable name/],
    ["a missing secret", { K: "{{secret:NOT_DEFINED_ANYWHERE_42}}" }, /NOT_DEFINED_ANYWHERE_42/],
  ])("refuses %s and leaves the file as it was", async (_label, env, message) => {
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root, env: { KEEP: "x" } });
    await expect(setEnv("t", env)).rejects.toThrow(message);
    expect((await onDisk("t")).env).toEqual({ KEEP: "x" });
  });

  it("removes a name spelled like an Object.prototype member", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "t", project_root: root, env: { toString: "x", valueOf: "y" } }
    );
    expect((await setEnv("t", { toString: null, valueOf: null })).env).toEqual({});
  });

  it("refuses a test with no recording in progress", async () => {
    await expect(setEnv("never-started", { A: "1" })).rejects.toThrow(/recording/i);
  });

  it("returns the updated YAML to a client that keeps the file", async () => {
    const clientRoot = path.join(os.tmpdir(), "definitely-not-on-this-host", "env-project");
    const ctx: ToolContext = {
      artifacts: new ArtifactStore(),
      fileInputs: {
        project_root: { clientPath: clientRoot, presentOnHost: false, viaUpload: false },
      },
    };
    await flowStartRecordingTool.execute({}, { name: "remote", project_root: clientRoot }, ctx);

    const result = await flowSetEnvTool.execute(
      {},
      { name: "remote", project_root: clientRoot, env: { A: "1" } },
      ctx
    );

    expect(result.savedTo).toMatchObject({ [CLIENT_FILE_MARKER]: true });
    expect(parseFlow((result.savedTo as { content: string }).content).env).toEqual({ A: "1" });
    await expect(fs.stat(clientRoot)).rejects.toThrow();
  });
});

describe("e2e-start-recording with env", () => {
  it("writes the env: it is given, and a restart without it drops it", async () => {
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root, env: { A: "1" } });
    expect((await onDisk("t")).env).toEqual({ A: "1" });

    await flowStartRecordingTool.execute({}, { name: "t", project_root: root });
    expect((await onDisk("t")).env).toBeUndefined();
  });
});

describe("e2e-add-script with env", () => {
  it("runs the script with the file's env: under its own, records only its own", async () => {
    await write(
      "scripts/print.mjs",
      [
        `console.log(JSON.stringify({ A: process.env.A, B: process.env.B }));`,
        `console.log("key " + process.env.KEY);`,
        `globalThis.output = { key: process.env.KEY };`,
      ].join("\n")
    );
    await flowStartRecordingTool.execute(
      {},
      { name: "t", project_root: root, env: { A: "file", B: "file" } }
    );

    const result = await flowAddScriptTool.execute(
      {},
      {
        name: "t",
        project_root: root,
        path: "../../scripts/print.mjs",
        env: { B: "step", KEY: "{{secret:API_KEY}}" },
      }
    );

    expect(result.status).toBe("pass");
    expect(result.log).toContain('{"A":"file","B":"step"}');
    expect(`${result.log}${result.outputJson}`).not.toContain(SECRET);
    expect(result.log).toContain("key {{secret:API_KEY}}");
    expect((await onDisk("t")).steps).toEqual([
      {
        kind: "script",
        path: "../../scripts/print.mjs",
        env: { B: "step", KEY: "{{secret:API_KEY}}" },
      },
    ]);
  });

  it("records nothing when a secret in its env is missing", async () => {
    await write("scripts/noop.mjs", "");
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root });

    const result = await flowAddScriptTool.execute(
      {},
      {
        name: "t",
        project_root: root,
        path: "../../scripts/noop.mjs",
        env: { K: "{{secret:NOT_DEFINED_ANYWHERE_42}}" },
      }
    );

    expect(result.status).toBe("error");
    expect(result.reason).toContain("NOT_DEFINED_ANYWHERE_42");
    expect((await onDisk("t")).steps).toEqual([]);
  });
});
