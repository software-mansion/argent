import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore, type Registry, type ToolContext } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import { stepRequiresDevice } from "../../../src/tools/flows/flow-device";

/**
 * The `script:` step in a run: where its path resolves, what it reports, and
 * what it does to the flow around it. Every flow here is device-free unless the
 * test is about a device, and every script is a few lines of plain ESM — the
 * executor's own behaviour is covered beside it, in flow-script-run.test.ts.
 *
 * Real child processes, so the budgets are generous; nothing here polls without
 * a deadline.
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

/** Write a file under the project root, creating its directories. */
async function write(relative: string, contents: string): Promise<string> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
  return file;
}

/** A saved flow under `.argent/flows`, written as raw YAML. */
function flow(name: string, yaml: string): Promise<string> {
  return write(path.join(".argent", "flows", `${name}.yaml`), yaml);
}

/** The ctx the flow_path file-input boundary produces for a co-located path. */
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

/** Whether the run looked for a device at all. */
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

/** Run a saved flow, device-free unless the test says otherwise. */
async function runFlow(name: string, opts: { booted?: string[]; device?: string } = {}) {
  const { registry, invokeTool } = mockRegistry(opts);
  const result = await run(registry, { name, ...(opts.device ? { device: opts.device } : {}) });
  return { result, invokeTool };
}

/** Poll until `predicate` holds, or fail with `label`. */
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
  it("runs the file, passes, and carries its output into the report", async () => {
    await write("scripts/seed.mjs", `console.log("seeded order 4711");`);
    await flow("seed", "steps:\n  - script: { path: ../../scripts/seed.mjs }\n");

    const { result, invokeTool } = await runFlow("seed");

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      kind: "script",
      status: "pass",
      target: "../../scripts/seed.mjs",
    });
    expect(result.steps[0]!.scriptLog).toContain("seeded order 4711");
    // Device-free: nothing was ever looked up, and the run is not attributed to
    // whatever happens to be booted on the machine running the suite.
    expect(result.device).toBe("");
    expect(listedDevices(invokeTool)).toBe(false);
  });

  it("carries stderr into the same log as stdout", async () => {
    // One log, not two fields: a script's diagnostics and its progress belong in
    // one place. Cross-STREAM interleaving is the kernel's to decide (stdout and
    // stderr are separate pipes), so only each stream's own order is pinned.
    await write(
      "scripts/noisy.mjs",
      `console.log("one");\nconsole.error("problem");\nconsole.log("three");`
    );
    await flow("noisy", "steps:\n  - script: { path: ../../scripts/noisy.mjs }\n");

    const { result } = await runFlow("noisy");

    const log = result.steps[0]!.scriptLog!;
    expect(log).toContain("problem");
    expect(log.indexOf("one")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("three")).toBeGreaterThan(log.indexOf("one"));
    expect(result.steps[0]!.scriptLogTruncated).toBeUndefined();
  });

  it("flags a log a limit cut short, because the text carries no marker", async () => {
    // 64 KiB is the per-step ceiling; a chatty script silently losing the tail
    // would read as a complete record of what it did.
    await write(
      "scripts/chatty.mjs",
      `for (let i = 0; i < 4000; i++) console.log("line " + i + " " + "x".repeat(40));`
    );
    await flow("chatty", "steps:\n  - script: { path: ../../scripts/chatty.mjs }\n");

    const { result } = await runFlow("chatty");

    expect(result.steps[0]).toMatchObject({ status: "pass", scriptLogTruncated: true });
    expect(result.steps[0]!.scriptLog).toContain("line 0 ");
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
    // A failed leaf step hard-stops the flow, exactly like every other kind.
    expect(result.steps.slice(1).map((s) => [s.kind, s.status])).toEqual([
      ["echo", "skip"],
      ["wait", "skip"],
    ]);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1); // echo is narration and is not counted
  });

  it("reports a script that stops its own process as a fail", async () => {
    await write("scripts/exit.mjs", `console.log("about to bail");\nprocess.exit(3);`);
    await flow("exit", "steps:\n  - script: { path: ../../scripts/exit.mjs }\n");

    const { result } = await runFlow("exit");

    expect(result.steps[0]).toMatchObject({ status: "fail" });
    expect(result.steps[0]!.reason).toContain("exit code 3");
    // The log survives the exit — it is the only record of what ran.
    expect(result.steps[0]!.scriptLog).toContain("about to bail");
  });

  it("reports a script the host stopped at its time limit as an error", async () => {
    // `fail` would read as a regression in the flow; the host stopped it.
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
    // The path is the one the runner formed — the flow file's own directory
    // with the target concatenated on, `..` intact, since a lexical collapse is
    // exactly what resolution must not do.
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
    // path is a regular file. Nothing is there either way, so the author reads
    // the same sentence rather than an errno.
    await write("scripts/seed.mjs", `console.log("ok");`);
    await flow("through", "steps:\n  - script: { path: ../../scripts/seed.mjs/inner.mjs }\n");

    const { result } = await runFlow("through");

    expect(result.steps[0]).toMatchObject({ status: "fail", kind: "script" });
    expect(result.steps[0]!.reason).toContain("does not exist");
    expect(result.steps[0]!.reason).not.toContain("cannot be read");
  });

  it("reports a stat failure that is neither as its own text, not as absence", async () => {
    // Everything else the kernel can answer — a locked parent directory, a
    // dangling symlink, a name longer than the filesystem allows (used here
    // because it needs no permission juggling and reproduces for any user) —
    // is a fact about the host, and guessing "does not exist" for it would
    // send the author looking for a file that may well be there.
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
    // The check is at the step, not in a preflight pass — a preflight would
    // fail this flow over a path nothing ever opens.
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
    // Ungated, because the VERDICT is not the filesystem's. classifyOnDiskSpelling
    // compares the supplied basename against readdir's own entries, lowercased —
    // so the refusal reproduces on the case-sensitive platform the refusal
    // exists to protect, which is also the only platform CI runs on.
    await write("scripts/createUser.mjs", `console.log("ok");`);
    await flow("cased", "steps:\n  - script: { path: ../../scripts/CreateUser.mjs }\n");

    const { result } = await runFlow("cased");

    expect(result.steps[0]).toMatchObject({ status: "error" });
    expect(result.steps[0]!.reason).toContain(
      'mis-cased script path "../../scripts/CreateUser.mjs"'
    );
    expect(result.steps[0]!.reason).toContain('write it as "../../scripts/createUser.mjs"');
  });

  it("asks for a rename when the spelling on disk is one no path could name", async () => {
    // The other half of the mis-cased arm: `ALT.MJS` case-folds onto the
    // requested `alt.mjs`, so the file IS the one meant — but a path quoting it
    // back would be refused by parseScriptPath (the extension must be a
    // lowercase `.mjs`), so pointing there would be a dead end. Ask for the
    // rename the file really needs instead.
    await write("scripts/ALT.MJS", `console.log("ok");`);
    await flow("noncase", "steps:\n  - script: { path: ../../scripts/alt.mjs }\n");

    const { result } = await runFlow("noncase");

    expect(result.steps[0]).toMatchObject({ status: "error" });
    expect(result.steps[0]!.reason).toContain('rename "ALT.MJS" to "alt.mjs" to run it');
    expect(result.steps[0]!.reason).not.toContain("write it as");
  });

  it("treats a hyphen difference as an ordinary missing file, not a casing problem", async () => {
    // Only the CASE can differ: `create-user.mjs` names a different file than
    // `createUser.mjs` on all three platforms.
    await write("scripts/createUser.mjs", `console.log("ok");`);
    await flow("hyphen", "steps:\n  - script: { path: ../../scripts/create-user.mjs }\n");

    const { result } = await runFlow("hyphen");

    expect(result.steps[0]!.reason).toContain("does not exist");
    expect(result.steps[0]!.reason).not.toContain("mis-cased");
  });
});

describe("where a script path resolves", () => {
  it("anchors at the flow file that names the step, not the root flow", async () => {
    // The property `run:` composition exists to have: the SAME fragment
    // resolves the SAME script whichever flow composed it.
    await write("scripts/shared.mjs", `console.log("shared script ran");`);
    await write(
      path.join(".argent", "flows", "frag", "seed.yaml"),
      "steps:\n  - script: { path: ../../../scripts/shared.mjs }\n"
    );
    await flow("root-a", "steps:\n  - run: frag/seed.yaml\n");
    await write(
      path.join(".argent", "flows", "deep", "root-b.yaml"),
      "steps:\n  - run: ../frag/seed.yaml\n"
    );

    // Both flows compose with `run:`, which needs a device whatever its
    // fragment holds — the script step is what is device-free, not the flow.
    const a = await runFlow("root-a", { booted: [DEVICE], device: DEVICE });
    const bPath = path.join(root, ".argent", "flows", "deep", "root-b.yaml");
    const b = await run(
      mockRegistry({ booted: [DEVICE] }).registry,
      { flow_path: bPath, device: DEVICE },
      boundaryCtx(bPath)
    );

    for (const result of [a.result, b]) {
      const script = result.steps.find((s) => s.kind === "script");
      expect(script, JSON.stringify(result.steps)).toMatchObject({ status: "pass" });
      expect(script!.scriptLog).toContain("shared script ran");
    }
  });

  it("reaches a sibling directory's script through `..`", async () => {
    await write("shared/scripts/seed.mjs", `console.log("sideways");`);
    await write(
      path.join(".argent", "flows", "onboarding", "login.yaml"),
      "steps:\n  - script: { path: ../../../shared/scripts/seed.mjs }\n"
    );
    await flow("compose", "steps:\n  - run: onboarding/login.yaml\n");

    const { result } = await runFlow("compose", { booted: [DEVICE], device: DEVICE });

    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.kind === "script")!.scriptLog).toContain("sideways");
  });

  it("resolves a `..` after a symlinked component with kernel semantics", async () => {
    // .argent/flows/link is a symlink to lex/other, so on disk
    // `link/../seed.mjs` means lex/seed.mjs — `..` names the parent of the
    // link's TARGET. A lexical collapse of the spelling would instead name the
    // flows-dir sibling seed.mjs, planted here as a decoy, so only
    // kernel-faithful resolution runs the file the written path denotes. The
    // property is `run:`-proven; a script path shares the resolver, and this is
    // what pins that it keeps sharing it.
    await fs.mkdir(path.join(root, "lex", "other"), { recursive: true });
    await fs.writeFile(path.join(root, "lex", "seed.mjs"), `console.log("kernel-resolved");`);
    await write(path.join(".argent", "flows", "seed.mjs"), `console.log("lexical decoy");`);
    await flow("linked", "steps:\n  - script: { path: link/../seed.mjs }\n");
    await fs.symlink(path.join(root, "lex", "other"), path.join(root, ".argent", "flows", "link"));

    const { result } = await runFlow("linked");

    expect(result.steps[0]).toMatchObject({ status: "pass", kind: "script" });
    expect(result.steps[0]!.scriptLog).toContain("kernel-resolved");
    expect(result.steps[0]!.scriptLog).not.toContain("lexical decoy");
  });

  it("runs a script reached through a symlink under the name the flow spells", async () => {
    // The reason the casing check lists the SPELLED directory rather than
    // realpath'ing first: an alias is a legitimate way to name a shared script,
    // and readdir sees the link itself, so `alias.mjs` is an exact entry and
    // the step runs. Realpath'ing first would compare against `real.mjs` and
    // refuse the flow as mis-cased.
    await write("scripts/real.mjs", `console.log("through the alias");`);
    await fs.symlink(
      path.join(root, "scripts", "real.mjs"),
      path.join(root, "scripts", "alias.mjs")
    );
    await flow("alias", "steps:\n  - script: { path: ../../scripts/alias.mjs }\n");

    const { result } = await runFlow("alias");

    expect(result.steps[0]).toMatchObject({ status: "pass", kind: "script" });
    expect(result.steps[0]!.scriptLog).toContain("through the alias");
  });

  it("anchors an explicit flow_path at that YAML's own directory", async () => {
    await write("elsewhere/scripts/seed.mjs", `console.log("from flow_path");`);
    await write("elsewhere/standalone.yaml", "steps:\n  - script: { path: scripts/seed.mjs }\n");

    const flowPath = path.join(root, "elsewhere", "standalone.yaml");
    const result = await run(
      mockRegistry().registry,
      { flow_path: flowPath },
      boundaryCtx(flowPath)
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0]!.scriptLog).toContain("from flow_path");
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
    // `run:` needs one whatever its fragment contains — the runner resolves the
    // target at run time, not during classification — so a script-only flow
    // that composes anything is not device-free.
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
    // `skip` means "the step did not run", and every reader of a report acts on
    // that meaning. A script that reached a backend and was then killed is the
    // one case where saying so is dangerous.
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
});
