import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeTreeData } from "../../src/tools/describe/contract";

// The launch step's post-launch head start reads the flow tree to decide when
// the app has drawn, so these tests drive it through the tree source.
const fetchFlowTree = vi.fn();
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: (...args: unknown[]) => fetchFlowTree(...(args as [])),
}));

// Status-bar normalization shells out to `adb` for a real device id, which
// would put seconds of unrelated I/O inside the elapsed times asserted below.
vi.mock("../../src/utils/status-bar", () => ({
  pinStatusBar: async () => true,
  restoreStatusBar: async () => {},
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

const PROJECT_ROOT = path.join(os.tmpdir(), `flow-launch-settle-${process.pid}`);
const ANDROID_DEVICE = "emulator-5554";

const LAUNCH_FLOW = `steps:
  - launch: com.example.app
`;

/** A tree with real content — what a drawn app looks like to the runner. */
function drawnTree(): DescribeTreeData {
  return {
    tree: {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "Button",
          label: "Sign in",
          frame: { x: 0, y: 0, width: 1, height: 0.1 },
          children: [],
        },
        {
          role: "Text",
          label: "Welcome",
          frame: { x: 0, y: 0.2, width: 1, height: 0.1 },
          children: [],
        },
      ],
    },
    source: "android-devtools",
  } as unknown as DescribeTreeData;
}

/** A tree with nothing in it — the app has not drawn its content yet. */
function blankTree(): DescribeTreeData {
  return {
    tree: { role: "Screen", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] },
    source: "android-devtools",
  } as unknown as DescribeTreeData;
}

/**
 * What a freshly launched Android activity actually reports before it draws:
 * the window's own content frame, identifier and nothing else. Captured from a
 * cold start on a Pixel 9 emulator — it is the shape a "non-empty tree" check
 * would wrongly call ready.
 */
function undrawnShellTree(): DescribeTreeData {
  return {
    tree: {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "FrameLayout",
          identifier: "android:id/content",
          frame: { x: 0, y: 0, width: 1, height: 1 },
          children: [],
        },
      ],
    },
    source: "android-devtools",
  } as unknown as DescribeTreeData;
}

/** An app whose whole first screen is a single labelled view. */
function minimalDrawnTree(): DescribeTreeData {
  return {
    tree: {
      role: "Screen",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "Text",
          label: "Hello",
          frame: { x: 0, y: 0, width: 1, height: 0.1 },
          children: [],
        },
      ],
    },
    source: "android-devtools",
  } as unknown as DescribeTreeData;
}

function makeRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") {
        return {
          devices: [
            { platform: "android", id: ANDROID_DEVICE, udid: ANDROID_DEVICE, state: "device" },
          ],
        };
      }
      return { ok: true, restarted: true };
    }),
    getTool: vi.fn(() => undefined),
    resolveService: vi.fn(async () => ({ isReady: () => true })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: string): Promise<string> {
  const flowsDir = path.join(PROJECT_ROOT, ".argent", "flows");
  await fs.mkdir(flowsDir, { recursive: true });
  const file = path.join(flowsDir, `${name}.yaml`);
  await fs.writeFile(file, yaml, "utf8");
  return file;
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a FlowRunResult, got a notice: ${r.notice}`);
  return r;
}

afterEach(async () => {
  vi.restoreAllMocks();
  fetchFlowTree.mockReset();
  await fs.rm(PROJECT_ROOT, { recursive: true, force: true });
});

describe("post-launch settle", () => {
  it("continues as soon as the app has drawn instead of sleeping the whole budget", async () => {
    const flowFile = await writeFlow("launch", LAUNCH_FLOW);
    fetchFlowTree.mockResolvedValue(drawnTree());
    const registry = makeRegistry();

    const started = Date.now();
    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "launch", project_root: PROJECT_ROOT, flow_file: flowFile, device: ANDROID_DEVICE }
      )
    );
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(true);
    // The old behaviour slept a flat 1500ms here regardless of the app. One
    // read is the whole wait now — asserted as a poll count, which does not
    // move with host load the way an elapsed time does.
    expect(fetchFlowTree).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(1400);
  });

  it("keeps waiting while the app is still blank, then carries on", async () => {
    const flowFile = await writeFlow("launch", LAUNCH_FLOW);
    // Blank forever: the budget is spent and the launch still succeeds, because
    // a screen without accessible content is not a launch failure.
    fetchFlowTree.mockResolvedValue(blankTree());
    const registry = makeRegistry();

    const started = Date.now();
    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "launch", project_root: PROJECT_ROOT, flow_file: flowFile, device: ANDROID_DEVICE }
      )
    );
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(fetchFlowTree.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps waiting on the undrawn content-frame shell a launching activity reports", async () => {
    const flowFile = await writeFlow("launch", LAUNCH_FLOW);
    // Non-empty, but the only view is the window's own content frame: an
    // identifier with no label, no value, no children. The app has not drawn.
    fetchFlowTree.mockResolvedValue(undrawnShellTree());
    const registry = makeRegistry();

    const started = Date.now();
    await createRunFlowTool(registry).execute(
      {},
      { name: "launch", project_root: PROJECT_ROOT, flow_file: flowFile, device: ANDROID_DEVICE }
    );

    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
  });

  it("continues early for an app whose whole first screen is one labelled view", async () => {
    const flowFile = await writeFlow("launch", LAUNCH_FLOW);
    fetchFlowTree.mockResolvedValue(minimalDrawnTree());
    const registry = makeRegistry();

    const started = Date.now();
    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "launch", project_root: PROJECT_ROOT, flow_file: flowFile, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    // One view is enough: a minimal screen must not be held for the full budget
    // just for being small.
    expect(fetchFlowTree).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1400);
  });

  it("does not fail the launch when the tree source throws mid-settle", async () => {
    const flowFile = await writeFlow("launch", LAUNCH_FLOW);
    fetchFlowTree.mockRejectedValueOnce(new Error("helper busy")).mockResolvedValue(drawnTree());
    const registry = makeRegistry();

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "launch", project_root: PROJECT_ROOT, flow_file: flowFile, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0]?.status).toBe("pass");
  });
});
