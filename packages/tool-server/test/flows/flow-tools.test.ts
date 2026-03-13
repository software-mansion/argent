import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

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
import {
  setActiveFlow,
  clearActiveFlow,
  parseFlow,
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
  it("creates the .argent dir and an empty .yaml file", async () => {
    const result = await flowStartTool.execute({}, { name: "test-flow" });
    expect(result.message).toContain("test-flow");
    expect(result.flowFile).toBe("");

    const content = await readFlowFile("test-flow");
    expect(content).toBe("");
  });

  it("sets the active flow", async () => {
    await flowStartTool.execute({}, { name: "my-flow" });
    // getActiveFlow would throw if not set — but we test via flow-add-echo
    const result = await flowInsertEchoTool.execute(
      {},
      { message: "test" },
    );
    expect(result.message).toContain("my-flow");
  });

  it("overwrites an existing flow file", async () => {
    await flowStartTool.execute({}, { name: "overwrite" });
    await flowInsertEchoTool.execute({}, { message: "line1" });

    // Start again with same name — should reset
    await flowStartTool.execute({}, { name: "overwrite" });
    const content = await readFlowFile("overwrite");
    expect(content).toBe("");
  });
});

// ── flow-add-echo ────────────────────────────────────────────────────

describe("flow-add-echo", () => {
  it("appends an echo entry to the flow file", async () => {
    await flowStartTool.execute({}, { name: "echo-test" });
    const result = await flowInsertEchoTool.execute(
      {},
      { message: "Hello world" },
    );

    expect(result.message).toContain("echo-test");
    const parsed = parseFlow(result.flowFile);
    expect(parsed).toEqual([{ kind: "echo", message: "Hello world" }]);
  });

  it("appends multiple echo entries", async () => {
    await flowStartTool.execute({}, { name: "multi-echo" });
    await flowInsertEchoTool.execute({}, { message: "First" });
    const result = await flowInsertEchoTool.execute(
      {},
      { message: "Second" },
    );

    const parsed = parseFlow(result.flowFile);
    expect(parsed).toEqual([
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

    await flowStartTool.execute({}, { name: "step-test" });
    const result = await tool.execute(
      {},
      { command: "tap", args: '{"x":0.5,"y":0.3}' },
    );

    expect(result.toolResult).toEqual({ tapped: true });
    const parsed = parseFlow(result.flowFile);
    expect(parsed).toEqual([
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

    await flowStartTool.execute({}, { name: "fail-test" });
    await expect(
      tool.execute({}, { command: "tap", args: '{"x":0.5}' }),
    ).rejects.toThrow('Tool "tap" failed');

    const content = await readFlowFile("fail-test");
    expect(content).toBe("");
  });

  it("handles omitted args", async () => {
    const registry = createMockRegistry({
      screenshot: { result: { url: "http://..." } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartTool.execute({}, { name: "no-args" });
    await tool.execute({}, { command: "screenshot" });

    const content = await readFlowFile("no-args");
    const parsed = parseFlow(content);
    expect(parsed).toEqual([
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
  it("returns summary and clears active flow", async () => {
    await flowStartTool.execute({}, { name: "finish-test" });
    await flowInsertEchoTool.execute({}, { message: "Step 1" });

    const result = await flowFinishTool.execute({}, {});

    expect(result.message).toContain("finish-test");
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
    await flowStartTool.execute({}, { name: "empty" });
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
    await flowStartTool.execute({}, { name: "run-test" });
    await flowInsertEchoTool.execute({}, { message: "Tap button" });
    await addStep.execute({}, { command: "tap", args: '{"x":0.5}' });
    await flowInsertEchoTool.execute({}, { message: "Take screenshot" });
    await addStep.execute({}, { command: "screenshot", args: '{}' });
    await flowFinishTool.execute({}, {});

    // Reset mock call counts
    vi.mocked(registry.invokeTool).mockClear();

    // Run the flow
    const result = await runFlow.execute({}, { name: "run-test" });

    expect(result.flow).toBe("run-test");
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
    await fs.writeFile(
      path.join(dir, "error-test.yaml"),
      "- tool: tap\n  args:\n    x: 0.5\n- echo: Should not reach\n",
    );

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
    await fs.writeFile(
      path.join(dir, "hint-test.yaml"),
      "- tool: screenshot\n  args:\n    udid: A\n",
    );

    const result = await runFlow.execute({}, { name: "hint-test" });

    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      outputHint: "image",
    });
  });
});
