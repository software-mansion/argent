import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "../../../registry/src/index";

// Mock flow-utils path functions to use a temp dir instead of git root
let tmpDir: string;

vi.mock("../../src/tools/flows/flow-utils", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/tools/flows/flow-utils")>();
  return {
    ...original,
    getFlowsDir: async () => path.join(tmpDir, ".argent"),
    getFlowPath: async (name: string) =>
      path.join(tmpDir, ".argent", `${name}.yaml`),
  };
});

// Import after mock so the tools get the mocked functions
import { flowStartTool } from "../../src/tools/flows/flow-start";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import { flowFinishTool } from "../../src/tools/flows/flow-finish";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import {
  clearActiveFlow,
  parseFlow,
  serializeFlow,
} from "../../src/tools/flows/flow-utils";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockRegistry(
  tools: Record<
    string,
    { result: unknown; outputHint?: string; throws?: boolean }
  > = {},
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
  return fs.readFile(path.join(tmpDir, ".argent", `${name}.yaml`), "utf8");
}

const PREREQ = "App on home screen";

// ── Setup / teardown ─────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-test-"));
  clearActiveFlow();
});

afterEach(async () => {
  clearActiveFlow();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── flow-start ───────────────────────────────────────────────────────

describe("flow-start", () => {
  it("creates the .argent dir and a .yaml file with header", async () => {
    const result = await flowStartTool.execute(
      {},
      { name: "test-flow", executionPrerequisite: PREREQ },
    );
    expect(result.message).toContain("test-flow");

    const content = await readFlowFile("test-flow");
    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe(PREREQ);
    expect(flow.steps).toEqual([]);
  });

  it("sets the active flow", async () => {
    await flowStartTool.execute(
      {},
      { name: "my-flow", executionPrerequisite: PREREQ },
    );
    const result = await flowInsertEchoTool.execute({}, { message: "test" });
    expect(result.message).toContain("my-flow");
  });

  it("overwrites an existing flow file", async () => {
    await flowStartTool.execute(
      {},
      { name: "overwrite", executionPrerequisite: PREREQ },
    );
    await flowInsertEchoTool.execute({}, { message: "line1" });

    // Start again with same name — should reset
    await flowStartTool.execute(
      {},
      { name: "overwrite", executionPrerequisite: "Different prereq" },
    );
    const content = await readFlowFile("overwrite");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
    expect(flow.executionPrerequisite).toBe("Different prereq");
  });
});

// ── flow-add-echo ────────────────────────────────────────────────────

describe("flow-add-echo", () => {
  it("appends an echo entry to the flow file", async () => {
    await flowStartTool.execute(
      {},
      { name: "echo-test", executionPrerequisite: PREREQ },
    );
    const result = await flowInsertEchoTool.execute(
      {},
      { message: "Hello world" },
    );

    expect(result.message).toContain("echo-test");
    const flow = parseFlow(result.flowFile);
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello world" }]);
  });

  it("appends multiple echo entries", async () => {
    await flowStartTool.execute(
      {},
      { name: "multi-echo", executionPrerequisite: PREREQ },
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
    await expect(
      flowInsertEchoTool.execute({}, { message: "oops" }),
    ).rejects.toThrow("No active flow");
  });
});

// ── flow-add-step ────────────────────────────────────────────────────

describe("flow-add-step", () => {
  it("executes the tool and records on success", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartTool.execute(
      {},
      { name: "step-test", executionPrerequisite: PREREQ },
    );
    const result = await tool.execute(
      {},
      { command: "tap", args: '{"x":0.5,"y":0.3}' },
    );

    expect(result.toolResult).toEqual({ tapped: true });
    const flow = parseFlow(result.flowFile);
    expect(flow.steps).toEqual([
      { kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } },
    ]);
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

    await flowStartTool.execute(
      {},
      { name: "fail-test", executionPrerequisite: PREREQ },
    );
    await expect(
      tool.execute({}, { command: "tap", args: '{"x":0.5}' }),
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

    await flowStartTool.execute(
      {},
      { name: "no-args", executionPrerequisite: PREREQ },
    );
    await tool.execute({}, { command: "screenshot" });

    const content = await readFlowFile("no-args");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([
      { kind: "tool", name: "screenshot", args: {} },
    ]);
    expect(registry.invokeTool).toHaveBeenCalledWith("screenshot", {});
  });

  it("throws when no active flow", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await expect(
      tool.execute({}, { command: "tap", args: '{"x":0.5}' }),
    ).rejects.toThrow("No active flow");
  });
});

// ── flow-finish ──────────────────────────────────────────────────────

describe("flow-finish", () => {
  it("returns summary with prerequisite and clears active flow", async () => {
    await flowStartTool.execute(
      {},
      { name: "finish-test", executionPrerequisite: PREREQ },
    );
    await flowInsertEchoTool.execute({}, { message: "Step 1" });

    const result = await flowFinishTool.execute({}, {});

    expect(result.message).toContain("finish-test");
    expect(result.executionPrerequisite).toBe(PREREQ);
    expect(result.steps).toBe(1);
    expect(result.summary).toEqual(["1. echo: Step 1"]);

    // Active flow should be cleared
    await expect(
      flowInsertEchoTool.execute({}, { message: "after finish" }),
    ).rejects.toThrow("No active flow");
  });

  it("throws when no active flow", async () => {
    await expect(flowFinishTool.execute({}, {})).rejects.toThrow(
      "No active flow",
    );
  });

  it("handles empty flow", async () => {
    await flowStartTool.execute(
      {},
      { name: "empty", executionPrerequisite: PREREQ },
    );
    const result = await flowFinishTool.execute({}, {});

    expect(result.steps).toBe(0);
    expect(result.summary).toEqual([]);
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
    await flowStartTool.execute(
      {},
      { name: "run-test", executionPrerequisite: PREREQ },
    );
    await flowInsertEchoTool.execute({}, { message: "Tap button" });
    await addStep.execute({}, { command: "tap", args: '{"x":0.5}' });
    await flowInsertEchoTool.execute({}, { message: "Take screenshot" });
    await addStep.execute({}, { command: "screenshot", args: "{}" });
    await flowFinishTool.execute({}, {});

    // Reset mock call counts
    vi.mocked(registry.invokeTool).mockClear();

    // Run the flow
    const result = await runFlow.execute(
      {},
      { name: "run-test", prerequisiteAcknowledged: true },
    );

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
    const dir = path.join(tmpDir, ".argent");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "echo", message: "Should not reach" },
      ],
    });
    await fs.writeFile(path.join(dir, "error-test.yaml"), content);

    const result = await runFlow.execute({}, { name: "error-test" });

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
      runFlow.execute({}, { name: "nonexistent" }),
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

    const dir = path.join(tmpDir, ".argent");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Ready",
      steps: [{ kind: "tool", name: "screenshot", args: { udid: "A" } }],
    });
    await fs.writeFile(path.join(dir, "hint-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "hint-test", prerequisiteAcknowledged: true },
    );

    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      outputHint: "image",
    });
  });

  it("returns executionPrerequisite from the flow file", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App freshly reloaded",
      steps: [{ kind: "echo", message: "Start" }],
    });
    await fs.writeFile(path.join(dir, "prereq-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "prereq-test", prerequisiteAcknowledged: true },
    );

    expect(result.executionPrerequisite).toBe("App freshly reloaded");
  });

  it("returns a notice when prerequisite exists but is not acknowledged", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Device unlocked",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "gated.yaml"), content);

    const result = await runFlow.execute({}, { name: "gated" });

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

    const dir = path.join(tmpDir, ".argent");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Device unlocked",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5 } }],
    });
    await fs.writeFile(path.join(dir, "ack-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "ack-test", prerequisiteAcknowledged: true },
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

    const dir = path.join(tmpDir, ".argent");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5 } }],
    });
    await fs.writeFile(path.join(dir, "no-gate.yaml"), content);

    const result = await runFlow.execute({}, { name: "no-gate" });

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toHaveLength(1);
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
  });
});

// ── flow-read-prerequisite ───────────────────────────────────────────

describe("flow-read-prerequisite", () => {
  it("reads the prerequisite from a saved flow", async () => {
    const dir = path.join(tmpDir, ".argent");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App on home screen",
      steps: [{ kind: "echo", message: "Step 1" }],
    });
    await fs.writeFile(path.join(dir, "read-test.yaml"), content);

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "read-test" },
    );

    expect(result.flow).toBe("read-test");
    expect(result.executionPrerequisite).toBe("App on home screen");
  });

  it("returns empty string when flow has no prerequisite", async () => {
    const dir = path.join(tmpDir, ".argent");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "empty-prereq.yaml"), content);

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "empty-prereq" },
    );

    expect(result.flow).toBe("empty-prereq");
    expect(result.executionPrerequisite).toBe("");
  });

  it("throws when the flow file does not exist", async () => {
    await expect(
      flowReadPrerequisiteTool.execute({}, { name: "nonexistent" }),
    ).rejects.toThrow();
  });
});
