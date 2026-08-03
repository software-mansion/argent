import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import { ArtifactStore } from "@argent/registry";

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import {
  createRunFlowTool,
  resolveFlowSource,
  type FlowRunResult,
  type FlowPrerequisiteNotice,
} from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import {
  clearActiveFlow,
  setActiveProjectRoot,
  clearActiveProjectRoot,
  flowsDirFor,
  parseFlow,
  serializeFlow,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

// ── Helpers ──────────────────────────────────────────────────────────

function assertFlowRunResult(
  r: FlowRunResult | FlowPrerequisiteNotice
): asserts r is FlowRunResult {
  if (!("steps" in r)) {
    throw new Error(`expected FlowRunResult, got prerequisite notice: ${r.notice}`);
  }
}

let tmpDir: string;

function createMockRegistry(
  tools: Record<string, { result: unknown; outputHint?: string; throws?: boolean }> = {}
) {
  return {
    invokeTool: vi.fn(async (id: string) => {
      const entry = tools[id];
      if (!entry) throw new Error(`Tool "${id}" not found`);
      if (entry.throws) throw new Error(`Tool "${id}" failed`);
      return entry.result;
    }),
    getTool: vi.fn((id: string) => {
      const entry = tools[id];
      if (!entry) return undefined;
      return { outputHint: entry.outputHint };
    }),
  } as unknown as Registry;
}

async function readFlowFile(name: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, ".argent", "flows", `${name}.yaml`), "utf8");
}

const PREREQ = "App on home screen";

// ── Setup / teardown ─────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-test-"));
  setActiveProjectRoot(tmpDir);
  clearActiveFlow();
});

afterEach(async () => {
  clearActiveFlow();
  clearActiveProjectRoot();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── flow-start-recording ─────────────────────────────────────────────

describe("flow-start-recording", () => {
  it("creates the .argent/flows dir and a .yaml file with header", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "test-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    expect(result.message).toContain("test-flow");

    const content = await readFlowFile("test-flow");
    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe(PREREQ);
    expect(flow.steps).toEqual([]);
  });

  it("sets the active flow", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "my-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowInsertEchoTool.execute({}, { message: "test" });
    expect(result.message).toContain("my-flow");
  });

  it("overwrites an existing flow file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute({}, { message: "line1" });

    // Start again with same name — should reset
    await flowStartRecordingTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, executionPrerequisite: "Different prereq" }
    );
    const content = await readFlowFile("overwrite");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
    expect(flow.executionPrerequisite).toBe("Different prereq");
  });

  it("rejects a relative project_root", async () => {
    await expect(
      flowStartRecordingTool.execute(
        {},
        { name: "relative", project_root: "./not-absolute", executionPrerequisite: PREREQ }
      )
    ).rejects.toThrow("project_root must be an absolute path");
  });
});

// ── flow-start-recording edge cases ──────────────────────────────────

describe("flow-start-recording edge cases", () => {
  it("starting a new flow while another is recording notifies about the switch", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "first-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "second-flow", project_root: tmpDir, executionPrerequisite: "Different" }
    );

    // Should mention both the old and new flow
    expect(result.message).toContain("first-flow");
    expect(result.message).toContain("second-flow");
    expect(result.previousFlow).toBe("first-flow");

    // Adding a step should target second-flow, not first-flow
    const echoResult = await flowInsertEchoTool.execute({}, { message: "goes to second" });
    expect(echoResult.message).toContain("second-flow");

    // first-flow should still exist on disk but be empty
    const firstContent = await readFlowFile("first-flow");
    const firstFlow = parseFlow(firstContent);
    expect(firstFlow.steps).toEqual([]);

    // second-flow should have the echo
    const secondContent = await readFlowFile("second-flow");
    const secondFlow = parseFlow(secondContent);
    expect(secondFlow.steps).toEqual([{ kind: "echo", message: "goes to second" }]);
  });

  it("restarting the same flow does not report a switch", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute({}, { message: "will be reset" });

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, executionPrerequisite: "Updated prereq" }
    );

    // Should NOT mention a switch — it's the same flow being restarted
    expect(result.message).not.toContain("Switched");
    expect(result.previousFlow).toBeUndefined();
    expect(result.message).toContain("same-flow");
  });

  it("does not report a switch when no flow was previously active", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "fresh-start", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    expect(result.message).not.toContain("Switched");
    expect(result.previousFlow).toBeUndefined();
  });
});

// ── flow-add-echo ────────────────────────────────────────────────────

describe("flow-add-echo", () => {
  it("appends an echo entry to the flow file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "echo-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowInsertEchoTool.execute({}, { message: "Hello world" });

    expect(result.message).toContain("echo-test");
    const flow = parseFlow(result.flowFile);
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello world" }]);
  });

  it("appends multiple echo entries", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute({}, { message: "First" });
    const result = await flowInsertEchoTool.execute({}, { message: "Second" });

    const flow = parseFlow(result.flowFile);
    expect(flow.steps).toEqual([
      { kind: "echo", message: "First" },
      { kind: "echo", message: "Second" },
    ]);
  });

  it("throws when no active flow", async () => {
    await expect(flowInsertEchoTool.execute({}, { message: "oops" })).rejects.toThrow(
      "No active flow"
    );
  });
});

// ── flow-add-step ────────────────────────────────────────────────────

describe("flow-add-step", () => {
  it("executes the tool and records on success", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "step-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await tool.execute({}, { command: "tap", args: '{"x":0.5,"y":0.3}' });

    expect(result.toolResult).toEqual({ tapped: true });
    const flow = parseFlow(result.flowFile);
    expect(flow.steps).toEqual([{ kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } }]);
    expect(registry.invokeTool).toHaveBeenCalledWith("tap", {
      x: 0.5,
      y: 0.3,
    });
  });

  it("propagates the request's telemetry attribution to the recorded sub-tool", async () => {
    const registry = createMockRegistry({ tap: { result: { ok: true } } });
    const tool = createFlowAddStepTool(registry);
    const release = vi.fn();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => release);
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await flowStartRecordingTool.execute(
      {},
      { name: "tele-step", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await tool.execute({}, { command: "tap", args: '{"x":0.5}' }, ctx);

    expect(recordChildInvocation).toHaveBeenCalledOnce();
    const childId = recordChildInvocation.mock.calls[0]![0];
    // The sub-tool's own args reach the recorder so it can derive the platform.
    expect(recordChildInvocation).toHaveBeenCalledWith(childId, { x: 0.5 });
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "tap",
      { x: 0.5 },
      expect.objectContaining({ toolInvocationId: childId, recordChildInvocation })
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not record when tool fails", async () => {
    const registry = createMockRegistry({
      tap: { result: null, throws: true },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "fail-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(tool.execute({}, { command: "tap", args: '{"x":0.5}' })).rejects.toThrow(
      'Tool "tap" failed'
    );

    const content = await readFlowFile("fail-test");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });

  it("handles omitted args", async () => {
    const registry = createMockRegistry({
      screenshot: { result: { url: "http://..." } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "no-args", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await tool.execute({}, { command: "screenshot" });

    const content = await readFlowFile("no-args");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([{ kind: "tool", name: "screenshot", args: {} }]);
    expect(registry.invokeTool).toHaveBeenCalledWith("screenshot", {});
  });

  it("throws when no active flow", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await expect(tool.execute({}, { command: "tap", args: '{"x":0.5}' })).rejects.toThrow(
      "No active flow"
    );
  });

  it("records a restart-app as a portable launch step (device id dropped)", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true, bundleId: "com.acme.app" } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "launch-rewrite", project_root: tmpDir });
    const result = await tool.execute(
      {},
      { command: "restart-app", args: '{"udid":"ABC","bundleId":"com.acme.app"}' }
    );

    // Ran live with the full args…
    expect(registry.invokeTool).toHaveBeenCalledWith("restart-app", {
      udid: "ABC",
      bundleId: "com.acme.app",
    });
    // …but recorded the launch directive, making this an e2e flow.
    expect(parseFlow(result.flowFile).steps).toEqual([{ kind: "launch", app: "com.acme.app" }]);
  });

  it("keeps a restart-app with extra args (e.g. activity) as a raw tool step", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "launch-activity", project_root: tmpDir });
    const result = await tool.execute(
      {},
      {
        command: "restart-app",
        args: '{"udid":"ABC","bundleId":"com.acme.app","activity":".Main"}',
      }
    );

    expect(parseFlow(result.flowFile).steps).toEqual([
      {
        kind: "tool",
        name: "restart-app",
        args: { bundleId: "com.acme.app", activity: ".Main" },
      },
    ]);
  });

  it("rejects a leading launch recorded into a prerequisite-bearing recording", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true } },
    });
    const tool = createFlowAddStepTool(registry);

    // A prerequisite documents a fragment; a leading launch would make it e2e —
    // contradictory, so the append must fail and record nothing.
    await flowStartRecordingTool.execute(
      {},
      { name: "contradiction", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute({}, { command: "restart-app", args: '{"bundleId":"com.acme.app"}' })
    ).rejects.toThrow(/must not declare executionPrerequisite/i);

    const flow = parseFlow(await readFlowFile("contradiction"));
    expect(flow.steps).toEqual([]);
  });

  async function writeSiblingFlow(name: string, yaml: string): Promise<void> {
    await fs.writeFile(path.join(tmpDir, ".argent", "flows", `${name}.yaml`), yaml, "utf8");
  }

  it("records a flow-execute of a sibling fragment as a run: directive", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-test", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        command: "flow-execute",
        args: JSON.stringify({
          name: "login",
          project_root: tmpDir,
          device: "ABC",
          prerequisiteAcknowledged: true,
        }),
      }
    );

    // Ran the fragment live to set up state…
    expect(result.toolResult).toEqual({ ok: true, steps: [] });
    // …but recorded the portable composition directive, not the raw tool call.
    expect(parseFlow(result.flowFile).steps).toEqual([{ kind: "run", flow: "login" }]);
  });

  it("records a run: directive when the target is an e2e flow", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-e2e", project_root: tmpDir });
    await writeSiblingFlow("other-e2e", "steps:\n  - launch: com.acme.app\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        command: "flow-execute",
        args: JSON.stringify({ name: "other-e2e", project_root: tmpDir, device: "ABC" }),
      }
    );

    // e2e flows now compose via run: just like fragments — their launch runs inline.
    expect(parseFlow(result.flowFile).steps).toEqual([{ kind: "run", flow: "other-e2e" }]);
  });

  it("keeps the raw flow-execute step when the target is not a sibling", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-missing", project_root: tmpDir });

    const result = await tool.execute(
      {},
      {
        command: "flow-execute",
        args: JSON.stringify({ name: "elsewhere", project_root: tmpDir }),
      }
    );

    expect(result.message).toMatch(/could not resolve/i);
    expect(parseFlow(result.flowFile).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "elsewhere", project_root: tmpDir } },
    ]);
  });

  it("strips the device id from a raw flow-execute step (issue #607)", async () => {
    // Deliberately a target that is NOT a resolvable sibling: a resolvable one
    // records as `run:`, which carries no args at all and so could never show
    // this. The raw fallback is the form that kept the record-time device id and
    // pinned every replay to it.
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-pinned", project_root: tmpDir });

    const result = await tool.execute(
      {},
      {
        command: "flow-execute",
        args: JSON.stringify({ name: "elsewhere", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(parseFlow(result.flowFile).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "elsewhere", project_root: tmpDir } },
    ]);
  });

  it("records a flow-execute of a sibling flow_path as a run: directive", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-path", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
    const sibling = path.join(tmpDir, ".argent", "flows", "login.yaml");

    const result = await tool.execute(
      {},
      {
        command: "flow-execute",
        args: JSON.stringify({ flow_path: sibling, project_root: tmpDir }),
      }
    );

    expect(parseFlow(result.flowFile).steps).toEqual([{ kind: "run", flow: "login" }]);
    // The live sub-invoke gets no file-input boundary, so it must run the
    // sibling by name…
    const nested = (registry.invokeTool as any).mock.calls[0][1];
    expect(nested).toEqual({ name: "login", project_root: tmpDir });
    // …which a real tool-server resolves to that same file.
    expect(await resolveFlowSource(nested)).toEqual({ filePath: sibling, flowName: "login" });
  });

  it("rejects a flow_path outside the recording's flow directory without running it", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-outside", project_root: tmpDir });
    const outside = path.join(tmpDir, "elsewhere.yaml");
    await fs.writeFile(outside, "steps:\n  - echo: hi\n", "utf8");

    await expect(
      tool.execute(
        {},
        {
          command: "flow-execute",
          args: JSON.stringify({ flow_path: outside, project_root: tmpDir }),
        }
      )
    ).rejects.toThrow(/not in the recording's flow directory/i);

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-outside")).steps).toEqual([]);
  });

  it('rejects a sibling flow_path containing a ".." segment without running it', async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-dotdot", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
    // Assembled by hand — path.join would collapse the "..". Every resolve-based
    // check downstream accepts this string: it folds back to the sibling
    // login.yaml lexically, but a symlinked "sub" would make the kernel open a
    // different file than the rewritten name runs.
    const dotdot = [tmpDir, ".argent", "flows", "sub", "..", "login.yaml"].join(path.sep);

    await expect(
      tool.execute(
        {},
        {
          command: "flow-execute",
          args: JSON.stringify({ flow_path: dotdot, project_root: tmpDir }),
        }
      )
    ).rejects.toThrow(/must not contain "\.\." segments/);

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-dotdot")).steps).toEqual([]);
  });

  // The flows dir already supplies the CLI's "dir/" shape, so these vary the
  // basename: path.extname reads each as an extensionless dotfile, and the
  // extension arm would claim ".yaml" is missing from a path that ends in it.
  it.each([[".yaml"], [".YAML"], [".Yaml"]])(
    "names the missing stem, not the extension, for a sibling named %s",
    async (basename) => {
      const registry = createMockRegistry({
        "flow-execute": { result: { ok: true, steps: [] } },
      });
      const tool = createFlowAddStepTool(registry);

      await flowStartRecordingTool.execute({}, { name: "compose-stemless", project_root: tmpDir });
      const stemless = path.join(tmpDir, ".argent", "flows", basename);

      const record = () =>
        tool.execute(
          {},
          {
            command: "flow-execute",
            args: JSON.stringify({ flow_path: stemless, project_root: tmpDir }),
          }
        );
      await expect(record()).rejects.toThrow('Invalid flow name ""');
      await expect(record()).rejects.not.toThrow(/must use the (lowercase )?\.yaml extension/);

      expect(registry.invokeTool).not.toHaveBeenCalled();
      expect(parseFlow(await readFlowFile("compose-stemless")).steps).toEqual([]);
    }
  );

  it("still blames the extension when a sibling's stem carries the wrong case", async () => {
    // The companion to the case above: extname is non-empty here, so this input
    // must keep reaching the lowercase-extension arm.
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-cased", project_root: tmpDir });

    await expect(
      tool.execute(
        {},
        {
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "Login.YAML"),
            project_root: tmpDir,
          }),
        }
      )
    ).rejects.toThrow('flow files must use the lowercase .yaml extension, not ".YAML"');

    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("rejects a sibling flow_path that the call's project_root does not resolve to", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-mismatch", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    await expect(
      tool.execute(
        {},
        {
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "login.yaml"),
            project_root: path.join(tmpDir, "other-project"),
          }),
        }
      )
    ).rejects.toThrow(/does not resolve "login" to it/);

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-mismatch")).steps).toEqual([]);
  });

  // path.resolve anchors a relative project_root at the tool SERVER's cwd — a
  // directory with no relationship to the calling agent's — so a resolve-based
  // comparison would accept or reject the same call depending on where the
  // server was started. Pin the deterministic contract: a relative root is
  // refused outright, EVEN when it would resolve the sibling correctly against
  // this very process's cwd (the one shape a cwd-anchored comparison would let
  // through). Each case mocks the cwd to make the root line up with tmpDir.
  it.each([
    ['"."', (dir: string) => ({ root: ".", cwd: dir })],
    [
      "a bare directory name",
      (dir: string) => ({ root: path.basename(dir), cwd: path.dirname(dir) }),
    ],
  ])(
    "rejects a relative project_root (%s) even when it resolves against the server's cwd",
    async (_shape, build) => {
      const registry = createMockRegistry({
        "flow-execute": { result: { ok: true, steps: [] } },
      });
      const tool = createFlowAddStepTool(registry);

      await flowStartRecordingTool.execute({}, { name: "compose-relative", project_root: tmpDir });
      await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
      const sibling = path.join(tmpDir, ".argent", "flows", "login.yaml");

      const { root, cwd } = build(tmpDir);
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
      try {
        // Sanity: under this cwd the relative root DOES name the sibling, so a
        // cwd-anchored comparison would have accepted the call.
        expect(path.resolve(flowsDirFor(root), "login.yaml")).toBe(sibling);

        await expect(
          tool.execute(
            {},
            {
              command: "flow-execute",
              args: JSON.stringify({ flow_path: sibling, project_root: root }),
            }
          )
        ).rejects.toThrow(/project_root must be an absolute path/);
      } finally {
        cwdSpy.mockRestore();
      }

      // Rejected before the rewrite and the live sub-invoke: the args were
      // never forwarded (mutated or otherwise) and nothing was recorded.
      expect(registry.invokeTool).not.toHaveBeenCalled();
      expect(parseFlow(await readFlowFile("compose-relative")).steps).toEqual([]);
    }
  );

  it("names the absolute-path requirement when project_root is missing", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-rootless", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    await expect(
      tool.execute(
        {},
        {
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "login.yaml"),
          }),
        }
      )
    ).rejects.toThrow(/project_root must be an absolute path \(got none\)/);

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-rootless")).steps).toEqual([]);
  });

  // The two shapes add-step must NOT rewrite: naming both sources, or neither,
  // is flow-execute's schema to judge. The both-sources case is the dangerous
  // one — rewriting it would delete flow_path and overwrite the caller's name
  // with the stem, so a call asking for "checkout" would run and record "login"
  // with nothing to say the requested name was discarded.
  it.each([
    [
      "names both sources",
      (sibling: string, root: string) => ({
        name: "checkout",
        flow_path: sibling,
        project_root: root,
      }),
    ],
    ["names neither source", (_sibling: string, root: string) => ({ project_root: root })],
  ])("hands a flow-execute that %s to flow-execute verbatim", async (_shape, buildArgs) => {
    // flow-execute refuses both shapes on the source count, so the sub-invoke
    // fails and nothing is recorded; the throwing mock stands in for that.
    const registry = createMockRegistry({ "flow-execute": { result: null, throws: true } });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-ambiguous", project_root: tmpDir });
    // For the both-sources shape, a genuinely rewritable target: every check
    // downstream of the bail-out accepts this flow_path, so the bail-out is the
    // only thing standing between the caller's "checkout" and a swap to "login".
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
    const args = buildArgs(path.join(tmpDir, ".argent", "flows", "login.yaml"), tmpDir);

    await expect(
      tool.execute({}, { command: "flow-execute", args: JSON.stringify(args) })
    ).rejects.toThrow();

    // The nested call must reach flow-execute exactly as written — no flow_path
    // deleted, no name substituted…
    expect(registry.invokeTool).toHaveBeenCalledWith("flow-execute", args);
    // …so that a real tool-server is the one that rejects it.
    const nested = (registry.invokeTool as any).mock.calls[0][1];
    await expect(resolveFlowSource(nested)).rejects.toThrow("Pass exactly one flow source");
    expect(parseFlow(await readFlowFile("compose-ambiguous")).steps).toEqual([]);
  });

  it("throws on invalid JSON in args", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "bad-json", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute({}, { command: "tap", args: "not valid json {{{" })
    ).rejects.toThrow();

    // Flow file should remain unchanged (no step recorded)
    const content = await readFlowFile("bad-json");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });

  it("propagates error when tool is not registered in the registry", async () => {
    const registry = createMockRegistry({}); // no tools registered
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "missing-tool", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(tool.execute({}, { command: "nonexistent-tool", args: "{}" })).rejects.toThrow(
      'Tool "nonexistent-tool" not found'
    );

    // Flow file should remain unchanged
    const content = await readFlowFile("missing-tool");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });
});

// ── flow-finish-recording ────────────────────────────────────────────

describe("flow-finish-recording", () => {
  it("returns summary with prerequisite and clears active flow", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute({}, { message: "Step 1" });

    const result = await flowFinishRecordingTool.execute({}, {});

    expect(result.message).toContain("finish-test");
    expect(result.executionPrerequisite).toBe(PREREQ);
    expect(result.steps).toBe(1);
    expect(result.summary).toEqual(["1. echo: Step 1"]);

    // Active flow should be cleared
    await expect(flowInsertEchoTool.execute({}, { message: "after finish" })).rejects.toThrow(
      "No active flow"
    );
  });

  it("throws when no active flow", async () => {
    await expect(flowFinishRecordingTool.execute({}, {})).rejects.toThrow("No active flow");
  });

  it("handles empty flow", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "empty", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowFinishRecordingTool.execute({}, {});

    expect(result.steps).toBe(0);
    expect(result.summary).toEqual([]);
  });

  it("calling finish twice throws on the second call", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "double-finish", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowFinishRecordingTool.execute({}, {});

    // Second call should fail — active flow was cleared
    await expect(flowFinishRecordingTool.execute({}, {})).rejects.toThrow("No active flow");
  });

  it("returns the file path so the agent knows where it was written", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "path-check", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowFinishRecordingTool.execute({}, {});

    expect(result.path).toContain(path.join(".argent", "flows"));
    expect(result.path).toContain("path-check.yaml");
  });

  it("summary includes both echo and tool steps", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const addStep = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "summary-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute({}, { message: "Before tap" });
    await addStep.execute({}, { command: "tap", args: '{"x":0.5}' });

    const result = await flowFinishRecordingTool.execute({}, {});
    expect(result.summary).toEqual(["1. echo: Before tap", '2. tool: tap {"x":0.5}']);
  });

  it("distinguishes contains, equals, and regex text comparisons in the summary", async () => {
    const name = "text-comparison-summary";
    await flowStartRecordingTool.execute(
      {},
      { name, project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", `${name}.yaml`),
      serializeFlow({
        executionPrerequisite: PREREQ,
        steps: [
          {
            kind: "await",
            condition: "text",
            selector: { identifier: "status" },
            expectedText: 'Ready "now"\nnext',
            textMatch: "contains",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "status" },
            expectedText: "Ready",
            textMatch: "equals",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "total" },
            expectedText: "^Total: \\$\\d+\\.\\d{2}$",
            textMatch: "matches",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "legacy-status" },
            expectedText: "Still running",
          },
        ],
      })
    );

    const result = await flowFinishRecordingTool.execute({}, {});

    expect(result.summary).toEqual([
      '1. await: text {"id":"status"} contains "Ready \\"now\\"\\nnext"',
      '2. assert: text {"id":"status"} == "Ready"',
      '3. assert: text {"id":"total"} matches /^Total: \\$\\d+\\.\\d{2}$/',
      '4. assert: text {"id":"legacy-status"} contains "Still running"',
    ]);
  });

  it("renders when text guards with the same comparator spelling as await/assert", async () => {
    const name = "when-text-guard-summary";
    await flowStartRecordingTool.execute(
      {},
      { name, project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const guarded: FlowStep[] = [{ kind: "echo", message: "guarded" }];
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", `${name}.yaml`),
      serializeFlow({
        executionPrerequisite: PREREQ,
        steps: [
          {
            kind: "when",
            condition: {
              kind: "ui",
              condition: "text",
              selector: { identifier: "status" },
              expectedText: 'Ready "now"\nnext',
              textMatch: "contains",
            },
            steps: guarded,
          },
          {
            kind: "when",
            condition: {
              kind: "ui",
              condition: "text",
              selector: { identifier: "status" },
              expectedText: "Ready",
              textMatch: "equals",
            },
            steps: guarded,
          },
          {
            kind: "when",
            condition: {
              kind: "ui",
              condition: "text",
              selector: { identifier: "total" },
              expectedText: "^Total: \\$\\d+\\.\\d{2}$",
              textMatch: "matches",
            },
            steps: [...guarded, { kind: "echo", message: "and again" }],
          },
        ],
      })
    );

    const result = await flowFinishRecordingTool.execute({}, {});

    expect(result.summary).toEqual([
      '1. when: text {"id":"status"} contains "Ready \\"now\\"\\nnext" (1 step)',
      '2. when: text {"id":"status"} == "Ready" (1 step)',
      '3. when: text {"id":"total"} matches /^Total: \\$\\d+\\.\\d{2}$/ (2 steps)',
    ]);
  });
});

// ── flow-execute ─────────────────────────────────────────────────────

describe("flow-execute", () => {
  // An iOS-shaped id so resolveDevice classifies it without listing devices,
  // and the runner never shells out to a real status bar (no `expect` steps).
  const DEVICE = "00000000-0000-0000-0000-0000000000ab";

  it("executes all steps in order", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
      screenshot: {
        result: { url: "http://img", path: "/tmp/img.png" },
        outputHint: "image",
      },
    });
    const addStep = createFlowAddStepTool(registry);
    const runFlow = createRunFlowTool(registry);

    // Build a flow
    await flowStartRecordingTool.execute(
      {},
      { name: "run-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute({}, { message: "Tap button" });
    await addStep.execute({}, { command: "tap", args: '{"x":0.5}' });
    await flowInsertEchoTool.execute({}, { message: "Take screenshot" });
    await addStep.execute({}, { command: "screenshot", args: "{}" });
    await flowFinishRecordingTool.execute({}, {});

    // Reset mock call counts
    vi.mocked(registry.invokeTool).mockClear();

    // Run the flow
    const result = await runFlow.execute(
      {},
      { name: "run-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );
    assertFlowRunResult(result);

    expect(result.flow).toBe("run-test");
    expect(result.executionPrerequisite).toBe(PREREQ);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(4);

    // Echoes
    expect(result.steps[0]).toMatchObject({ kind: "echo", status: "pass", message: "Tap button" });
    expect(result.steps[2]).toMatchObject({
      kind: "echo",
      status: "pass",
      message: "Take screenshot",
    });

    // Tool calls
    expect(result.steps[1]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "tap",
      result: { tapped: true },
      args: { x: 0.5 },
    });
    expect(result.steps[3]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "screenshot",
      result: { url: "http://img", path: "/tmp/img.png" },
      outputHint: "image",
      args: {},
    });

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
  });

  it("propagates the request's telemetry attribution to each tool step", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
      swipe: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tele-run.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [
          { kind: "tool", name: "tap", args: { x: 0.5 } },
          { kind: "echo", message: "between" },
          { kind: "tool", name: "swipe", args: { direction: "up" } },
        ],
      })
    );

    const release = vi.fn();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => release);
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await runFlow.execute({}, { name: "tele-run", project_root: tmpDir, device: DEVICE }, ctx);

    // Only the two tool steps dispatch; the echo step records nothing.
    expect(recordChildInvocation).toHaveBeenCalledTimes(2);
    const ids = recordChildInvocation.mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(2);
    // Each step's own args reach the recorder so per-step platform can be derived.
    expect(recordChildInvocation).toHaveBeenNthCalledWith(1, ids[0], { x: 0.5 });
    expect(recordChildInvocation).toHaveBeenNthCalledWith(2, ids[1], { direction: "up" });
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      1,
      "tap",
      { x: 0.5 },
      expect.objectContaining({ toolInvocationId: ids[0], recordChildInvocation })
    );
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      2,
      "swipe",
      { direction: "up" },
      expect.objectContaining({ toolInvocationId: ids[1], recordChildInvocation })
    );
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("stops on first error", async () => {
    const registry = createMockRegistry({
      tap: { result: null, throws: true },
    });
    const runFlow = createRunFlowTool(registry);

    // Manually write a flow file in YAML format
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "echo", message: "Should not reach" },
      ],
    });
    await fs.writeFile(path.join(dir, "error-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "error-test", project_root: tmpDir, device: DEVICE }
    );
    assertFlowRunResult(result);

    // tap errors (recorded), the trailing echo is skipped.
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      status: "error",
      tool: "tap",
      reason: expect.stringContaining("failed"),
    });
    expect(result.steps[1]).toMatchObject({ kind: "echo", status: "skip" });
    expect(result.ok).toBe(false);
  });

  it("throws when flow file does not exist", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    await expect(
      runFlow.execute({}, { name: "nonexistent", project_root: tmpDir })
    ).rejects.toThrow();
  });

  it("carries outputHint from tool definition", async () => {
    const registry = createMockRegistry({
      screenshot: {
        result: { url: "http://img" },
        outputHint: "image",
      },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Ready",
      steps: [{ kind: "tool", name: "screenshot", args: { udid: "A" } }],
    });
    await fs.writeFile(path.join(dir, "hint-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "hint-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );
    assertFlowRunResult(result);

    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      outputHint: "image",
    });
  });

  it("returns executionPrerequisite from the flow file", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App freshly reloaded",
      steps: [{ kind: "echo", message: "Start" }],
    });
    await fs.writeFile(path.join(dir, "prereq-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "prereq-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );

    expect(result.executionPrerequisite).toBe("App freshly reloaded");
  });

  it("returns a notice when prerequisite exists but is not acknowledged", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Device unlocked",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "gated.yaml"), content);

    const result = await runFlow.execute({}, { name: "gated", project_root: tmpDir });

    expect(result).toMatchObject({
      flow: "gated",
      notice: expect.stringContaining("prerequisite"),
      executionPrerequisite: "Device unlocked",
    });
    // Should NOT have a steps array — it's a notice, not a run result
    expect(result).not.toHaveProperty("steps");
  });

  it("runs normally when prerequisite exists and is acknowledged", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Device unlocked",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5 } }],
    });
    await fs.writeFile(path.join(dir, "ack-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "ack-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toHaveLength(1);
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
  });

  it("runs normally when prerequisite is empty and not acknowledged", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5 } }],
    });
    await fs.writeFile(path.join(dir, "no-gate.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "no-gate", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toHaveLength(1);
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
  });

  it("returns notice when prerequisiteAcknowledged is explicitly false", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App on settings page",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "explicit-false.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "explicit-false", project_root: tmpDir, prerequisiteAcknowledged: false }
    );

    expect(result).toMatchObject({
      flow: "explicit-false",
      notice: expect.stringContaining("prerequisite"),
      executionPrerequisite: "App on settings page",
    });
    expect(result).not.toHaveProperty("steps");
  });

  it("executes an empty flow (zero steps) successfully", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [],
    });
    await fs.writeFile(path.join(dir, "empty-flow.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "empty-flow", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toEqual([]);
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("executes a flow with only echo steps (no registry calls)", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "First" },
        { kind: "echo", message: "Second" },
        { kind: "echo", message: "Third" },
      ],
    });
    await fs.writeFile(path.join(dir, "echo-only.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "echo-only", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    const steps = (result as { steps: { kind: string; status: string; message?: string }[] }).steps;
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => ({ kind: s.kind, status: s.status, message: s.message }))).toEqual([
      { kind: "echo", status: "pass", message: "First" },
      { kind: "echo", status: "pass", message: "Second" },
      { kind: "echo", status: "pass", message: "Third" },
    ]);
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("error mid-flow reports preceding successful steps", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
      swipe: { result: null, throws: true },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "Start" },
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "tool", name: "swipe", args: { direction: "up" } },
        { kind: "echo", message: "Should not reach" },
      ],
    });
    await fs.writeFile(path.join(dir, "mid-error.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "mid-error", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    const steps = (result as { steps: { kind: string }[] }).steps;
    // echo, tap success, swipe error — then the trailing echo is skipped.
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ kind: "echo", status: "pass", message: "Start" });
    expect(steps[1]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "tap",
      result: { tapped: true },
    });
    expect(steps[2]).toMatchObject({
      kind: "tool",
      status: "error",
      tool: "swipe",
      reason: expect.stringContaining("failed"),
    });
    expect(steps[3]).toMatchObject({ kind: "echo", status: "skip" });
  });

  it("sleeps the step's delayMs before executing it", async () => {
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    const runFlow = createRunFlowTool(registry);
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    // Small delay: the step's configured delayMs is honored before the tool
    // runs. The magnitude is irrelevant to the regression guard — without the
    // delay this completes in ~0ms, so a 25ms wait still proves the behavior
    // while keeping the test off a real ~300ms sleep.
    const delayMs = 25;
    await fs.writeFile(
      path.join(dir, "pre-delay.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "tool", name: "tap", args: { x: 0.5 }, delayMs }],
      })
    );
    const start = Date.now();
    await runFlow.execute({}, { name: "pre-delay", project_root: tmpDir, device: DEVICE });
    expect(Date.now() - start).toBeGreaterThanOrEqual(delayMs - 5);
  });

  it("does not interfere with active recording state", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    // Write a flow to run
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.1 } }],
    });
    await fs.writeFile(path.join(dir, "side-effect.yaml"), content);

    // Start recording a different flow
    await flowStartRecordingTool.execute(
      {},
      { name: "recording", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    // Execute a saved flow — this should NOT affect the active recording
    await runFlow.execute({}, { name: "side-effect", project_root: tmpDir, device: DEVICE });

    // We should still be able to add steps to the recording
    const result = await flowInsertEchoTool.execute({}, { message: "still recording" });
    expect(result.message).toContain("recording");
  });
});

// ── flow-read-prerequisite ───────────────────────────────────────────

describe("flow-read-prerequisite", () => {
  it("reads the prerequisite from a saved flow", async () => {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App on home screen",
      steps: [{ kind: "echo", message: "Step 1" }],
    });
    await fs.writeFile(path.join(dir, "read-test.yaml"), content);

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "read-test", project_root: tmpDir }
    );

    expect(result.flow).toBe("read-test");
    expect(result.executionPrerequisite).toBe("App on home screen");
  });

  it("returns empty string when flow has no prerequisite", async () => {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "empty-prereq.yaml"), content);

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "empty-prereq", project_root: tmpDir }
    );

    expect(result.flow).toBe("empty-prereq");
    expect(result.executionPrerequisite).toBe("");
  });

  it("throws when the flow file does not exist", async () => {
    await expect(
      flowReadPrerequisiteTool.execute({}, { name: "nonexistent", project_root: tmpDir })
    ).rejects.toThrow();
  });

  it("advertises exactly one of name and flow_path as the flow source", () => {
    // The pre-flight must offer the same source contract as the run it
    // precedes — a schema still requiring `name` would leave flow_path flows
    // unaddressable and silently answer for a saved flow of the same stem.
    expect(flowReadPrerequisiteTool.inputSchema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
        flow_path: { type: "string" },
      },
      oneOf: [{ required: ["name"] }, { required: ["flow_path"] }],
    });
  });

  it("reads a boundary-verified flow_path's prerequisite, not the saved flow of the same stem", async () => {
    // Two flows share the stem "gate": the saved copy under .argent/flows and
    // an explicit file elsewhere. The flow_path call must answer with the
    // explicit file's contract and the basename-derived name — exactly what
    // flow-execute would run for the same params — never the saved copy's.
    const savedDir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(savedDir, { recursive: true });
    await fs.writeFile(
      path.join(savedDir, "gate.yaml"),
      serializeFlow({ executionPrerequisite: "SAVED-COPY: HOME screen", steps: [] })
    );
    const elsewhere = path.join(tmpDir, "elsewhere");
    await fs.mkdir(elsewhere, { recursive: true });
    const explicitPath = path.join(elsewhere, "gate.yaml");
    await fs.writeFile(
      explicitPath,
      serializeFlow({ executionPrerequisite: "SHARED-COPY: DETAIL screen", steps: [] })
    );

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { project_root: tmpDir, flow_path: explicitPath },
      {
        artifacts: new ArtifactStore(),
        fileInputs: {
          flow_path: {
            clientPath: explicitPath,
            presentOnHost: true,
            viaUpload: false,
            statVerified: true,
          },
        },
      }
    );

    expect(result.flow).toBe("gate");
    expect(result.executionPrerequisite).toBe("SHARED-COPY: DETAIL screen");
  });

  it("rejects a raw flow_path that skipped the boundary even when the file exists", async () => {
    // Same gate as flow-execute: without boundary evidence an explicit path
    // must not be read — otherwise this tool would hand out prerequisites for
    // arbitrary server files the run tool itself refuses to touch.
    const rawPath = path.join(tmpDir, "raw.yaml");
    await fs.writeFile(rawPath, serializeFlow({ executionPrerequisite: "raw", steps: [] }));

    await expect(
      flowReadPrerequisiteTool.execute({}, { project_root: tmpDir, flow_path: rawPath })
    ).rejects.toThrow("flow_path file-input boundary");
  });

  it("rejects a presence-only flow_path without the client-stat match", async () => {
    // presentOnHost alone is satisfiable by a hand-crafted stat-less wrapper;
    // the read must require the same statVerified evidence flow-execute does,
    // not a weaker copy of the gate.
    const presentPath = path.join(tmpDir, "present.yaml");
    await fs.writeFile(presentPath, serializeFlow({ executionPrerequisite: "p", steps: [] }));

    await expect(
      flowReadPrerequisiteTool.execute(
        {},
        { project_root: tmpDir, flow_path: presentPath },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            flow_path: { clientPath: presentPath, presentOnHost: true, viaUpload: false },
          },
        }
      )
    ).rejects.toThrow("flow_path file-input boundary");
  });

  it("rejects direct callers that provide both flow sources", async () => {
    // Direct execute() bypasses zod, so resolveFlowSource's own exactly-one
    // copy must refuse before either file is consulted.
    await expect(
      flowReadPrerequisiteTool.execute(
        {},
        { name: "gate", project_root: tmpDir, flow_path: path.join(tmpDir, "gate.yaml") }
      )
    ).rejects.toThrow("exactly one flow source");
  });
});
