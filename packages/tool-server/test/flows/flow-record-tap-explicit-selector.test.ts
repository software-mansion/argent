import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Same mock as flow-record-tap.test.ts: capture must read the tree the RUNNER
// resolves against, so each test controls exactly what it sees.
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

async function record(params: Record<string, unknown>) {
  return createFlowAddStepTool(mockRegistry()).execute({}, {
    name: FLOW,
    project_root: tmpDir,
    ...params,
  } as never);
}

async function recordedSteps() {
  const content = await fs.readFile(path.join(tmpDir, ".argent", "flows", `${FLOW}.yaml`), "utf8");
  return parseFlow(content).steps;
}

// One row carrying BOTH a positional identifier and stable text. `deriveSelector`
// is identifier-first, so the recorder picks `row-3` - correct today, wrong the
// moment the list reorders. Which of the two is stable is a judgement the caller
// holds and the tree does not carry, and it is the reason to be able to say so.
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

  // The contrast that makes the parameter worth having: same tap, same tree.
  it("differs from what the recorder derives on its own", async () => {
    await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
    });
    expect(await recordedSteps()).toEqual([{ kind: "tap", selector: { identifier: "row-3" } }]);
  });

  // A supplied selector is checked against the replay tree, not trusted: the
  // caller read it off the agent-facing describe tree, which is a different one.
  it("rejects a supplied selector that matches nothing, keeping coordinates", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { identifier: "no-such-id" },
    })) as { message: string };

    expect(res.message).toMatch(/the selector you passed/);
    expect(res.message).toMatch(/matches no element on this screen/);
    expect((await recordedSteps())[0]).not.toHaveProperty("selector");
  });

  it("rejects a supplied selector that resolves away from the tapped point", async () => {
    setTree([
      ...POSITIONAL_ROW,
      n({ frame: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 }, label: "Elsewhere" }),
    ]);
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, ...ON_ROW }),
      selector: { text: "Elsewhere" },
    })) as { message: string };

    expect(res.message).toMatch(/the selector you passed/);
    expect(res.message).toMatch(/resolves to a different element/);
    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.2, y: 0.55 }]);
  });

  // Silently ignoring it would record a step matching on something the caller
  // never asked for - the failure mode this parameter exists to remove.
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

  // delayMs suppresses selector capture entirely, so a selector passed with one
  // would be dropped rather than applied.
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

  // The third refusal branch: `gesture-tap` by name, no delayMs, but args that
  // carry no point for a selector to be checked against.
  it("refuses a selector on a tap whose args carry no coordinates", async () => {
    const res = (await record({
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.2 }),
      selector: { text: "Settings" },
    })) as { message: string };

    expect(res.message).toMatch(/needs a `gesture-tap` whose args carry `udid`, `x` and `y`/);
    expect(await recordedSteps()).toHaveLength(0);
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
