import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Serve the flow tree directly: flows resolve selectors against the platform's
// full-hierarchy source and hard-fail rather than degrade to the AX tree, so
// these unit tests stub the tree fetch itself.
let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "native-devtools",
    })
  ),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

/** Registry that records every gesture tool invocation's args. */
function mockRegistry(calls: Array<{ tool: string; args: Record<string, unknown> }>): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      calls.push({ tool: id, args });
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

async function run(
  name: string
): Promise<FlowRunResult & { calls: Array<{ tool: string; args: Record<string, unknown> }> }> {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const tool = createRunFlowTool(mockRegistry(calls));
  const result = asRun(await tool.execute({}, { name, project_root: tmpDir, device: DEVICE }));
  return Object.assign(result, { calls });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-gestures-"));
  currentTree = () => screen([]);
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("tap times: parse/serialize", () => {
  it("round-trips the options form and the coordinate form", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        { kind: "tap" as const, selector: { text: "Photo", loose: true }, times: 2 },
        { kind: "tap" as const, selector: { identifier: "map" }, times: 3 },
        { kind: "tap" as const, x: 0.5, y: 0.5, times: 2 },
        { kind: "tap" as const, selector: { text: "Plain", loose: true } },
      ],
    };
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("serializes the canonical minimal spelling", () => {
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "tap", selector: { text: "Photo", loose: true }, times: 2 },
        { kind: "tap", selector: { text: "Plain", loose: true } },
      ],
    });
    // Options form only when an option is present; plain taps stay bare.
    expect(yaml).toContain("on: Photo");
    expect(yaml).toContain("times: 2");
    expect(yaml).toContain("- tap: Plain");
  });

  it("parses `on` with the usual selector sugar; a bare on-form canonicalizes away", () => {
    const steps = parseFlow(
      "steps:\n" +
        '  - tap: { on: "Photo", times: 2 }\n' + // bare inside on = loose
        "  - tap: { on: { text: Photo }, times: 2 }\n" + // map inside on = strict
        '  - tap: { on: "Photo" }\n' // no options — plain loose tap
    ).steps;
    expect(steps).toEqual([
      { kind: "tap", selector: { text: "Photo", loose: true }, times: 2 },
      { kind: "tap", selector: { text: "Photo" }, times: 2 },
      { kind: "tap", selector: { text: "Photo", loose: true } },
    ]);
  });

  it("normalizes times: 1 to absent (round-trip stays inverse)", () => {
    const steps = parseFlow('steps:\n  - tap: { on: "Photo", times: 1 }\n').steps;
    expect(steps).toEqual([{ kind: "tap", selector: { text: "Photo", loose: true } }]);
    expect(serializeFlow({ executionPrerequisite: "", steps })).toContain("- tap: Photo");
  });

  it("rejects selector fields alongside times with the nested-selector hint", () => {
    // zod would silently STRIP times from a selector map — this must be loud.
    expect(() => parseFlow('steps:\n  - tap: { text: "Test", times: 2 }\n')).toThrow(
      /options form takes a nested selector/i
    );
  });

  it("rejects malformed options forms", () => {
    expect(() => parseFlow("steps:\n  - tap: { times: 2 }\n")).toThrow(/needs a target/i);
    expect(() => parseFlow("steps:\n  - tap: { on: A, foo: 1 }\n")).toThrow(
      /accepts only \{ on, times \}/i
    );
    expect(() => parseFlow("steps:\n  - tap: { on: A, x: 0.5, y: 0.5 }\n")).toThrow(
      /selector or x\/y coordinates, not both/i
    );
  });

  it("validates the times value on both forms", () => {
    for (const bad of ["0", "11", "1.5", '"2"']) {
      expect(() => parseFlow(`steps:\n  - tap: { on: A, times: ${bad} }\n`)).toThrow(
        /times must be an integer between 1 and 10/i
      );
    }
    expect(() => parseFlow("steps:\n  - tap: { x: 0.5, y: 0.5, times: 0 }\n")).toThrow(
      /times must be an integer between 1 and 10/i
    );
  });
});

describe("tap times: execution", () => {
  it("resolves the selector once and dispatches one multi-tap gesture", async () => {
    currentTree = () =>
      screen([n({ label: "Photo", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })]);
    await writeFlow("double", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Photo", loose: true }, times: 2 }],
    });

    const result = await run("double");

    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      { tool: "gesture-tap", args: { udid: DEVICE, x: 0.5, y: 0.5, clickCount: 2 } },
    ]);
  });

  it("sends no clickCount for a plain tap", async () => {
    currentTree = () =>
      screen([n({ label: "Photo", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })]);
    await writeFlow("single", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Photo", loose: true } }],
    });

    const result = await run("single");

    expect(result.ok).toBe(true);
    expect(result.calls[0]!.args).not.toHaveProperty("clickCount");
  });

  it("dispatches clickCount on a coordinate multi-tap", async () => {
    await writeFlow("coord", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.3, y: 0.7, times: 3 }],
    });

    const result = await run("coord");

    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      { tool: "gesture-tap", args: { udid: DEVICE, x: 0.3, y: 0.7, clickCount: 3 } },
    ]);
  });
});
