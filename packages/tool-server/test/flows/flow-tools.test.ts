import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import {
  createRunFlowTool,
  type FlowRunResult,
  type FlowPrerequisiteNotice,
} from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import {
  clearActiveFlow,
  setActiveProjectRoot,
  clearActiveProjectRoot,
  parseFlow,
  serializeFlow,
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
});

// ── flow-execute ─────────────────────────────────────────────────────

describe("flow-execute", () => {
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
      { name: "run-test", project_root: tmpDir, prerequisiteAcknowledged: true }
    );
    assertFlowRunResult(result);

    expect(result.flow).toBe("run-test");
    expect(result.executionPrerequisite).toBe(PREREQ);
    expect(result.steps).toHaveLength(4);

    // Echoes
    expect(result.steps[0]).toEqual({ kind: "echo", message: "Tap button" });
    expect(result.steps[2]).toEqual({
      kind: "echo",
      message: "Take screenshot",
    });

    // Tool calls
    expect(result.steps[1]).toEqual({
      kind: "tool",
      tool: "tap",
      result: { tapped: true },
      outputHint: undefined,
    });
    expect(result.steps[3]).toEqual({
      kind: "tool",
      tool: "screenshot",
      result: { url: "http://img", path: "/tmp/img.png" },
      outputHint: "image",
    });

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
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

    const result = await runFlow.execute({}, { name: "error-test", project_root: tmpDir });
    assertFlowRunResult(result);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      tool: "tap",
      error: expect.stringContaining("failed"),
    });
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
      { name: "hint-test", project_root: tmpDir, prerequisiteAcknowledged: true }
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
      { name: "prereq-test", project_root: tmpDir, prerequisiteAcknowledged: true }
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
      { name: "ack-test", project_root: tmpDir, prerequisiteAcknowledged: true }
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

    const result = await runFlow.execute({}, { name: "no-gate", project_root: tmpDir });

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

    const result = await runFlow.execute({}, { name: "empty-flow", project_root: tmpDir });

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

    const result = await runFlow.execute({}, { name: "echo-only", project_root: tmpDir });

    expect(result).toHaveProperty("steps");
    const steps = (result as { steps: unknown[] }).steps;
    expect(steps).toHaveLength(3);
    expect(steps).toEqual([
      { kind: "echo", message: "First" },
      { kind: "echo", message: "Second" },
      { kind: "echo", message: "Third" },
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

    const result = await runFlow.execute({}, { name: "mid-error", project_root: tmpDir });

    expect(result).toHaveProperty("steps");
    const steps = (result as { steps: { kind: string }[] }).steps;
    // Should include: echo, tap success, swipe error — then stop
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ kind: "echo", message: "Start" });
    expect(steps[1]).toMatchObject({
      kind: "tool",
      tool: "tap",
      result: { tapped: true },
    });
    expect(steps[2]).toMatchObject({
      kind: "tool",
      tool: "swipe",
      error: expect.stringContaining("failed"),
    });
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
    await runFlow.execute({}, { name: "side-effect", project_root: tmpDir });

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
});
