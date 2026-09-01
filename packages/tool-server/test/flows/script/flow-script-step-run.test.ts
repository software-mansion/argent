import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore, type Registry, type ToolContext } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import { stepRequiresDevice } from "../../../src/tools/flows/flow-device";

/**
 * The `script:` step in a run; the executor's own behaviour is covered beside
 * it, in flow-script-run.test.ts. Real child processes, hence the generous
 * timeout.
 */

vi.setConfig({ testTimeout: 30_000 });

const DEVICE = "00000000-0000-0000-0000-0000000000ab";

let root: string;

function mockRegistry(opts: { booted?: string[] } = {}) {
  const invokeTool = vi.fn(async (id: string) => {
    if (id === "list-devices") {
      return {
        devices: (opts.booted ?? []).map((udid) => ({ platform: "ios", udid, state: "Booted" })),
      };
    }
    return { ok: true };
  });
  const registry = {
    invokeTool,
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
  return { registry, invokeTool };
}

async function write(relative: string, contents: string): Promise<string> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
  return file;
}

function flow(name: string, yaml: string): Promise<string> {
  return write(path.join(".argent", "flows", `${name}.yaml`), yaml);
}

function markPath(mark: string): string {
  return path.join(root, `${mark}.mark`);
}

function markingScript(relative: string, mark: string, expression?: string): Promise<string> {
  return write(
    relative,
    `import fs from "node:fs";\n` +
      `fs.writeFileSync(${JSON.stringify(markPath(mark))}, ` +
      `String(${expression ?? JSON.stringify(mark)}));`
  );
}

function readMark(mark: string): string | undefined {
  try {
    return fsSync.readFileSync(markPath(mark), "utf8");
  } catch {
    return undefined;
  }
}

function boundaryCtx(flowPath: string): ToolContext {
  return {
    artifacts: new ArtifactStore(),
    fileInputs: {
      flow_path: {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      },
    },
  };
}

function listedDevices(invokeTool: { mock: { calls: unknown[][] } }): boolean {
  return invokeTool.mock.calls.some((call) => call[0] === "list-devices");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

async function run(
  registry: Registry,
  params: Record<string, unknown>,
  ctx?: ToolContext
): Promise<FlowRunResult> {
  return asRun(
    await createRunFlowTool(registry).execute({}, { project_root: root, ...params } as never, ctx)
  );
}

async function runFlow(name: string, opts: { booted?: string[]; device?: string } = {}) {
  const { registry, invokeTool } = mockRegistry(opts);
  const result = await run(registry, { name, ...(opts.device ? { device: opts.device } : {}) });
  return { result, invokeTool };
}

async function until(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-step-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("a script step in a run", () => {
  it("runs the file, passes, and reports nothing the script printed", async () => {
    await write(
      "scripts/seed.mjs",
      `import fs from "node:fs";\n` +
        `console.log("seeded order 4711");\n` +
        `console.error("and a warning");\n` +
        `fs.writeFileSync(${JSON.stringify(markPath("seed"))}, "ran");`
    );
    await flow("seed", "steps:\n  - script: { path: ../../scripts/seed.mjs }\n");

    const { result, invokeTool } = await runFlow("seed");

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      kind: "script",
      status: "pass",
      target: "../../scripts/seed.mjs",
    });
    const whole = JSON.stringify(result);
    expect(whole).not.toContain("seeded order 4711");
    expect(whole).not.toContain("and a warning");
    expect(readMark("seed")).toBe("ran");
    expect(result.device).toBe("");
    expect(listedDevices(invokeTool)).toBe(false);
  });

  it("drains a script that floods stdout and stderr, on every step of the run", async () => {
    await write(
      "scripts/chatty.mjs",
      `import fs from "node:fs";\n` +
        `process.stdout.write("z".repeat(512 * 1024));\n` +
        `process.stderr.write("e".repeat(512 * 1024));\n` +
        `fs.appendFileSync(${JSON.stringify(markPath("chatty"))}, "x");`
    );
    const chattyStep = "  - script: { path: ../../scripts/chatty.mjs, timeout: 10000 }\n";
    await flow("chatty", "steps:\n" + chattyStep.repeat(3));

    const { result } = await runFlow("chatty");

    expect(result.steps.map((s) => s.status)).toEqual(["pass", "pass", "pass"]);
    expect(result.ok).toBe(true);
    expect(readMark("chatty")).toBe("xxx");
    expect(JSON.stringify(result)).not.toContain("zzz");
  });

  it("classifies as needing no device", () => {
    const registry = mockRegistry().registry;
    expect(stepRequiresDevice(registry, { kind: "script", path: "seed.mjs" })).toBe(false);
  });
});

describe("a script step that fails", () => {
  it("reports the script's own error as a fail and stops the flow", async () => {
    await write("scripts/boom.mjs", `throw new Error("seed API returned 500");`);
    await flow(
      "boom",
      "steps:\n" +
        "  - script: { path: ../../scripts/boom.mjs }\n" +
        "  - echo: never reached\n" +
        "  - wait: 1\n"
    );

    const { result } = await runFlow("boom");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
    expect(result.steps[0]!.reason).toContain("seed API returned 500");
    expect(result.steps.slice(1).map((s) => [s.kind, s.status])).toEqual([
      ["echo", "skip"],
      ["wait", "skip"],
    ]);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1); // echo is narration and is not counted
  });

  it("names the file, the line and the frames a bare node run would print", async () => {
    // Without them the step's whole diagnostic is one sentence: a throw writes
    // nothing to stderr, so there is no log either, and CI has nothing to
    // re-run against.
    await write(
      "scripts/deep.mjs",
      "function inner(o) { return o.id; }\nfunction outer() { return inner(undefined); }\nouter();\n"
    );
    await flow("deep", "steps:\n  - script: { path: ../../scripts/deep.mjs }\n");

    const { result } = await runFlow("deep");

    const reason = result.steps[0]!.reason!;
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
    expect(reason).toContain("Cannot read properties of undefined");
    // Project-relative, so the frames fit the step line the reason rides on.
    expect(reason).toContain("at inner (scripts/deep.mjs:1:30)");
    expect(reason).toContain("at outer (scripts/deep.mjs:2:27)");
    // Still one line: the frames are escaped like any other break in a reason.
    expect(reason).not.toMatch(/[\n\r]/);
  });

  it("leaves the host's own frames out of the reason", async () => {
    // A stack ends in the ESM loader and the runner that preloaded the script.
    // Those name no line the author can open, and they would crowd out the
    // frames that do.
    await write("scripts/boom2.mjs", `throw new Error("seed API returned 500");`);
    await flow("boom2", "steps:\n  - script: { path: ../../scripts/boom2.mjs }\n");

    const { result } = await runFlow("boom2");

    const reason = result.steps[0]!.reason!;
    expect(reason).toContain("at scripts/boom2.mjs:1:7");
    expect(reason).not.toContain("node:internal");
    expect(reason).not.toContain("flow-script-runner");
  });

  it("caps the frames it folds in and says how many it left out", async () => {
    await write(
      "scripts/recurse.mjs",
      "function down(n) { if (n === 0) throw new Error('bottom'); return down(n - 1); }\ndown(20);\n"
    );
    await flow("recurse", "steps:\n  - script: { path: ../../scripts/recurse.mjs }\n");

    const { result } = await runFlow("recurse");

    const reason = result.steps[0]!.reason!;
    expect(reason).toContain("bottom");
    expect(reason.match(/ at down \(/g) ?? []).toHaveLength(6);
    expect(reason).toMatch(/… \d+ more frames/);
  });

  it("keeps a multi-line throw message on the step's own line", async () => {
    // The ordinary shape of a rethrown API error. Raw, the JSON body lands at
    // column 0 under the `✗` line, outside the step framing every renderer is
    // built on — one line per step, reason interpolated straight in.
    await write(
      "scripts/rethrow.mjs",
      "throw new Error(`POST /orders returned 409\n" +
        '${JSON.stringify({ error: "duplicate_order" }, null, 2)}`);'
    );
    await flow("rethrow", "steps:\n  - script: { path: ../../scripts/rethrow.mjs }\n");

    const { result } = await runFlow("rethrow");

    const reason = result.steps[0]!.reason!;
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
    expect(reason).not.toMatch(/[\n\r\t]/);
    // Escaped, not stripped: the message is still readable and the breaks are
    // still recoverable.
    expect(reason).toContain("POST /orders returned 409\\n");
    expect(reason).toContain("duplicate_order");
  });

  it("denies a script the framing needed to forge a run verdict", async () => {
    // The step's reason is the only text on a report line that the script
    // itself writes. Given a raw newline it can put a whole summary line of its
    // own below a failed step and above the real one.
    await write(
      "scripts/forge.mjs",
      "throw new Error(`seed failed\\n\\nPASS — 3 passed, 0 failed, 0 errored, 0 skipped`);"
    );
    await flow("forge", "steps:\n  - script: { path: ../../scripts/forge.mjs }\n");

    const { result } = await runFlow("forge");

    const reason = result.steps[0]!.reason!;
    expect(result.ok).toBe(false);
    expect(reason.split("\n")).toHaveLength(1);
    expect(reason).toContain("PASS — 3 passed");
  });

  it("reports a script that stops its own process as a fail", async () => {
    await write("scripts/exit.mjs", `console.log("about to bail");\nprocess.exit(3);`);
    await flow("exit", "steps:\n  - script: { path: ../../scripts/exit.mjs }\n");

    const { result } = await runFlow("exit");

    expect(result.steps[0]).toMatchObject({ status: "fail" });
    expect(result.steps[0]!.reason).toContain("exit code 3");
    expect(JSON.stringify(result)).not.toContain("about to bail");
  });

  it("reports a script the host stopped at its time limit as an error", async () => {
    await write("scripts/slow.mjs", `await new Promise((r) => setTimeout(r, 30000));`);
    await flow("slow", "steps:\n  - script: { path: ../../scripts/slow.mjs, timeout: 800 }\n");

    const { result } = await runFlow("slow");

    expect(result.steps[0]).toMatchObject({ status: "error" });
    expect(result.steps[0]!.reason).toMatch(/did not finish within its 800ms time limit/);
    expect(result.errored).toBe(1);
  });
});

describe("a script path is checked at its own step", () => {
  it("reports a missing file with the path it resolved to", async () => {
    await flow("gone", "steps:\n  - script: { path: ../../scripts/gone.mjs }\n");

    const { result } = await runFlow("gone");

    expect(result.steps[0]).toMatchObject({ status: "fail", kind: "script" });
    expect(result.steps[0]!.reason).toContain('script "../../scripts/gone.mjs" does not exist');
    expect(result.steps[0]!.reason).toMatch(
      /resolved to \S*[/\\]\.argent[/\\]flows[/\\]\.\.[/\\]\.\.[/\\]scripts[/\\]gone\.mjs\)$/
    );
  });

  it("reports a path that names a directory rather than a file", async () => {
    await fs.mkdir(path.join(root, "scripts", "seed.mjs"), { recursive: true });
    await flow("dir", "steps:\n  - script: { path: ../../scripts/seed.mjs }\n");

    const { result } = await runFlow("dir");

    expect(result.steps[0]!.reason).toContain("is not a file");
  });

  it("reports a path that walks THROUGH a file as an ordinary missing file", async () => {
    // The kernel answers ENOTDIR, not ENOENT, when a directory component of the
    // path is a regular file. Nothing is there either way, so both read alike.
    await write("scripts/seed.mjs", `console.log("ok");`);
    await flow("through", "steps:\n  - script: { path: ../../scripts/seed.mjs/inner.mjs }\n");

    const { result } = await runFlow("through");

    expect(result.steps[0]).toMatchObject({ status: "fail", kind: "script" });
    expect(result.steps[0]!.reason).toContain("does not exist");
    expect(result.steps[0]!.reason).not.toContain("cannot be read");
  });

  it("reports a stat failure that is neither as its own text, not as absence", async () => {
    const tooLong = `${"n".repeat(300)}.mjs`;
    // The directory has to exist, or the missing component answers ENOENT
    // first and this never reaches the arm under test.
    await write("scripts/seed.mjs", `console.log("ok");`);
    await flow("unreadable", `steps:\n  - script: { path: ../../scripts/${tooLong} }\n`);

    const { result } = await runFlow("unreadable");

    expect(result.steps[0]).toMatchObject({ status: "fail", kind: "script" });
    expect(result.steps[0]!.reason).toContain("cannot be read: ");
    expect(result.steps[0]!.reason).toContain("ENAMETOOLONG");
  });

  it("never checks a path behind a guard that does not fire", async () => {
    await flow(
      "guarded",
      "steps:\n" +
        "  - when:\n" +
        "      platform: android\n" +
        "    steps:\n" +
        "      - script: { path: ../../scripts/nowhere.mjs }\n" +
        "  - echo: reached the end\n"
    );

    const { registry } = mockRegistry({ booted: [DEVICE] });
    const result = await run(registry, { name: "guarded", device: DEVICE });

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => [s.kind, s.status])).toEqual([
      ["when", "skip"],
      ["script", "skip"],
      ["echo", "pass"],
    ]);
  });

  it("refuses a mis-cased path, quoting the spelling on disk", async () => {
    // The one authoring error a local run cannot find: APFS and NTFS open
    // `CreateUser.mjs` for a file really named `createUser.mjs`, and the same
    // tree then fails with ENOENT on Linux CI.
    //
    // Ungated, because the VERDICT is not the filesystem's: classifyOnDiskSpelling
    // compares the supplied basename against readdir's own entries, lowercased,
    // so the refusal reproduces on a case-sensitive host too.
    await write("scripts/createUser.mjs", `console.log("ok");`);
    await flow("cased", "steps:\n  - script: { path: ../../scripts/CreateUser.mjs }\n");

    const { result } = await runFlow("cased");

    expect(result.steps[0]).toMatchObject({ status: "error" });
    expect(result.steps[0]!.reason).toContain(
      'mis-cased script path "../../scripts/CreateUser.mjs"'
    );
    expect(result.steps[0]!.reason).toContain('write it as "../../scripts/createUser.mjs"');
  });

  it("refuses a mis-cased spelling of a script reached through a cross-directory symlink", async () => {
    await fs.mkdir(path.join(root, "lib"), { recursive: true });
    await fs.writeFile(path.join(root, "lib", "real.mjs"), `console.log("ok");`);
    await fs.mkdir(path.join(root, "scripts"), { recursive: true });
    await fs.symlink(
      path.join(root, "lib", "real.mjs"),
      path.join(root, "scripts", "CreateUser.mjs")
    );
    await flow("cased-link", "steps:\n  - script: { path: ../../scripts/createUser.mjs }\n");

    const { result } = await runFlow("cased-link");

    expect(result.steps[0]).toMatchObject({ status: "error" });
    expect(result.steps[0]!.reason).toContain(
      'mis-cased script path "../../scripts/createUser.mjs"'
    );
  });

  it("asks for a rename when the spelling on disk is one no path could name", async () => {
    await write("scripts/ALT.MJS", `console.log("ok");`);
    await flow("noncase", "steps:\n  - script: { path: ../../scripts/alt.mjs }\n");

    const { result } = await runFlow("noncase");

    expect(result.steps[0]).toMatchObject({ status: "error" });
    expect(result.steps[0]!.reason).toContain('rename "ALT.MJS" to "alt.mjs" to run it');
    expect(result.steps[0]!.reason).not.toContain("write it as");
  });

  it("treats a hyphen difference as an ordinary missing file, not a casing problem", async () => {
    await write("scripts/createUser.mjs", `console.log("ok");`);
    await flow("hyphen", "steps:\n  - script: { path: ../../scripts/create-user.mjs }\n");

    const { result } = await runFlow("hyphen");

    expect(result.steps[0]!.reason).toContain("does not exist");
    expect(result.steps[0]!.reason).not.toContain("mis-cased");
  });
});

describe("where a script path resolves", () => {
  it("anchors at the flow file that names the step, not the root flow", async () => {
    await markingScript("scripts/shared.mjs", "shared");
    await write(
      path.join(".argent", "flows", "frag", "seed.yaml"),
      "steps:\n  - script: { path: ../../../scripts/shared.mjs }\n"
    );
    await flow("root-a", "steps:\n  - run: frag/seed.yaml\n");
    await write(
      path.join(".argent", "flows", "deep", "root-b.yaml"),
      "steps:\n  - run: ../frag/seed.yaml\n"
    );

    const a = await runFlow("root-a", { booted: [DEVICE], device: DEVICE });
    const aMark = readMark("shared");
    await fs.rm(markPath("shared"), { force: true });

    const bPath = path.join(root, ".argent", "flows", "deep", "root-b.yaml");
    const b = await run(
      mockRegistry({ booted: [DEVICE] }).registry,
      { flow_path: bPath, device: DEVICE },
      boundaryCtx(bPath)
    );

    for (const result of [a.result, b]) {
      const script = result.steps.find((s) => s.kind === "script");
      expect(script, JSON.stringify(result.steps)).toMatchObject({ status: "pass" });
    }
    expect(aMark).toBe("shared");
    expect(readMark("shared")).toBe("shared");
  });

  it("reaches a sibling directory's script through `..`", async () => {
    await markingScript("shared/scripts/seed.mjs", "sideways");
    await write(
      path.join(".argent", "flows", "onboarding", "login.yaml"),
      "steps:\n  - script: { path: ../../../shared/scripts/seed.mjs }\n"
    );
    await flow("compose", "steps:\n  - run: onboarding/login.yaml\n");

    const { result } = await runFlow("compose", { booted: [DEVICE], device: DEVICE });

    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.kind === "script")).toMatchObject({ status: "pass" });
    expect(readMark("sideways")).toBe("sideways");
  });

  it("resolves a `..` after a symlinked component with kernel semantics", async () => {
    await fs.mkdir(path.join(root, "lex", "other"), { recursive: true });
    await markingScript(path.join("lex", "seed.mjs"), "which", '"kernel-resolved"');
    await markingScript(path.join(".argent", "flows", "seed.mjs"), "which", '"lexical decoy"');
    await flow("linked", "steps:\n  - script: { path: link/../seed.mjs }\n");
    await fs.symlink(path.join(root, "lex", "other"), path.join(root, ".argent", "flows", "link"));

    const { result } = await runFlow("linked");

    expect(result.steps[0]).toMatchObject({ status: "pass", kind: "script" });
    expect(readMark("which")).toBe("kernel-resolved");
  });

  it("runs a script reached through a symlink under the name the flow spells", async () => {
    await markingScript("scripts/real.mjs", "alias", '"through the alias"');
    await fs.symlink(
      path.join(root, "scripts", "real.mjs"),
      path.join(root, "scripts", "alias.mjs")
    );
    await flow("alias", "steps:\n  - script: { path: ../../scripts/alias.mjs }\n");

    const { result } = await runFlow("alias");

    expect(result.steps[0]).toMatchObject({ status: "pass", kind: "script" });
    expect(readMark("alias")).toBe("through the alias");
  });

  it("anchors an explicit flow_path at that YAML's own directory", async () => {
    await markingScript("elsewhere/scripts/seed.mjs", "anchor", '"from flow_path"');
    await write("elsewhere/standalone.yaml", "steps:\n  - script: { path: scripts/seed.mjs }\n");

    const flowPath = path.join(root, "elsewhere", "standalone.yaml");
    const result = await run(
      mockRegistry().registry,
      { flow_path: flowPath },
      boundaryCtx(flowPath)
    );

    expect(result.ok).toBe(true);
    expect(readMark("anchor")).toBe("from flow_path");
  });

  it("runs the script in project_root, not in the flow file's directory", async () => {
    await markingScript("scripts/cwd.mjs", "cwd", "process.cwd()");
    await write(
      path.join("elsewhere", "standalone.yaml"),
      "steps:\n  - script: { path: ../scripts/cwd.mjs }\n"
    );
    const flowPath = path.join(root, "elsewhere", "standalone.yaml");
    const result = await run(
      mockRegistry().registry,
      { flow_path: flowPath },
      boundaryCtx(flowPath)
    );

    expect(result.ok).toBe(true);
    const reported = fsSync.realpathSync(readMark("cwd")!.trim());
    expect(reported).toBe(fsSync.realpathSync(root));
    expect(reported).not.toBe(fsSync.realpathSync(path.join(root, "elsewhere")));
  });
});

describe("which project root a script runs from", () => {
  /**
   * `flow-add-script` runs the script with the RECORDING's `project_root`; the
   * runner uses the ROOT run's. A fragment recorded in one project and composed
   * by a flow in another therefore runs its script somewhere else than where it
   * was recorded — which is what the tool's "it ran here as a replay of this
   * flow will" is qualified against.
   */
  it("gives a composed fragment's script the ROOT run's project root", async () => {
    const composer = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-composer-"));
    try {
      await write(
        "scripts/where.mjs",
        `import { writeFileSync } from "node:fs";\n` +
          `writeFileSync("./where.txt", process.cwd());`
      );
      await flow("frag", "steps:\n  - script: { path: ../../scripts/where.mjs }\n");
      const composed = path.join(composer, ".argent", "flows", "main.yaml");
      await fs.mkdir(path.dirname(composed), { recursive: true });
      // `run:` is always relative to the flow file that names it.
      const target = path
        .relative(path.dirname(composed), path.join(root, ".argent", "flows", "frag.yaml"))
        .split(path.sep)
        .join("/");
      await fs.writeFile(composed, `steps:\n  - run: ${target}\n`, "utf8");

      const direct = await runFlow("frag");
      expect(direct.result.ok).toBe(true);
      expect(fsSync.existsSync(path.join(root, "where.txt"))).toBe(true);
      await fs.rm(path.join(root, "where.txt"));

      // A flow that uses `run:` resolves a device even when every leaf is a
      // script — see "still resolves a device when the same flow uses run:".
      const { registry } = mockRegistry({ booted: [DEVICE] });
      const composedRun = await run(registry, {
        project_root: composer,
        name: "main",
        device: DEVICE,
      });

      expect(composedRun.ok).toBe(true);
      expect(fsSync.existsSync(path.join(composer, "where.txt"))).toBe(true);
      expect(fsSync.existsSync(path.join(root, "where.txt"))).toBe(false);
    } finally {
      await fs.rm(composer, { recursive: true, force: true });
    }
  });
});

describe("a script step and the run's device", () => {
  it("lets a script-only flow run with nothing booted", async () => {
    await write("scripts/seed.mjs", `console.log("no device needed");`);
    await flow(
      "deviceless",
      "steps:\n  - echo: seeding\n  - script: { path: ../../scripts/seed.mjs }\n"
    );

    const { result, invokeTool } = await runFlow("deviceless", { booted: [] });

    expect(result.ok).toBe(true);
    expect(result.device).toBe("");
    expect(listedDevices(invokeTool)).toBe(false);
  });

  it("still resolves a device when the same flow uses run:", async () => {
    await write("scripts/seed.mjs", `console.log("seeded");`);
    await write(
      path.join(".argent", "flows", "narrate.yaml"),
      "steps:\n  - echo: nothing but narration\n"
    );
    await flow(
      "with-run",
      "steps:\n  - script: { path: ../../scripts/seed.mjs }\n  - run: narrate.yaml\n"
    );

    const { result, invokeTool } = await runFlow("with-run", { booted: [DEVICE] });

    expect(result.ok).toBe(true);
    expect(result.device).toBe(DEVICE);
    expect(listedDevices(invokeTool)).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "pass" });
  });
});

describe("a script step in an uploaded flow", () => {
  it("is rejected before anything executes", async () => {
    const uploaded = await write(
      "materialized-upload.yaml",
      "steps:\n  - script: { path: seed.mjs }\n"
    );
    const { registry } = mockRegistry({ booted: [DEVICE] });

    await expect(
      createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: root, flow_file: uploaded, device: DEVICE },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            flow_file: {
              clientPath: "/client/.argent/flows/main.yaml",
              presentOnHost: false,
              viaUpload: true,
            },
          },
        }
      )
    ).rejects.toThrow(/script is not on this host/i);
  });

  it("is rejected from inside a when: block that would not fire", async () => {
    const uploaded = await write(
      "materialized-upload.yaml",
      "steps:\n  - when:\n      platform: android\n    steps:\n      - script: { path: seed.mjs }\n"
    );
    const { registry } = mockRegistry({ booted: [DEVICE] });

    await expect(
      createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: root, flow_file: uploaded, device: DEVICE },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            flow_file: {
              clientPath: "/client/.argent/flows/main.yaml",
              presentOnHost: false,
              viaUpload: true,
            },
          },
        }
      )
    ).rejects.toThrow(/script is not on this host/i);
  });
});

describe("cancelling a run that contains a script step", () => {
  it("skips a script that had not started", async () => {
    await write("scripts/seed.mjs", `console.log("must not run");`);
    await flow("pre-cancel", "steps:\n  - script: { path: ../../scripts/seed.mjs }\n");

    const controller = new AbortController();
    controller.abort();
    const { registry } = mockRegistry();
    const result = await run(registry, { name: "pre-cancel" }, {
      signal: controller.signal,
    } as ToolContext);

    expect(result.steps[0]).toMatchObject({
      kind: "script",
      status: "skip",
      reason: "run aborted",
    });
    expect(result.aborted).toBe(true);
    expect(result.skipped).toBe(1);
  });

  it("errors a script that HAD started, because what it did is still done", async () => {
    const marker = path.join(root, "started.txt");
    await write(
      "scripts/slow.mjs",
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(marker)}, "go");\n` +
        `await new Promise((r) => setTimeout(r, 30000));`
    );
    await flow("mid-cancel", "steps:\n  - script: { path: ../../scripts/slow.mjs }\n  - wait: 1\n");

    const controller = new AbortController();
    const { registry } = mockRegistry();
    const pending = run(registry, { name: "mid-cancel" }, {
      signal: controller.signal,
    } as ToolContext);
    await until(() => fsSync.existsSync(marker), "the script to start");
    controller.abort();

    const result = await pending;
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "error" });
    expect(result.steps[0]!.reason).toMatch(/cancelled/i);
    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("says the run was cancelled on the steps after the script, not just under it", async () => {
    // The script's `error` stops the run, so the steps below it take the
    // hard-stop path rather than the abort guard every other cancelled step
    // uses. They still have to say why they did not run: a cancellation is not
    // collateral of a step that failed.
    const marker = path.join(root, "started-2.txt");
    await write(
      "scripts/slow.mjs",
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(marker)}, "go");\n` +
        `await new Promise((r) => setTimeout(r, 30000));`
    );
    await flow(
      "mid-cancel-tail",
      "steps:\n  - script: { path: ../../scripts/slow.mjs }\n  - wait: 1\n  - wait: 1\n"
    );

    const controller = new AbortController();
    const { registry } = mockRegistry();
    const pending = run(registry, { name: "mid-cancel-tail" }, {
      signal: controller.signal,
    } as ToolContext);
    await until(() => fsSync.existsSync(marker), "the script to start");
    controller.abort();

    const result = await pending;
    expect(result.steps.slice(1).map((s) => [s.kind, s.status, s.reason])).toEqual([
      ["wait", "skip", "run aborted"],
      ["wait", "skip", "run aborted"],
    ]);
  });
});
