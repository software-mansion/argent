import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeTreeData } from "../../src/tools/describe/contract";

// The status bar is normalized so a `snapshot` diff never turns on the clock.
// These tests pin WHEN that normalization is worth its shell calls.
const pinStatusBar = vi.fn(async () => true);
const restoreStatusBar = vi.fn(async () => {});
vi.mock("../../src/utils/status-bar", () => ({
  pinStatusBar: (...args: unknown[]) => pinStatusBar(...(args as [])),
  restoreStatusBar: (...args: unknown[]) => restoreStatusBar(...(args as [])),
}));

const fetchFlowTree = vi.fn(
  async (): Promise<DescribeTreeData> =>
    ({
      tree: {
        role: "Screen",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          {
            role: "Button",
            label: "Go",
            frame: { x: 0, y: 0, width: 1, height: 0.1 },
            children: [],
          },
          {
            role: "Text",
            label: "Hi",
            frame: { x: 0, y: 0.2, width: 1, height: 0.1 },
            children: [],
          },
        ],
      },
      source: "android-devtools",
    }) as unknown as DescribeTreeData
);
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: (...args: unknown[]) => fetchFlowTree(...(args as [])),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

const PROJECT_ROOT = path.join(os.tmpdir(), `flow-status-bar-${process.pid}`);
const DEVICE = "emulator-5554";

function makeRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") {
        return { devices: [{ platform: "android", id: DEVICE, udid: DEVICE, state: "device" }] };
      }
      return { ok: true, restarted: true, tapped: true };
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

async function run(name: string, yaml: string): Promise<FlowRunResult> {
  const flowFile = await writeFlow(name, yaml);
  const r = await createRunFlowTool(makeRegistry()).execute(
    {},
    { name, project_root: PROJECT_ROOT, flow_file: flowFile, device: DEVICE }
  );
  if (!("steps" in r)) throw new Error("expected a FlowRunResult");
  return r;
}

afterEach(async () => {
  pinStatusBar.mockClear();
  restoreStatusBar.mockClear();
  await fs.rm(PROJECT_ROOT, { recursive: true, force: true });
});

describe("status-bar normalization", () => {
  it("is skipped for a run that never captures", async () => {
    const result = await run("plain", `steps:\n  - launch: com.example.app\n`);
    expect(result.ok).toBe(true);
    expect(pinStatusBar).not.toHaveBeenCalled();
    // Nothing was pinned, so nothing is restored on teardown either.
    expect(restoreStatusBar).not.toHaveBeenCalled();
  });

  it("is applied for a flow with a snapshot step", async () => {
    await run("shot", `steps:\n  - launch: com.example.app\n  - snapshot: home\n`);
    expect(pinStatusBar).toHaveBeenCalledTimes(1);
    expect(restoreStatusBar).toHaveBeenCalledTimes(1);
  });

  it("is applied for a snapshot nested in a when: block", async () => {
    await run(
      "guarded",
      `steps:
  - launch: com.example.app
  - when: { visible: { text: Got it } }
    steps:
      - snapshot: promo
`
    );
    expect(pinStatusBar).toHaveBeenCalledTimes(1);
  });

  it("is applied for a composing flow, whose run: target may snapshot", async () => {
    await writeFlow("child", `steps:\n  - snapshot: inner\n`);
    await run("parent", `steps:\n  - launch: com.example.app\n  - run: child\n`);
    expect(pinStatusBar).toHaveBeenCalledTimes(1);
  });
});
