import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { DescribeTreeData } from "../../src/tools/describe/contract";

// Spy on the trimmed AX describe path: if fetchFlowTree ever fell back to it,
// the same flow would pass or fail with devtools availability instead of with
// what's on screen (the trimmed tree lacks testID nodes and hoisted
// subtreeText). These tests pin the contract that it hard-fails instead.
const describeIos = vi.fn(async (): Promise<DescribeTreeData> => {
  throw new Error("describeIos must not be reached by a flow tree fetch");
});
vi.mock("../../src/tools/describe/platforms/ios", () => ({
  describeIos: (...args: unknown[]) => describeIos(...(args as [])),
}));

// Status-bar pinning shells out to `xcrun simctl` per run — irrelevant to what
// these tests pin, and a source of contention under the parallel test load.
vi.mock("../../src/utils/status-bar", () => ({
  pinStatusBar: vi.fn(async () => false),
  restoreStatusBar: vi.fn(async () => {}),
}));

import { fetchFlowTree } from "../../src/tools/flows/flow-tree";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const IOS_DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

function device(platform: string): DeviceInfo {
  return { platform, id: IOS_DEVICE, udid: IOS_DEVICE } as unknown as DeviceInfo;
}

// Registry whose service layer is down — the shape a run sees when native
// devtools never connected or dropped mid-run.
function deadRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
    resolveService: vi.fn(async () => {
      throw new Error("service unavailable");
    }),
  } as unknown as Registry;
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-nofallback-"));
  describeIos.mockClear();
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("fetchFlowTree without a full-hierarchy source", () => {
  it("throws on iOS instead of degrading to the AX tree", async () => {
    await expect(fetchFlowTree(deadRegistry(), device("ios"))).rejects.toThrow(
      /native devtools is unavailable/
    );
    expect(describeIos).not.toHaveBeenCalled();
  });

  it("throws on Android instead of degrading to the trimmed uiautomator tree", async () => {
    await expect(fetchFlowTree(deadRegistry(), device("android"))).rejects.toThrow(
      /android devtools helper is unavailable/
    );
  });

  it("fails an assert step with the tree-source reason, not a selector miss", async () => {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "check.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "assert", condition: "visible", selector: { text: "Continue" } }],
      }),
      "utf8"
    );

    const result = asRun(
      await createRunFlowTool(deadRegistry()).execute(
        {},
        { name: "check", project_root: tmpDir, device: IOS_DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["assert:fail"]);
    // The report names the outage — not a misleading "no element matched".
    expect(result.steps[0].reason).toMatch(/could not read the UI tree/);
    expect(result.steps[0].reason).toMatch(/native devtools is unavailable/);
    expect(describeIos).not.toHaveBeenCalled();
  });
});
