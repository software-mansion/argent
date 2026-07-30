import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

const treeFetch = vi.hoisted(() => ({
  impl: undefined as
    | ((source: "app" | "screen") => Promise<DescribeTreeData>)
    | undefined,
}));

vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (...args: unknown[]) => {
    const source = (args[2] ?? "app") as "app" | "screen";
    if (!treeFetch.impl) throw new Error("tree fetch test implementation was not configured");
    return treeFetch.impl(source);
  }),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

function node(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return node({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function registry(calls: Array<{ tool: string; args: Record<string, unknown> }>): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      calls.push({ tool: id, args });
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

function asRun(result: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return result;
}

async function writeAndRun(yaml: string): Promise<{
  result: FlowRunResult;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  reads: Array<"app" | "screen">;
}> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "source.yaml"), yaml, "utf8");

  const reads: Array<"app" | "screen"> = [];
  const appTree = screen([]);
  const screenTree = screen([
    node({
      role: "AXButton",
      identifier: "shift",
      frame: { x: 0.02, y: 0.8, width: 0.1, height: 0.1 },
    }),
  ]);
  treeFetch.impl = async (source) => {
    reads.push(source);
    return {
      tree: source === "screen" ? screenTree : appTree,
      source: source === "screen" ? "ax-service" : "native-devtools",
    };
  };

  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const result = asRun(
    await createRunFlowTool(registry(calls)).execute(
      {},
      { name: "source", project_root: tmpDir, device: DEVICE }
    )
  );
  return { result, calls, reads };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-selector-source-"));
});

afterEach(async () => {
  treeFetch.impl = undefined;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow selector source", () => {
  it("semantically taps an element that exists only in the screen tree", async () => {
    const { result, calls, reads } = await writeAndRun(
      'executionPrerequisite: ""\nsteps:\n  - tap: { id: shift, source: screen }\n'
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0]?.target).toBe("id=shift source=screen");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("gesture-tap");
    expect(calls[0]?.args.udid).toBe(DEVICE);
    expect(calls[0]?.args.x).toBeCloseTo(0.07, 6);
    expect(calls[0]?.args.y).toBeCloseTo(0.85, 6);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set(["screen"]));
  });

  it("evaluates visible and hidden conditions against the explicit screen tree", async () => {
    const { result, reads } = await writeAndRun(
      [
        'executionPrerequisite: ""',
        "steps:",
        "  - await: { visible: { id: shift, source: screen } }",
        "  - assert: { hidden: { id: Return, source: screen } }",
      ].join("\n")
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => `${step.kind}:${step.status}`)).toEqual([
      "await:pass",
      "assert:pass",
    ]);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set(["screen"]));
  });

  it("keeps the app tree as the strict default instead of falling back to screen", async () => {
    const { result, calls, reads } = await writeAndRun(
      'executionPrerequisite: ""\nsteps:\n  - assert: { visible: { id: shift } }\n'
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.status).toBe("fail");
    expect(calls).toEqual([]);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set(["app"]));
  });
});
