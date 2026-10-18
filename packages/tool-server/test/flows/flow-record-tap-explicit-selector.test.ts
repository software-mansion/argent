import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

let currentTreeData: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentTreeData()),
}));

import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000AB";
const FLOW = "rec";
const PREREQ = "App on home screen";

let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function setTree(children: DescribeNode[]) {
  currentTreeData = () => ({
    tree: n({ role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children }),
    source: "native-devtools",
  });
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "gesture-tap") return { tapped: true };
      if (id === "screenshot") return { path: "/tmp/x.png" };
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

let registry: Registry;

async function record(params: Record<string, unknown>) {
  registry = mockRegistry();
  return createFlowAddStepTool(registry).execute({}, {
    name: FLOW,
    project_root: tmpDir,
    ...params,
  } as never);
}

async function recordedSteps() {
  const content = await fs.readFile(path.join(tmpDir, ".argent", "flows", `${FLOW}.yaml`), "utf8");
  return parseFlow(content).steps;
}

// `deriveSelector` is identifier-first, so it picks the positional `row-3` over
// the stable text.
const POSITIONAL_ROW = [
  n({
    frame: { x: 0.1, y: 0.5, width: 0.4, height: 0.1 },
    label: "Settings",
    identifier: "row-3",
  }),
];
const ON_ROW = { x: 0.2, y: 0.55 };

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-explicit-sel-"));
  __resetRecordingsForTesting();
  setTree(POSITIONAL_ROW);
  await flowStartRecordingTool.execute(
    {},
    { name: FLOW, project_root: tmpDir, executionPrerequisite: PREREQ }
  );
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow-add-step records a caller-supplied tap selector", () => {
  it("records the supplied text instead of the identifier the recorder prefers", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { text: "Settings" },
    })) as { message: string };

    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Settings" } }]);
    expect(res.message).not.toMatch(/kept coordinates/);
  });

  it("differs from what the recorder derives on its own", async () => {
    await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
    });
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { identifier: "row-3" } }]);
  });

  // Checked against the replay tree, which is not the describe tree the caller
  // read it from. A failed check must not tap: the tap may navigate away.
  it.each([
    [
      "matches nothing",
      { identifier: "no-such-id" },
      /`selector` id="no-such-id" matches no element on this screen/,
    ],
    [
      "resolves away from the tapped point",
      { text: "Elsewhere" },
      /`selector` text="Elsewhere" resolves to a different element on this screen/,
    ],
  ])("refuses a supplied selector that %s, running nothing", async (_, selector, reason) => {
    setTree([
      ...POSITIONAL_ROW,
      n({ frame: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 }, label: "Elsewhere" }),
    ]);
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector,
    })) as { message: string };

    expect(res.message).toMatch(reason);
    expect(res.message).toMatch(/Nothing was executed and no step was recorded/);
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  it("refuses a supplied selector when the replay tree cannot be read", async () => {
    currentTreeData = () => {
      throw new Error("helper down");
    };
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { text: "Settings" },
    })) as { message: string };

    expect(res.message).toMatch(/`selector` could not be checked \(helper down\)/);
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await recordedSteps()).toHaveLength(0);
  });

  it("refuses a selector on a command that is not a tap, recording nothing", async () => {
    const res = (await record({
      command: "screenshot",
      args: JSON.stringify({ udid: DEVICE }),
      selector: { identifier: "save-final" },
    })) as { message: string; toolResult: unknown };

    expect(res.message).toMatch(/applies to a recorded `gesture-tap`/);
    expect(res.message).toMatch(/Nothing was executed and no step was recorded/);
    expect(res.toolResult).toBeUndefined();
    expect(await recordedSteps()).toHaveLength(0);
  });

  it("refuses a selector on a tap carrying delayMs, naming delayMs", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { identifier: "save-final" },
      delayMs: 300,
    })) as { message: string };

    expect(res.message).toMatch(/delayMs/);
    expect(await recordedSteps()).toHaveLength(0);
  });

  // The element here has an id and text, so the warning must not claim otherwise.
  it("warns on a supplied role-only selector without blaming the element", async () => {
    setTree([
      n({
        role: "AXButton",
        frame: { x: 0.1, y: 0.5, width: 0.4, height: 0.1 },
        label: "Settings",
        identifier: "row-3",
      }),
    ]);
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { role: "AXButton" },
    })) as { message: string };

    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { role: "AXButton" } }]);
    expect(res.message).toContain("the selector you passed");
    expect(res.message).toContain("matches by role alone");
    expect(res.message).not.toContain("has no id or visible text");
  });

  it("still derives a selector when none is supplied", async () => {
    setTree([n({ frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 }, label: "Continue" })]);
    await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.2, y: 0.15 }),
    });
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { text: "Continue" } }]);
  });

  it("needs at least one of identifier, text or role", async () => {
    const schema = createFlowAddStepTool(mockRegistry()).zodSchema;
    if (!schema) throw new Error("flow-add-step declares no zodSchema");
    const base = { name: FLOW, project_root: tmpDir, command: "gesture-tap" };
    expect(schema.safeParse({ ...base, selector: {} }).success).toBe(false);
    expect(schema.safeParse({ ...base, selector: { role: "AXButton" } }).success).toBe(true);
  });
});
