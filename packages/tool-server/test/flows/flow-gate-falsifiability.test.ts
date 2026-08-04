import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

/**
 * A gate that cannot fail is worse than no gate: the flow keeps reporting PASS
 * while proving nothing, and nothing downstream flags it. The recorder already
 * refuses to WRITE two such gates; these pin the rest of the story — what the
 * RUNNER does when a hand-written or hand-edited flow contains one anyway, and
 * that the three legitimate shapes are NOT condemned.
 *
 * Driven on a real device first: an `await`/`assert: { hidden: … }` on a
 * selector Bluesky never renders scored a silent `✓` and rolled into `PASS`.
 */

let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "native-devtools",
      screen: { width: 390, height: 844 },
    })
  ),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

const FULL: DescribeNode["frame"] = { x: 0, y: 0, width: 1, height: 1 };

function screen(labels: string[]): DescribeNode {
  return n({
    role: "AXWindow",
    frame: FULL,
    children: labels.map((label, i) =>
      n({ frame: { x: 0, y: i * 0.1, width: 1, height: 0.08 }, label })
    ),
  });
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
    resolveService: vi.fn(async () => ({ isConnected: () => true })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: string): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), yaml, "utf8");
}

async function run(name: string): Promise<FlowRunResult> {
  const tool = createRunFlowTool(mockRegistry());
  const result = await tool.execute({}, { name, project_root: tmpDir, device: DEVICE }, undefined);
  if (!("steps" in result)) throw new Error("expected a run result");
  return result;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-falsifiable-"));
  currentTree = () => screen(["Compose"]);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("a `hidden` gate the run never established", () => {
  it("still passes — the condition genuinely held — but says it proved nothing", async () => {
    await writeFlow(
      "vacuous",
      `executionPrerequisite: ""
steps:
  - assert: { hidden: "zzz-never-rendered" }
`
    );
    const r = await run("vacuous");
    // Not a failure: nothing about the app went wrong, and reporting a
    // regression here would be a lie.
    expect(r.ok).toBe(true);
    const step = r.steps.at(-1)!;
    expect(step.status).toBe("pass");
    expect(step.warning).toContain("cannot fail and proves nothing");
    expect(step.warning).toContain("zzz-never-rendered");
  });

  it("says nothing when an earlier step established the selector", async () => {
    // The correct authoring order — prove present, act, prove gone. The wait
    // itself still sees nothing match (the element is already gone by the time
    // it polls), so ONLY the flow-level evidence separates this from the case
    // above.
    // The `visible` check needs two consecutive agreeing reads, so hold the
    // sheet up for a few polls before removing it.
    let call = 0;
    currentTree = () => (call++ < 3 ? screen(["Compose", "Sheet"]) : screen(["Compose"]));
    await writeFlow(
      "trio",
      `executionPrerequisite: ""
steps:
  - await: { visible: "Sheet" }
  - await: { hidden: "Sheet", timeout: 300 }
`
    );
    const r = await run("trio");
    expect(r.ok).toBe(true);
    expect(r.steps.at(-1)!.status).toBe("pass");
    expect(r.steps.at(-1)!.warning).toBeUndefined();
  });

  it("says nothing when an entered `when:` guard established the selector", async () => {
    // A guard that HELD (visible Sheet) is proof Sheet was present, exactly as
    // an inline `visible` would be — so the later `hidden` inside the block is
    // falsifiable, not vacuous.
    let call = 0;
    currentTree = () => (call++ < 3 ? screen(["Compose", "Sheet"]) : screen(["Compose"]));
    await writeFlow(
      "guarded",
      `executionPrerequisite: ""
steps:
  - when: { visible: "Sheet" }
    steps:
      - await: { hidden: "Sheet", timeout: 300 }
`
    );
    const r = await run("guarded");
    expect(r.ok).toBe(true);
    expect(r.steps.at(-1)!.status).toBe("pass");
    expect(r.steps.at(-1)!.warning).toBeUndefined();
  });

  it("says nothing when the selector is scoped and the match sits outside the scope", async () => {
    // The scope is doing real work: "Saved" is on screen, just not in the
    // container, so this check would fail the moment a toast appeared there.
    currentTree = () =>
      n({
        role: "AXWindow",
        frame: FULL,
        children: [
          n({ identifier: "toast-area", frame: { x: 0, y: 0.8, width: 1, height: 0.2 } }),
          n({ label: "Saved", frame: { x: 0.3, y: 0.1, width: 0.4, height: 0.05 } }),
        ],
      });
    await writeFlow(
      "scoped",
      `executionPrerequisite: ""
steps:
  - assert: { hidden: { text: "Saved", within: { identifier: "toast-area" } } }
`
    );
    const r = await run("scoped");
    expect(r.ok).toBe(true);
    expect(r.steps.at(-1)!.status).toBe("pass");
    expect(r.steps.at(-1)!.warning).toBeUndefined();
  });
});

// `await-screen-idle` reports a screen that never settled as a soft
// `settled: false` instead of failing, so a recorded one is green on every
// replay whatever the screen does. The skills already say never to persist it;
// the recorder now enforces that rather than doing it silently. Found by
// recording it on a device and watching the unsettled step replay as ✓.
describe("await-screen-idle is not recordable", () => {
  it("refuses the step and names the two gates that can fail", async () => {
    const { flowStartRecordingTool } = await import("../../src/tools/flows/flow-start-recording");
    const { createFlowAddStepTool } = await import("../../src/tools/flows/flow-add-step");
    const { parseFlow, __resetRecordingsForTesting } =
      await import("../../src/tools/flows/flow-utils");
    __resetRecordingsForTesting();
    const registry = {
      invokeTool: vi.fn(async () => ({ settled: false, waitedMs: 202, polls: 2 })),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;

    await flowStartRecordingTool.execute(
      {},
      { name: "soft-idle", project_root: tmpDir, executionPrerequisite: "on a screen" }
    );
    const result = await createFlowAddStepTool(registry).execute(
      {},
      {
        name: "soft-idle",
        project_root: tmpDir,
        command: "await-screen-idle",
        args: '{"udid":"ABC","timeoutMs":200,"minStableMs":5000}',
      }
    );

    expect(result.message).toContain("step NOT recorded");
    expect(result.message).toContain("settled: false");
    expect(result.message).toContain("await: { idle: true }");
    const dir = path.join(tmpDir, ".argent", "flows");
    expect(parseFlow(await fs.readFile(path.join(dir, "soft-idle.yaml"), "utf8")).steps).toEqual(
      []
    );
    __resetRecordingsForTesting();
  });
});
