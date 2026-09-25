import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({ tree: currentTree(), source: "native-devtools" })
  ),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import {
  __resetRecordingsForTesting,
  foldStepFromArgs,
  parseFlow,
  serializeFlow,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

const DEVICE = "B6C52FD4-5408-402B-9369-EF7C66B98E6F"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

/** Registry that records every tool invocation and answers `fold` like the tool. */
function mockRegistry(
  calls: Array<{ tool: string; args: Record<string, unknown> }>,
  fold: (args: Record<string, unknown>) => unknown = () => ({
    activeScreen: 3,
    screen: { id: 3, panel: "inner panel", width: 2007, height: 2853 },
    posture: "open",
    hingeAngle: 180,
  })
): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      calls.push({ tool: id, args });
      if (id === "fold") return fold(args);
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
  name: string,
  fold?: (args: Record<string, unknown>) => unknown
): Promise<FlowRunResult & { calls: Array<{ tool: string; args: Record<string, unknown> }> }> {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const tool = createRunFlowTool(mockRegistry(calls, fold));
  const result = asRun(await tool.execute({}, { name, project_root: tmpDir, device: DEVICE }));
  return Object.assign(result, { calls });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-fold-"));
  currentTree = () => screen([]);
  __resetRecordingsForTesting();
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("fold: parse/serialize", () => {
  it("round-trips the bare posture, bare angle and options-map spellings", () => {
    const steps: FlowStep[] = [
      { kind: "fold", posture: "open" },
      { kind: "fold", angle: 120 },
      { kind: "fold", posture: "closed", from: "open" },
      { kind: "fold", angle: 60, from: 0 },
    ];
    const reparsed = parseFlow(serializeFlow({ executionPrerequisite: "", steps })).steps;
    expect(reparsed).toEqual(steps);
  });

  it("sugars a posture or an angle with no `from` to the bare form", () => {
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "fold", posture: "open" },
        { kind: "fold", angle: 120 },
        { kind: "fold", angle: 60, from: 0 },
      ],
    });
    expect(yaml).toMatch(/- fold: open\n/);
    expect(yaml).toMatch(/- fold: 120\n/);
    expect(yaml).toMatch(/fold:\n\s+angle: 60\n\s+from: 0\n/);
  });

  it("parses every spelling", () => {
    const steps = parseFlow(
      "steps:\n" +
        "  - fold: open\n" +
        "  - fold: 120\n" +
        "  - fold: { posture: closed, from: open }\n" +
        "  - fold: { angle: 60, from: 0 }\n"
    ).steps;
    expect(steps).toEqual([
      { kind: "fold", posture: "open" },
      { kind: "fold", angle: 120 },
      { kind: "fold", posture: "closed", from: "open" },
      { kind: "fold", angle: 60, from: 0 },
    ]);
  });

  it("rejects an unknown posture, an angle out of range, both or neither, and unknown keys", () => {
    expect(() => parseFlow("steps:\n  - fold: sideways\n")).toThrow(/fold takes a posture/);
    expect(() => parseFlow("steps:\n  - fold: 181\n")).toThrow(/between 0 \(closed\) and 180/);
    expect(() => parseFlow("steps:\n  - fold: -1\n")).toThrow(/between 0 \(closed\) and 180/);
    expect(() => parseFlow("steps:\n  - fold: { posture: open, angle: 180 }\n")).toThrow(
      /exactly one of posture and angle/
    );
    expect(() => parseFlow("steps:\n  - fold: {}\n")).toThrow(/exactly one of posture and angle/);
    expect(() => parseFlow("steps:\n  - fold: { posture: open, to: closed }\n")).toThrow(/to/);
    expect(() => parseFlow("steps:\n  - fold: null\n")).toThrow(/fold takes a posture/);
    expect(() => parseFlow("steps:\n  - fold: { angle: 60, from: 200 }\n")).toThrow(
      /fold.from must be/
    );
  });
});

describe("fold: run", () => {
  it("dispatches to the fold tool on the run device and reports the panel", async () => {
    await writeFlow("open", {
      executionPrerequisite: "",
      steps: [{ kind: "fold", posture: "open", from: "closed" }],
    });
    const result = await run("open");
    expect(result.calls).toEqual([
      { tool: "fold", args: { udid: DEVICE, posture: "open", from: "closed" } },
    ]);
    expect(result.steps[0]).toMatchObject({
      kind: "fold",
      status: "pass",
      target: "open from closed",
      reason: "open: screen 3 (inner panel 2007x2853)",
    });
    expect(result.ok).toBe(true);
  });

  it("names the angle it was given for a fold to no preset, whichever panel that leaves live", async () => {
    await writeFlow("thirty", { executionPrerequisite: "", steps: [{ kind: "fold", angle: 30 }] });
    const result = await run("thirty", () => ({
      activeScreen: 1,
      screen: { id: 1, panel: "cover panel", width: 1398, height: 2034 },
      hingeAngle: 30,
    }));
    expect(result.steps[0]).toMatchObject({
      status: "pass",
      reason: "30°: screen 1 (cover panel 1398x2034)",
    });
  });

  it("fails the step with the tool's reason on a device that is not foldable", async () => {
    await writeFlow("flat", { executionPrerequisite: "", steps: [{ kind: "fold", angle: 120 }] });
    const result = await run("flat", () => {
      throw new Error("Fold failed: the hinge can only be moved on a foldable iOS simulator.");
    });
    expect(result.steps[0]).toMatchObject({
      kind: "fold",
      status: "fail",
      reason: expect.stringContaining("the hinge can only be moved on a foldable iOS simulator"),
    });
    expect(result.ok).toBe(false);
  });

  it("carries the tool's warning into the step report", async () => {
    await writeFlow("warn", {
      executionPrerequisite: "",
      steps: [{ kind: "fold", posture: "closed" }],
    });
    const result = await run("warn", () => ({
      activeScreen: 1,
      screen: { id: 1, panel: "cover panel" },
      posture: "closed",
      hingeAngle: 0,
      warning: "CoreDevice did not report which panel the device renders to after the fold",
    }));
    expect(result.steps[0]).toMatchObject({
      status: "pass",
      reason: "closed: screen 1 (cover panel)",
      warning: expect.stringContaining("CoreDevice did not report"),
    });
  });
});

describe("fold: recorder", () => {
  it("rewrites a recorded fold tool call into the fold: directive", async () => {
    await flowStartRecordingTool.execute!(
      {},
      { name: "rec", project_root: tmpDir, executionPrerequisite: "Probe open" }
    );
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const tool = createFlowAddStepTool(mockRegistry(calls));
    const added = await tool.execute(
      {},
      {
        name: "rec",
        project_root: tmpDir,
        command: "fold",
        args: JSON.stringify({ udid: DEVICE, posture: "open" }),
      }
    );
    expect(added.recorded).toBe("1. fold: open");
    // The tool RAN, with the device bound.
    expect(calls).toEqual([{ tool: "fold", args: { udid: DEVICE, posture: "open" } }]);
    const content = await fs.readFile(path.join(tmpDir, ".argent", "flows", "rec.yaml"), "utf8");
    expect(parseFlow(content).steps).toEqual([{ kind: "fold", posture: "open" }]);
  });

  it("keeps a raw tool step for args the directive does not take", () => {
    expect(foldStepFromArgs({ posture: "open" })).toEqual({ kind: "fold", posture: "open" });
    expect(foldStepFromArgs({ angle: 60, from: "closed" })).toEqual({
      kind: "fold",
      angle: 60,
      from: "closed",
    });
    expect(foldStepFromArgs({ posture: "open", extra: 1 })).toBeUndefined();
    expect(foldStepFromArgs({})).toBeUndefined();
  });
});
