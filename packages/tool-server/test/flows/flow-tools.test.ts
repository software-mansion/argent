import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import { ArtifactStore, zodObjectToJsonSchema } from "@argent/registry";

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import {
  flowFinishRecordingTool,
  summarizeStep,
} from "../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import {
  createRunFlowTool,
  resolveFlowSource,
  type FlowRunResult,
  type FlowPrerequisiteNotice,
} from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import {
  __resetRecordingsForTesting,
  flowsDirFor,
  getRecordingSession,
  parseFlow,
  serializeFlow,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

/**
 * The flow as PERSISTED. The recorder deliberately no longer returns the whole
 * growing YAML per step (it was the single largest consumer of a session's
 * context), so the file on disk is the assertion surface.
 */
async function onDisk(name: string, root = tmpDir): Promise<string> {
  return fs.readFile(path.join(root, ".argent", "flows", `${name}.yaml`), "utf8");
}

// ── Helpers ──────────────────────────────────────────────────────────

function assertFlowRunResult(
  r: FlowRunResult | FlowPrerequisiteNotice
): asserts r is FlowRunResult {
  if (!("steps" in r)) {
    throw new Error(`expected FlowRunResult, got prerequisite notice: ${r.notice}`);
  }
}

let tmpDir: string;
// A second project root. Recordings are keyed by <project_root>/<name>, so it
// is what the cross-project cases address: same flow name, different project.
let otherDir: string;

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

async function readFlowFile(name: string, projectRoot: string = tmpDir): Promise<string> {
  return fs.readFile(path.join(projectRoot, ".argent", "flows", `${name}.yaml`), "utf8");
}

const PREREQ = "App on home screen";

// ── Setup / teardown ─────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-test-"));
  otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-test-other-"));
  __resetRecordingsForTesting();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(otherDir, { recursive: true, force: true });
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

  it("opens a recording addressable by name + project_root", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "my-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "my-flow", project_root: tmpDir, message: "test" }
    );
    expect(result.message).toContain("my-flow");
  });

  it("overwrites an existing flow file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, message: "line1" }
    );

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
  it("starting a differently-named flow leaves the earlier recording live", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "first-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "second-flow", project_root: tmpDir, executionPrerequisite: "Different" }
    );

    // A second recording abandons nothing, so there is no switch to report.
    expect(result.message).toContain("second-flow");
    expect(result.message).not.toContain("first-flow");
    expect(result.restarted).toBeUndefined();
    expect(result.discardedSteps).toBeUndefined();

    // Both recordings still take steps, each addressed by its own name.
    const secondEcho = await flowInsertEchoTool.execute(
      {},
      { name: "second-flow", project_root: tmpDir, message: "goes to second" }
    );
    expect(secondEcho.message).toContain("second-flow");
    const firstEcho = await flowInsertEchoTool.execute(
      {},
      { name: "first-flow", project_root: tmpDir, message: "goes to first" }
    );
    expect(firstEcho.message).toContain("first-flow");

    // …and each file ends up holding only its own steps.
    expect(parseFlow(await readFlowFile("first-flow")).steps).toEqual([
      { kind: "echo", message: "goes to first" },
    ]);
    expect(parseFlow(await readFlowFile("second-flow")).steps).toEqual([
      { kind: "echo", message: "goes to second" },
    ]);
  });

  it("keeps same-named recordings in different projects independent", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "shared-name", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "shared-name", project_root: otherDir, executionPrerequisite: PREREQ }
    );

    // Same name, other project — a different key, so nothing was restarted.
    expect(result.restarted).toBeUndefined();
    expect(result.discardedSteps).toBeUndefined();

    await flowInsertEchoTool.execute(
      {},
      { name: "shared-name", project_root: tmpDir, message: "in first project" }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "shared-name", project_root: otherDir, message: "in second project" }
    );

    expect(parseFlow(await readFlowFile("shared-name")).steps).toEqual([
      { kind: "echo", message: "in first project" },
    ]);
    expect(parseFlow(await readFlowFile("shared-name", otherDir)).steps).toEqual([
      { kind: "echo", message: "in second project" },
    ]);
  });

  it("restarting the same flow reports the discarded steps and resets the file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, message: "will be reset" }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, message: "also reset" }
    );

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, executionPrerequisite: "Updated prereq" }
    );

    expect(result.restarted).toBe(true);
    expect(result.discardedSteps).toBe(2);
    expect(result.message).toContain("same-flow");

    // The earlier take is gone from the file too, prerequisite included.
    const flow = parseFlow(await readFlowFile("same-flow"));
    expect(flow.steps).toEqual([]);
    expect(flow.executionPrerequisite).toBe("Updated prereq");

    // The restarted recording is the live one, and it starts from empty.
    const echo = await flowInsertEchoTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, message: "new take" }
    );
    expect(echo.stepCount).toBe(1);
    expect(parseFlow(await onDisk("same-flow")).steps).toEqual([
      { kind: "echo", message: "new take" },
    ]);
  });

  it("does not report a restart when the flow was not already recording", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "fresh-start", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    expect(result.restarted).toBeUndefined();
    expect(result.discardedSteps).toBeUndefined();
  });
});

// ── flow-add-echo ────────────────────────────────────────────────────

describe("flow-add-echo", () => {
  it("appends an echo entry to the flow file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "echo-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "echo-test", project_root: tmpDir, message: "Hello world" }
    );

    expect(result.message).toContain("echo-test");
    // The whole growing YAML is deliberately no longer echoed per step; the
    // file on disk is the assertion surface, and `flowFile` must be gone.
    expect(result).not.toHaveProperty("flowFile");
    const flow = parseFlow(await onDisk("echo-test"));
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello world" }]);
  });

  it("appends multiple echo entries", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const first = await flowInsertEchoTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, message: "First" }
    );
    const second = await flowInsertEchoTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, message: "Second" }
    );

    // stepCount reflects the running total, not a constant — it is the only
    // per-step size signal now that the growing YAML is no longer returned.
    expect(first.stepCount).toBe(1);
    expect(second.stepCount).toBe(2);

    const flow = parseFlow(await onDisk("multi-echo"));
    expect(flow.steps).toEqual([
      { kind: "echo", message: "First" },
      { kind: "echo", message: "Second" },
    ]);
  });

  it("throws when that flow has no recording in progress", async () => {
    await expect(
      flowInsertEchoTool.execute(
        {},
        { name: "not-recording", project_root: tmpDir, message: "oops" }
      )
    ).rejects.toThrow("No active recording");
  });

  it("throws when the recording is open under a different project root", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "wrong-root", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    // Right name, wrong project — a different key, so no recording is found.
    const err = await flowInsertEchoTool
      .execute({}, { name: "wrong-root", project_root: otherDir, message: "oops" })
      .catch((e: unknown) => e as Error);

    expect(err.message).toContain("No active recording");
    // The error names the key that was asked for, and counts — without naming —
    // the recordings live under other roots, so a wrong project_root is
    // recognizable without disclosing another project's flows.
    expect(err.message).toContain(`No active recording for flow "wrong-root" in ${otherDir}`);
    expect(err.message).toContain("Active recordings: none in this project (plus 1 in other");
    expect(err.message).not.toContain(tmpDir);
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
    const result = await tool.execute(
      {},
      {
        name: "step-test",
        project_root: tmpDir,
        command: "tap",
        args: '{"x":0.5,"y":0.3}',
      }
    );

    expect(result.toolResult).toEqual({ tapped: true });
    // The growing YAML is no longer returned per step; `flowFile` must be gone
    // from the add-step result too (the breaking change this PR pins).
    expect(result).not.toHaveProperty("flowFile");
    const flow = parseFlow(await onDisk("step-test"));
    expect(flow.steps).toEqual([{ kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } }]);
    expect(registry.invokeTool).toHaveBeenCalledWith("tap", {
      x: 0.5,
      y: 0.3,
    });
  });

  it("returns the appended step as the `recorded` line, carrying delayMs", async () => {
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "recorded-line", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await tool.execute(
      {},
      {
        name: "recorded-line",
        project_root: tmpDir,
        command: "tap",
        args: '{"x":0.5,"y":0.3}',
        delayMs: 500,
      }
    );

    // `recorded` is the author's only per-step view of the file now that the
    // whole YAML is no longer echoed, and it must spell the step exactly the
    // way flow-finish-recording's summary does — including the pre-step sleep.
    expect(result.stepCount).toBe(1);
    expect(result.recorded).toBe('1. tool: tap {"x":0.5,"y":0.3} (after 500ms)');
    expect(result.recorded).toBe(
      summarizeStep(parseFlow(await onDisk("recorded-line")).steps[0], 1)
    );
  });

  it("records a double-tap's clickCount as `times`, surfaced in the recorded line", async () => {
    // The clickCount→times rewrite (so a recorded double-tap replays as one,
    // not a single tap) only fires on a `gesture-tap` command, so the raw-tool
    // tests above never reach it. Selector capture can't resolve a device under
    // the mock, so the coordinates are kept — all this case needs to drive the
    // rewrite and confirm the ×N reaches the recorded line.
    const registry = createMockRegistry({ "gesture-tap": { result: { tapped: true } } });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "double-tap", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await tool.execute(
      {},
      {
        name: "double-tap",
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({
          udid: "00000000-0000-0000-0000-0000000000ab",
          x: 0.5,
          y: 0.3,
          clickCount: 2,
        }),
      }
    );

    const step = parseFlow(await onDisk("double-tap")).steps[0];
    expect(step).toEqual({ kind: "tap", x: 0.5, y: 0.3, times: 2 });
    expect(result.recorded).toBe("1. tap: (0.5, 0.3) ×2");
    expect(result.recorded).toBe(summarizeStep(step, 1));
  });

  it("finish-recording's summary carries the same delay/times spellings as `recorded`", async () => {
    // The per-step `recorded` lines are unit-covered above; this pins the OTHER
    // summarizeStep consumer — finish-recording's `summary` array — so the two
    // surfaces can't drift. It must render the pre-step delay and the tap count
    // exactly as the recorder echoed them per step.
    const registry = createMockRegistry({
      "screenshot": { result: { ok: true } },
      "gesture-tap": { result: { tapped: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "summary-labels", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const delayed = await tool.execute(
      {},
      {
        name: "summary-labels",
        project_root: tmpDir,
        command: "screenshot",
        args: "{}",
        delayMs: 250,
      }
    );
    const doubled = await tool.execute(
      {},
      {
        name: "summary-labels",
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({
          udid: "00000000-0000-0000-0000-0000000000ab",
          x: 0.5,
          y: 0.3,
          clickCount: 2,
        }),
      }
    );

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "summary-labels", project_root: tmpDir }
    );

    expect(finished.summary).toEqual([
      "1. tool: screenshot {} (after 250ms)",
      "2. tap: (0.5, 0.3) ×2",
    ]);
    // The finished summary and each step's `recorded` line are the same spelling.
    expect(finished.summary).toEqual([delayed.recorded, doubled.recorded]);
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
    await tool.execute(
      {},
      { name: "tele-step", project_root: tmpDir, command: "tap", args: '{"x":0.5}' },
      ctx
    );

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
    await expect(
      tool.execute(
        {},
        { name: "fail-test", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
      )
    ).rejects.toThrow('Tool "tap" failed');

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
    await tool.execute({}, { name: "no-args", project_root: tmpDir, command: "screenshot" });

    const content = await readFlowFile("no-args");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([{ kind: "tool", name: "screenshot", args: {} }]);
    expect(registry.invokeTool).toHaveBeenCalledWith("screenshot", {});
  });

  it("throws when that flow has no recording in progress", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await expect(
      tool.execute(
        {},
        { name: "not-recording", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
      )
    ).rejects.toThrow("No active recording");
    // The step must not run either — the recording is resolved first.
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("records a restart-app as a portable launch step (device id dropped)", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true, bundleId: "com.acme.app" } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "launch-rewrite", project_root: tmpDir });
    await tool.execute(
      {},
      {
        name: "launch-rewrite",
        project_root: tmpDir,
        command: "restart-app",
        args: '{"udid":"ABC","bundleId":"com.acme.app"}',
      }
    );

    // Ran live with the full args…
    expect(registry.invokeTool).toHaveBeenCalledWith("restart-app", {
      udid: "ABC",
      bundleId: "com.acme.app",
    });
    // …but recorded the launch directive, making this an e2e flow.
    expect(parseFlow(await onDisk("launch-rewrite")).steps).toEqual([
      { kind: "launch", app: "com.acme.app" },
    ]);
  });

  it("keeps a restart-app with extra args (e.g. activity) as a raw tool step", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "launch-activity", project_root: tmpDir });
    await tool.execute(
      {},
      {
        name: "launch-activity",
        project_root: tmpDir,
        command: "restart-app",
        args: '{"udid":"ABC","bundleId":"com.acme.app","activity":".Main"}',
      }
    );

    expect(parseFlow(await onDisk("launch-activity")).steps).toEqual([
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
      tool.execute(
        {},
        {
          name: "contradiction",
          project_root: tmpDir,
          command: "restart-app",
          args: '{"bundleId":"com.acme.app"}',
        }
      )
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
        name: "compose-test",
        project_root: tmpDir,
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
    expect(parseFlow(await onDisk("compose-test")).steps).toEqual([{ kind: "run", flow: "login.yaml" }]);
  });

  it("records a run: directive when the target is an e2e flow", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-e2e", project_root: tmpDir });
    await writeSiblingFlow("other-e2e", "steps:\n  - launch: com.acme.app\n  - echo: hi\n");

    await tool.execute(
      {},
      {
        name: "compose-e2e",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "other-e2e", project_root: tmpDir, device: "ABC" }),
      }
    );

    // e2e flows now compose via run: just like fragments — their launch runs inline.
    expect(parseFlow(await onDisk("compose-e2e")).steps).toEqual([
      { kind: "run", flow: "other-e2e.yaml" },
    ]);
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
        name: "compose-missing",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "elsewhere", project_root: tmpDir }),
      }
    );

    expect(result.message).toMatch(/could not resolve/i);
    expect(parseFlow(await onDisk("compose-missing")).steps).toEqual([
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

    await tool.execute(
      {},
      {
        name: "compose-pinned",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "elsewhere", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(parseFlow(await onDisk("compose-pinned")).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "elsewhere", project_root: tmpDir } },
    ]);
  });

  it("keeps the raw flow-execute step when another project_root resolves the name", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-twin", project_root: tmpDir });
    // Two projects, each holding a different flow named "twin". The nested call
    // named the OTHER project's root, so that is the copy that ran live — while
    // a `run: twin` step resolves beside the recording at replay. Recording one
    // would swap the flow under the same name, both runs green and nothing said.
    await writeSiblingFlow("twin", "steps:\n  - echo: mine\n");
    const otherRoot = path.join(tmpDir, "other-project");
    const otherTwin = path.join(otherRoot, ".argent", "flows", "twin.yaml");
    await fs.mkdir(path.dirname(otherTwin), { recursive: true });
    await fs.writeFile(otherTwin, "steps:\n  - echo: theirs\n", "utf8");

    const args = { name: "twin", project_root: otherRoot };
    const result = await tool.execute(
      {},
      {
        name: "compose-twin",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify(args),
      }
    );

    // The live invoke ran the other project's copy…
    expect(registry.invokeTool).toHaveBeenCalledWith("flow-execute", args);
    // …so the recorded step must be the raw call that reproduces it — naming
    // both files, since either one alone reads as the flow the author meant.
    // Both anchors are canonicalized before the comparison (the recording's
    // real file on one side, the executed path on the other), so the message
    // quotes the realpath'd spellings — on macOS tmpdir lives behind the
    // /var → /private/var symlink, which these paths carry as written.
    expect(result.message).toContain(await fs.realpath(otherTwin));
    expect(result.message).toContain(
      await fs.realpath(path.join(tmpDir, ".argent", "flows", "twin.yaml"))
    );
    expect(result.message).toMatch(/would replay a different flow/);
    expect(parseFlow(result.flowFile).steps).toEqual([
      { kind: "tool", name: "flow-execute", args },
    ]);
  });

  // The two casing cases below decide off the flows dir LISTING, which returns
  // stored bytes on every platform, so they hold identically on case-sensitive
  // (Linux CI) and case-insensitive (APFS, NTFS) filesystems — where before the
  // gate the recorder read the case-folded file and baked its phantom spelling
  // into the committed YAML. The mock registry stands in for a flow-execute
  // that accepted the name; the real one refuses this spelling itself (see
  // "saved-flow name spelling"), so these pin the recorder's own guarantee
  // about the YAML it writes rather than borrowing that tool's.
  it("keeps the raw flow-execute step for a name the flows dir would case-fold", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-name-casing", project_root: tmpDir });
    await writeSiblingFlow("frag", "steps:\n  - echo: hi\n");

    const args = { name: "Frag", project_root: tmpDir };
    const result = await tool.execute(
      {},
      {
        name: "compose-name-casing",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify(args),
      }
    );

    // `run: Frag` names a flow no case-sensitive checkout can find, so the raw
    // step is kept and the warning hands back the recordable spelling.
    expect(result.message).toContain('case-insensitively to "frag.yaml"');
    expect(result.message).toContain('re-run it as name "frag" to record it');
    expect(parseFlow(result.flowFile).steps).toEqual([
      { kind: "tool", name: "flow-execute", args },
    ]);
  });

  it("suggests a rename when the on-disk sibling's own extension case is unnameable", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-name-rename", project_root: tmpDir });
    // frag.YAML is reachable by no name at all — this route always builds
    // "<name>.yaml" — so the only honest recovery is the rename.
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "frag.YAML"),
      "steps:\n  - echo: hi\n",
      "utf8"
    );

    const args = { name: "frag", project_root: tmpDir };
    const result = await tool.execute(
      {},
      {
        name: "compose-name-rename",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify(args),
      }
    );

    expect(result.message).toContain('case-insensitively to "frag.YAML"');
    expect(result.message).toContain(
      'rename "frag.YAML" to "frag.yaml" to record it — flow files must be lowercase .yaml'
    );
    expect(result.message).not.toContain("re-run it as name");
    expect(parseFlow(result.flowFile).steps).toEqual([
      { kind: "tool", name: "flow-execute", args },
    ]);
  });

  it("composes a sibling saved under a mixed-case name under that exact name", async () => {
    // Byte-for-byte is the contract — not lowercasing: a sibling really saved
    // as MixedCase.yaml composes as `run: MixedCase`.
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-name-mixed", project_root: tmpDir });
    await writeSiblingFlow("MixedCase", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-name-mixed",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "MixedCase", project_root: tmpDir }),
      }
    );

    expect(parseFlow(result.flowFile).steps).toEqual([{ kind: "run", flow: "MixedCase.yaml" }]);
  });

  // A root the recorder cannot anchor is not a root it can check the name
  // against, so it declines to compose rather than compose on an unverified
  // identity. flow-execute's schema requires project_root and its resolver
  // demands an absolute one, so only a direct execute() caller reaches this —
  // and the relative case mocks the server's cwd to make the root name the
  // sibling, the one shape a cwd-anchored comparison would let through.
  it.each<[string, string | undefined, string]>([
    ["is missing", undefined, "(got none)"],
    ["is relative", ".", '(got ".")'],
  ])("keeps the raw flow-execute step when project_root %s", async (_shape, root, detail) => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-unanchored", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const args = root === undefined ? { name: "login" } : { name: "login", project_root: root };
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    try {
      if (root !== undefined) {
        expect(path.resolve(flowsDirFor(root), "login.yaml")).toBe(
          path.join(tmpDir, ".argent", "flows", "login.yaml")
        );
      }
      const result = await tool.execute(
        {},
        {
          name: "compose-unanchored",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify(args),
        }
      );

      expect(result.message).toContain(`project_root must be an absolute path ${detail}`);
      expect(parseFlow(result.flowFile).steps).toEqual([
        { kind: "tool", name: "flow-execute", args },
      ]);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  // The runner resolves a recorded `run:` against the CANONICAL containing
  // file's directory (scopeFlowDir in flow-run.ts), so when the recording is
  // itself a symlink the recorder must validate the sibling beside the real
  // file — AND confirm it is the same file the live sub-invoke executed from
  // the flows-dir spelling. The three tests below pin the accept, reject, and
  // divergence directions of those anchors. The base
  // is realpath'd so the only spelling/real divergence is the test's own
  // symlink: macOS's tmpdir lives behind the /var → /private/var symlink,
  // which would otherwise make every path here diverge from its canonical
  // form for reasons unrelated to what's being tested.
  async function symlinkedRecordingSetup(): Promise<{ base: string; vault: string }> {
    const base = await fs.realpath(tmpDir);
    const vault = path.join(base, "vault");
    const flowsDir = path.join(base, ".argent", "flows");
    await fs.mkdir(vault, { recursive: true });
    await fs.mkdir(flowsDir, { recursive: true });
    // The real file must exist before the recording starts: flow-start-recording
    // writes THROUGH .argent/flows/rec.yaml, which is a symlink into vault/.
    await fs.writeFile(path.join(vault, "rec.yaml"), "steps: []\n", "utf8");
    await fs.symlink(path.join(vault, "rec.yaml"), path.join(flowsDir, "rec.yaml"));
    return { base, vault };
  }

  it("validates the run: sibling beside a symlinked recording's real file", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    const { base, vault } = await symlinkedRecordingSetup();
    // The fragment's real file lives in vault/, beside the recording's real
    // file, with the flows dir carrying a symlink to it — the same vault
    // layout the recording itself models. The live sub-invoke resolves the
    // flows-dir spelling (getFlowPath under project_root) and the runner's
    // canonical anchor (scopeFlowDir in flow-run.ts) resolves the vault file;
    // both canonicalize to this one file, so the composition is sound. Vault
    // only would leave the flows-dir path — the one the live sub-invoke reads
    // — nonexistent, a layout the shipped path cannot produce.
    await fs.writeFile(path.join(vault, "frag.yaml"), "steps:\n  - echo: hi\n", "utf8");
    await fs.symlink(
      path.join(vault, "frag.yaml"),
      path.join(base, ".argent", "flows", "frag.yaml")
    );
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: base });

    const result = await tool.execute(
      {},
      {
        name: "rec",
        project_root: base,
        command: "flow-execute",
        args: JSON.stringify({ name: "frag", project_root: base }),
      }
    );

    // Anchored beside the symlink's spelling this would miss the fragment and
    // demote a perfectly replayable composition to a raw tool step.
    expect(result.message).not.toMatch(/could not resolve/i);
    expect(parseFlow(result.flowFile).steps).toEqual([{ kind: "run", flow: "frag.yaml" }]);
  });

  it("keeps the raw step when the sibling exists only beside the symlink's spelling", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    const { base } = await symlinkedRecordingSetup();
    // A decoy beside the symlink's SPELLING only — replay resolves `run:`
    // beside the real file, where nothing exists, so recording this as `run:`
    // would report success for a step that cannot replay.
    await fs.writeFile(
      path.join(base, ".argent", "flows", "frag.yaml"),
      "steps:\n  - echo: decoy\n",
      "utf8"
    );
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: base });

    const result = await tool.execute(
      {},
      {
        name: "rec",
        project_root: base,
        command: "flow-execute",
        args: JSON.stringify({ name: "frag", project_root: base }),
      }
    );

    expect(result.message).toMatch(/could not resolve/i);
    expect(parseFlow(result.flowFile).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "frag", project_root: base } },
    ]);
  });

  it("keeps the raw step when the flows-dir file and the real-file sibling diverge", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    const { base, vault } = await symlinkedRecordingSetup();
    // frag.yaml exists at BOTH spellings as two DIFFERENT real files. The live
    // sub-invoke runs the flows-dir one (getFlowPath under project_root); a
    // recorded `run:` would replay the vault one (scopeFlowDir in flow-run.ts
    // anchors at the canonical containing dir). Recording `run:` here would
    // report success for a step naming a flow that never ran — the raw step,
    // which replays via name + project_root, is the only honest record.
    await fs.writeFile(
      path.join(base, ".argent", "flows", "frag.yaml"),
      "steps:\n  - echo: decoy\n",
      "utf8"
    );
    await fs.writeFile(path.join(vault, "frag.yaml"), "steps:\n  - echo: real\n", "utf8");
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: base });

    const result = await tool.execute(
      {},
      {
        name: "rec",
        project_root: base,
        command: "flow-execute",
        args: JSON.stringify({ name: "frag", project_root: base }),
      }
    );

    expect(result.message).toMatch(/not the file the live flow-execute ran/i);
    expect(parseFlow(result.flowFile).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "frag", project_root: base } },
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
        name: "compose-path",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ flow_path: sibling, project_root: tmpDir }),
      }
    );

    expect(parseFlow(result.flowFile).steps).toEqual([{ kind: "run", flow: "login.yaml" }]);
    // The live sub-invoke gets no file-input boundary, so it must run the
    // sibling by name…
    const nested = (registry.invokeTool as any).mock.calls[0][1];
    expect(nested).toEqual({ name: "login", project_root: tmpDir });
    // …which a real tool-server resolves to that same file.
    expect(await resolveFlowSource(nested)).toEqual({
      filePath: sibling,
      flowName: "login",
      viaUpload: false,
    });
  });

  it("rejects a mis-cased sibling flow_path, naming the on-disk spelling", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-casing", project_root: tmpDir });
    await writeSiblingFlow("sibling", "steps:\n  - echo: hi\n");

    // Every lexical check accepts "Sibling.yaml", and a case-insensitive
    // filesystem would open sibling.yaml for it — so before the readdir gate
    // the recorder baked `run: Sibling` into committed YAML, a name no
    // case-sensitive checkout can resolve. The gate compares against the
    // directory LISTING, which returns stored bytes on every platform, so this
    // rejects deterministically on both filesystem flavors.
    const err = await tool
      .execute(
        {},
        {
          name: "compose-casing",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "Sibling.yaml"),
            project_root: tmpDir,
          }),
        }
      )
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    // The refusal must name the phantom spelling, the real directory entry,
    // and hand back the recordable on-disk basename.
    expect(err?.message).toContain("Cannot record a flow-execute of flow_path");
    expect(err?.message).toContain('case-insensitively to "sibling.yaml"');
    expect(err?.message).toContain('pass flow_path with the on-disk basename "sibling.yaml"');
    // Rejected before the live sub-invoke and the append: nothing ran, nothing recorded.
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-casing")).steps).toEqual([]);
  });

  it("suggests a rename when the on-disk sibling's own extension case is unrecordable", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-rename", project_root: tmpDir });
    // The sibling's REAL name trips the lowercase-extension arm, so the
    // message must ask for a rename, not point at a flow_path this same
    // ladder refuses.
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "frag.YAML"),
      "steps:\n  - echo: hi\n",
      "utf8"
    );

    const err = await tool
      .execute(
        {},
        {
          name: "compose-rename",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "frag.yaml"),
            project_root: tmpDir,
          }),
        }
      )
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    expect(err?.message).toContain('case-insensitively to "frag.YAML"');
    expect(err?.message).toContain(
      'rename "frag.YAML" to "frag.yaml" to record it — flow files must be lowercase .yaml'
    );
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-rename")).steps).toEqual([]);
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
          name: "compose-outside",
          project_root: tmpDir,
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
          name: "compose-dotdot",
          project_root: tmpDir,
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
            name: "compose-stemless",
            project_root: tmpDir,
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
          name: "compose-cased",
          project_root: tmpDir,
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
          name: "compose-mismatch",
          project_root: tmpDir,
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
              name: "compose-relative",
              project_root: tmpDir,
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
          name: "compose-rootless",
          project_root: tmpDir,
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
      tool.execute(
        {},
        {
          name: "compose-ambiguous",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify(args),
        }
      )
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
      tool.execute(
        {},
        { name: "bad-json", project_root: tmpDir, command: "tap", args: "not valid json {{{" }
      )
    ).rejects.toThrow();

    // Flow file should remain unchanged (no step recorded)
    const content = await readFlowFile("bad-json");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });

  it("keeps the devices list when recording a scoped teardown, so the YAML stays scoped", async () => {
    // `devices` is a scope, not a target: with it stripped, a correctly scoped
    // teardown recorded as a bare `- tool: stop-all-simulator-servers`, which
    // IS the machine-wide sweep — so hand-running the step from the YAML (the
    // create-flow skill's manual-execution strategy) reaped every device on the
    // machine. Replay rebinds the scope to the run device regardless, so
    // keeping it costs portability nothing.
    const registry = createMockRegistry({
      "stop-all-simulator-servers": { result: { stopped: 1 } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "teardown-test", project_root: tmpDir });
    await tool.execute(
      {},
      {
        name: "teardown-test",
        project_root: tmpDir,
        command: "stop-all-simulator-servers",
        args: JSON.stringify({ devices: ["00000000-HOST-DEVICE-ID"] }),
      }
    );

    // Ran live with the real devices to stop…
    expect(registry.invokeTool).toHaveBeenCalledWith("stop-all-simulator-servers", {
      devices: ["00000000-HOST-DEVICE-ID"],
    });
    // …and the recorded step still reads as the scoped teardown it was.
    expect(parseFlow(await onDisk("teardown-test")).steps).toEqual([
      {
        kind: "tool",
        name: "stop-all-simulator-servers",
        args: { devices: ["00000000-HOST-DEVICE-ID"] },
      },
    ]);
  });

  it("propagates error when tool is not registered in the registry", async () => {
    const registry = createMockRegistry({}); // no tools registered
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "missing-tool", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        { name: "missing-tool", project_root: tmpDir, command: "nonexistent-tool", args: "{}" }
      )
    ).rejects.toThrow('Tool "nonexistent-tool" not found');

    // Flow file should remain unchanged
    const content = await readFlowFile("missing-tool");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });
});

// ── flow-finish-recording ────────────────────────────────────────────

describe("flow-finish-recording", () => {
  it("returns summary with prerequisite and clears that recording", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir, message: "Step 1" }
    );

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir }
    );

    expect(result.message).toContain("finish-test");
    expect(result.executionPrerequisite).toBe(PREREQ);
    expect(result.steps).toBe(1);
    expect(result.summary).toEqual(["1. echo: Step 1"]);

    // The recording is gone — no more steps can be added to it.
    await expect(
      flowInsertEchoTool.execute(
        {},
        { name: "finish-test", project_root: tmpDir, message: "after finish" }
      )
    ).rejects.toThrow("No active recording");
  });

  it("leaves other recordings in progress untouched", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "finish-one", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowStartRecordingTool.execute(
      {},
      { name: "keep-going", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    await flowFinishRecordingTool.execute({}, { name: "finish-one", project_root: tmpDir });

    const result = await flowInsertEchoTool.execute(
      {},
      { name: "keep-going", project_root: tmpDir, message: "still open" }
    );
    expect(result.message).toContain("keep-going");
    expect(parseFlow(await readFlowFile("keep-going")).steps).toEqual([
      { kind: "echo", message: "still open" },
    ]);
  });

  it("throws when that flow has no recording in progress", async () => {
    await expect(
      flowFinishRecordingTool.execute({}, { name: "not-recording", project_root: tmpDir })
    ).rejects.toThrow("No active recording");
  });

  it("handles empty flow", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "empty", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "empty", project_root: tmpDir }
    );

    expect(result.steps).toBe(0);
    expect(result.summary).toEqual([]);
  });

  it("calling finish twice throws on the second call", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "double-finish", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowFinishRecordingTool.execute({}, { name: "double-finish", project_root: tmpDir });

    // Second call should fail — the recording was cleared
    await expect(
      flowFinishRecordingTool.execute({}, { name: "double-finish", project_root: tmpDir })
    ).rejects.toThrow("No active recording");
  });

  it("returns the file path so the agent knows where it was written", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "path-check", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "path-check", project_root: tmpDir }
    );

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
    await flowInsertEchoTool.execute(
      {},
      { name: "summary-test", project_root: tmpDir, message: "Before tap" }
    );
    await addStep.execute(
      {},
      { name: "summary-test", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
    );

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "summary-test", project_root: tmpDir }
    );
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

    const result = await flowFinishRecordingTool.execute({}, { name, project_root: tmpDir });

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

    const result = await flowFinishRecordingTool.execute({}, { name, project_root: tmpDir });

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
    await flowInsertEchoTool.execute(
      {},
      { name: "run-test", project_root: tmpDir, message: "Tap button" }
    );
    await addStep.execute(
      {},
      { name: "run-test", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "run-test", project_root: tmpDir, message: "Take screenshot" }
    );
    await addStep.execute(
      {},
      { name: "run-test", project_root: tmpDir, command: "screenshot", args: "{}" }
    );
    await flowFinishRecordingTool.execute({}, { name: "run-test", project_root: tmpDir });

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
    const addStep = createFlowAddStepTool(registry);

    // A flow to run in the recording's own project AND one in another project —
    // replay must be inert for the recording either way, and a replay under a
    // different project_root is exactly what a second agent's run looks like.
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.1 } }],
    });
    for (const root of [tmpDir, otherDir]) {
      const dir = path.join(root, ".argent", "flows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "side-effect.yaml"), content);
    }

    // Start recording a different flow
    await flowStartRecordingTool.execute(
      {},
      { name: "recording", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const before = await getRecordingSession(tmpDir, "recording");
    expect(before).toBeDefined();

    // Execute saved flows — neither should affect the active recording
    await runFlow.execute({}, { name: "side-effect", project_root: tmpDir, device: DEVICE });
    await runFlow.execute({}, { name: "side-effect", project_root: otherDir, device: DEVICE });

    // The recording still points at the flow it was opened for, in its own
    // project — a replay elsewhere must not rebind name/root/file.
    const after = await getRecordingSession(tmpDir, "recording");
    expect(after).toBe(before);
    expect(after).toMatchObject({
      name: "recording",
      projectRoot: tmpDir,
      filePath: path.join(tmpDir, ".argent", "flows", "recording.yaml"),
    });

    // We should still be able to add steps to the recording…
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "recording", project_root: tmpDir, message: "still recording" }
    );
    expect(result.message).toContain("recording");
    await addStep.execute(
      {},
      { name: "recording", project_root: tmpDir, command: "tap", args: '{"x":0.9}' }
    );

    // …and they land in the original flow's file, not the replayed project's.
    expect(parseFlow(await readFlowFile("recording")).steps).toEqual([
      { kind: "echo", message: "still recording" },
      { kind: "tool", name: "tap", args: { x: 0.9 } },
    ]);
    await expect(readFlowFile("recording", otherDir)).rejects.toThrow();
  });
});

// ── saved-flow name spelling ─────────────────────────────────────────

/**
 * The `name` branch has to hold the same on-disk-spelling invariant the
 * flow_path branch holds: a case-insensitive filesystem (APFS, NTFS) opens
 * snap.yaml for "Snap", and the name — not the file — is what keys the report
 * and __baselines__/, so the run would seed baselines in a directory no entry
 * carries and fail on the first case-sensitive checkout. Every case here reads
 * the directory LISTING, which returns stored bytes on every platform, so they
 * decide identically on case-sensitive (Linux CI) and case-insensitive
 * filesystems.
 */
describe("saved-flow name spelling", () => {
  const DEVICE = "00000000-0000-0000-0000-0000000000ab";

  async function writeFlowFile(basename: string): Promise<string> {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, basename);
    await fs.writeFile(
      filePath,
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "echo", message: "hi" }] }),
      "utf8"
    );
    return filePath;
  }

  it("rejects a name the filesystem would case-fold, handing back the on-disk name", async () => {
    await writeFlowFile("snap.yaml");

    const err = await resolveFlowSource({ name: "Snap", project_root: tmpDir }).then(
      () => null,
      (e: unknown) => e as Error
    );

    // The refusal must name the phantom spelling, the real directory entry,
    // and the stake — then hand back a name, not a flow_path: the caller
    // passed a name and may have no filesystem to spell a path against.
    expect(err?.message).toContain('Invalid flow name "Snap"');
    expect(err?.message).toContain('matched it case-insensitively to "snap.yaml"');
    expect(err?.message).toContain("__baselines__");
    expect(err?.message).toContain('Pass name "snap".');
    expect(err?.message).not.toContain("flow_path");
  });

  it("suggests a rename when the on-disk flow's extension case is unaddressable", async () => {
    // upper.YAML is reachable by no name at all — this branch always builds
    // "<name>.yaml" — and `argent flow list` omits it, so the only honest
    // recovery is the rename.
    await writeFlowFile("upper.YAML");

    const err = await resolveFlowSource({ name: "upper", project_root: tmpDir }).then(
      () => null,
      (e: unknown) => e as Error
    );

    expect(err?.message).toContain('matched it case-insensitively to "upper.YAML"');
    expect(err?.message).toContain(
      'Rename "upper.YAML" to "upper.yaml" to run it — flow files must be lowercase .yaml.'
    );
    expect(err?.message).not.toContain("Pass name");
  });

  it("accepts the exact on-disk spelling, mixed case included", async () => {
    // Byte-for-byte is the contract — not lowercasing: a flow really saved as
    // MixedCase.yaml runs under exactly that name.
    const filePath = await writeFlowFile("MixedCase.yaml");

    await expect(resolveFlowSource({ name: "MixedCase", project_root: tmpDir })).resolves.toEqual({
      filePath,
      flowName: "MixedCase",
      viaUpload: false,
    });
  });

  it("leaves a name that matches nothing as an ordinary missing flow", async () => {
    // No entry case-folds to "nonexistent.yaml", so this is not a spelling
    // problem at all: resolution succeeds and the read reports the absence,
    // exactly as before this gate existed.
    await writeFlowFile("other.yaml");
    const registry = createMockRegistry({});

    await expect(resolveFlowSource({ name: "nonexistent", project_root: tmpDir })).resolves.toEqual(
      {
        filePath: path.join(tmpDir, ".argent", "flows", "nonexistent.yaml"),
        flowName: "nonexistent",
        viaUpload: false,
      }
    );

    const err = await createRunFlowTool(registry)
      .execute({}, { name: "nonexistent", project_root: tmpDir, device: DEVICE })
      .then(
        () => null,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain("ENOENT");
    expect(err?.message).not.toContain("case-insensitively");
  });

  it("skips the check when the flows directory's listing is unavailable", async () => {
    // An execute-only flows directory refuses the listing while still opening
    // the file (here: no .argent/flows at all). An unreadable listing vouches
    // for nothing, so it must refuse nothing — the later read reports absence.
    await expect(resolveFlowSource({ name: "unlisted", project_root: tmpDir })).resolves.toEqual({
      filePath: path.join(tmpDir, ".argent", "flows", "unlisted.yaml"),
      flowName: "unlisted",
      viaUpload: false,
    });
  });

  it("trusts a boundary-materialized upload over the local flows directory", async () => {
    // A remote client's upload lands in a temp dir this server itself named
    // from `name`, so listing it could only agree with itself; the listing that
    // could disagree is the client's, on a host this process cannot read. The
    // co-located snap.yaml below is what THIS host happens to hold at the same
    // path — checking against it would reject a legitimate remote run.
    await writeFlowFile("snap.yaml");
    const uploaded = path.join(os.tmpdir(), "argent-file-input-abc", "Snap.yaml");

    await expect(
      resolveFlowSource(
        { name: "Snap", project_root: tmpDir, flow_file: uploaded },
        {
          clientPath: path.join(tmpDir, ".argent", "flows", "Snap.yaml"),
          presentOnHost: false,
          viaUpload: true,
        }
      )
    ).resolves.toEqual({ filePath: uploaded, flowName: "Snap", viaUpload: true });
  });

  it("flow-execute refuses the mis-cased name before running any step", async () => {
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    await writeFlowFile("checkout.yaml");

    await expect(
      createRunFlowTool(registry).execute(
        {},
        { name: "Checkout", project_root: tmpDir, device: DEVICE }
      )
    ).rejects.toThrow('Pass name "checkout".');
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("flow-read-prerequisite refuses the same name flow-execute would", async () => {
    // Both tools resolve through resolveFlowSource, so the pre-flight cannot
    // answer for a spelling the run itself refuses.
    await writeFlowFile("checkout.yaml");

    await expect(
      flowReadPrerequisiteTool.execute({}, { name: "Checkout", project_root: tmpDir })
    ).rejects.toThrow('Invalid flow name "Checkout"');
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

describe("the flow-add-step schema the CLI tests hand-copy", () => {
  // Three CLI test files encode this schema as a fixture — `run-help.test.ts`,
  // `flag-parser.test.ts` and `run-flow-add-step-payload.test.ts` — because
  // `@argent/cli` does not depend on the tool-server and so cannot derive it.
  // That makes drift silent in the direction that matters: relaxing the real
  // schema here (making `project_root` optional, renaming `args`) leaves all
  // three green while the CLI's `--args` handling and help output are decided
  // by a schema nothing resembles any more.
  //
  // So the guard lives on this side, where the schema is. If this fails,
  // update those three fixtures in the same change.
  const CLI_FIXTURE_PROPERTIES = ["name", "project_root", "command", "args", "delayMs"];
  const CLI_FIXTURE_REQUIRED = ["name", "project_root", "command"];

  it("still declares exactly the properties and required keys those fixtures encode", () => {
    const schema = zodObjectToJsonSchema(
      createFlowAddStepTool({} as unknown as Registry).zodSchema!
    ) as { properties: Record<string, unknown>; required?: string[] };

    expect(Object.keys(schema.properties).sort()).toEqual([...CLI_FIXTURE_PROPERTIES].sort());
    expect([...(schema.required ?? [])].sort()).toEqual([...CLI_FIXTURE_REQUIRED].sort());
    // `parseFlags` branches on this one specifically: a tool that declares its
    // own `args` must not also advertise the whole-payload `--args <json>`
    // escape hatch.
    expect(schema.properties["args"]).toMatchObject({ type: "string" });
  });

  it("still opens its description with the sentence those fixtures quote verbatim", () => {
    expect(createFlowAddStepTool({} as unknown as Registry).description).toContain(
      "Execute a tool call and record it as a step in the flow named by `name` + `project_root`"
    );
  });
});

// ── summarizeStep rendering ──────────────────────────────────────────
//
// summarizeStep is the single spelling shared by the recorder's per-step
// `recorded` line and flow-finish-recording's `summary`. `times` (tap),
// `duration` (long-press) and `delayMs` (tool) change what replays, so a
// summary that drops them misdescribes the file. long-press steps have no
// live recorder path, so this is the only coverage of that rendering.
describe("summarizeStep rendering", () => {
  it("renders a tap's times count", () => {
    // A recorded selector spells the id key `identifier`; selectorToYaml maps it
    // to the file's `id` spelling, so the rendered line reads {"id":…}.
    expect(summarizeStep({ kind: "tap", selector: { identifier: "b" }, times: 2 }, 1)).toBe(
      '1. tap: {"id":"b"} ×2'
    );
    expect(summarizeStep({ kind: "tap", x: 0.5, y: 0.3 }, 1)).toBe("1. tap: (0.5, 0.3)");
  });

  it("never renders ×1 — the file can't carry times: 1", () => {
    // parseTapTimes normalizes `times: 1` to absent, so a valid flow file never
    // spells a single tap with a count. summarizeStep renders the file's
    // spelling, so a stray in-memory `times: 1` must read as a plain tap, not ×1.
    expect(summarizeStep({ kind: "tap", x: 0.5, y: 0.3, times: 1 }, 1)).toBe("1. tap: (0.5, 0.3)");
    expect(summarizeStep({ kind: "tap", selector: { identifier: "b" }, times: 1 }, 1)).toBe(
      '1. tap: {"id":"b"}'
    );
  });

  it("renders a long-press hold duration", () => {
    expect(
      summarizeStep({ kind: "long-press", selector: { text: "Row" }, duration: 1200 }, 3)
    ).toBe('3. long-press: {"text":"Row"} for 1200ms');
    expect(summarizeStep({ kind: "long-press", x: 0.4, y: 0.5 }, 3)).toBe(
      "3. long-press: (0.4, 0.5)"
    );
  });

  it("renders a tool step's pre-step delay", () => {
    expect(
      summarizeStep({ kind: "tool", name: "screenshot", args: { scale: 0.2 }, delayMs: 500 }, 4)
    ).toBe('4. tool: screenshot {"scale":0.2} (after 500ms)');
    expect(summarizeStep({ kind: "tool", name: "screenshot", args: {} }, 4)).toBe(
      "4. tool: screenshot {}"
    );
  });
});
