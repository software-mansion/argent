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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-long-press-"));
  currentTree = () => screen([]);
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("long-press: parse/serialize", () => {
  it("round-trips all three spellings", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        { kind: "long-press" as const, selector: { text: "Row 3", loose: true } },
        { kind: "long-press" as const, selector: { identifier: "row-3" } },
        { kind: "long-press" as const, selector: { text: "Row 3", loose: true }, duration: 1200 },
      ],
    };
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("parses the options form with the usual selector sugar", () => {
    const steps = parseFlow(
      "steps:\n" +
        '  - long-press: { on: "Row 3", duration: 1200 }\n' +
        "  - long-press: { on: { text: Row } }\n" // no options — canonicalizes away
    ).steps;
    expect(steps).toEqual([
      { kind: "long-press", selector: { text: "Row 3", loose: true }, duration: 1200 },
      { kind: "long-press", selector: { text: "Row" } },
    ]);
  });

  it("rejects malformed bodies", () => {
    expect(() => parseFlow('steps:\n  - long-press: { text: "Row", duration: 900 }\n')).toThrow(
      /options form takes a nested selector/i
    );
    expect(() => parseFlow("steps:\n  - long-press: { on: A, foo: 1 }\n")).toThrow(
      /accepts only \{ on, duration \}/i
    );
    expect(() => parseFlow("steps:\n  - long-press: { duration: 900 }\n")).toThrow(
      /needs a target/i
    );
    for (const bad of ["0", "-5", '"900"', ".inf"]) {
      expect(() => parseFlow(`steps:\n  - long-press: { on: A, duration: ${bad} }\n`)).toThrow(
        /duration needs a positive number of milliseconds/i
      );
    }
  });
});

describe("long-press: execution", () => {
  it("dispatches one Down/delayed-Up gesture-custom train on touch platforms", async () => {
    currentTree = () =>
      screen([n({ label: "Row 3", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } })]);
    await writeFlow("press", {
      executionPrerequisite: "",
      steps: [{ kind: "long-press", selector: { text: "Row 3", loose: true }, duration: 1200 }],
    });

    const result = await run("press");

    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      {
        tool: "gesture-custom",
        args: {
          udid: DEVICE,
          events: [
            { type: "Down", x: 0.5, y: 0.45, delayMs: 0 },
            { type: "Up", x: 0.5, y: 0.45, delayMs: 1200 },
          ],
        },
      },
    ]);
  });

  it("holds for the 800ms default when no duration is given", async () => {
    currentTree = () =>
      screen([n({ label: "Row 3", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } })]);
    await writeFlow("press-default", {
      executionPrerequisite: "",
      steps: [{ kind: "long-press", selector: { text: "Row 3", loose: true } }],
    });

    const result = await run("press-default");

    const events = result.calls[0]!.args.events as Array<{ type: string; delayMs: number }>;
    expect(events[1]).toMatchObject({ type: "Up", delayMs: 800 });
  });

  it("maps to a mouse press-hold-release (gesture-drag, from == to) on chromium", async () => {
    currentTree = () =>
      screen([n({ label: "Row 3", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } })]);
    await writeFlow("press-chromium", {
      executionPrerequisite: "",
      steps: [{ kind: "long-press", selector: { text: "Row 3", loose: true }, duration: 900 }],
    });

    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const tool = createRunFlowTool(mockRegistry(calls));
    const result = asRun(
      await tool.execute(
        {},
        { name: "press-chromium", project_root: tmpDir, device: "chromium-cdp-9222" }
      )
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        tool: "gesture-drag",
        args: {
          udid: "chromium-cdp-9222",
          fromX: 0.5,
          fromY: 0.45,
          toX: 0.5,
          toY: 0.45,
          durationMs: 900,
        },
      },
    ]);
  });

  it("fails with the scroll-to hint when the target never appears", async () => {
    currentTree = () => screen([]);
    await writeFlow("press-missing", {
      executionPrerequisite: "",
      steps: [{ kind: "long-press", selector: { text: "Row 3", loose: true } }],
    });

    const result = await run("press-missing");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "long-press", status: "fail" });
    expect(result.steps[0].reason).toMatch(/add a scroll-to step/i);
    expect(result.calls).toHaveLength(0);
  }, 15000);
});
