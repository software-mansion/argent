import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";

// The flow tree on a remote (cloud) simulator. A remote sim is an iOS simulator
// reached over the sim-remote tunnel, and the ax-service blueprint serves it -
// so a flow reads the same accessibility tree there that it reads on a local
// simulator.
//
// Nothing here stubs `fetchFlowTree`: the point is which SOURCE it dispatches
// to. Without an `ios-remote` entry in the source table every selector,
// `await: { idle: true }` and `snapshot: { cropOn }` would fail, and the settle
// a coordinate gesture takes before it dispatches would be skipped.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { axServiceRef, type AXTreeResponse } from "../../src/blueprints/ax-service";
import { fetchFlowTree } from "../../src/tools/flows/flow-tree";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";
import { resolveDevice } from "../../src/utils/device-info";

const IOS = "00000000-0000-0000-0000-0000000000ab";
const REMOTE = `remote:${IOS}`;
const APP = "com.acme.app";

const ROW_FRAME = { x: 0, y: 0.1, width: 1, height: 0.05 };

/** One ax-service `tree` answer: the app root and one labelled row. */
const TREE: AXTreeResponse = {
  alertVisible: false,
  screenFrame: { width: 390, height: 844 },
  nodes: [
    { index: 0, label: "Acme", bundleId: APP },
    { index: 1, parentIndex: 0, label: "Log In", traits: ["staticText"], frame: ROW_FRAME },
  ],
  truncated: false,
  foregroundApp: APP,
  interfaceOrientation: "portrait",
  treeVersion: 3,
};

/** The service URNs resolved, so a test can assert WHICH source was read. */
type Resolved = [string, Record<string, unknown>];

function axService(resolved: Resolved[]) {
  return vi.fn(async (urn: string, options: Record<string, unknown>) => {
    resolved.push([urn, options]);
    return { degraded: false, tree: vi.fn(async () => TREE) };
  });
}

/** The tree a flow reads on `device`, with the launched app pinned. */
async function readTree(device: DeviceInfo, resolved: Resolved[]) {
  const registry = { resolveService: axService(resolved) } as unknown as Registry;
  return fetchFlowTree(registry, device, { bundleId: APP, pinned: true });
}

let resolved: Resolved[];
let tmpDir: string;

beforeEach(async () => {
  resolved = [];
  vi.clearAllMocks();
  __resetRecordingsForTesting();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-remote-tree-"));
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a flow reads the accessibility tree on a remote simulator", () => {
  it("resolves a remote udid to its own platform, which the source table keys on", () => {
    expect(resolveDevice(REMOTE).platform).toBe("ios-remote");
  });

  it("reads the ax-service tree of the remote device", async () => {
    const device = resolveDevice(REMOTE);
    const tree = await readTree(device, resolved);

    const ref = axServiceRef(device);
    expect(resolved).toEqual([[ref.urn, ref.options]]);
    expect(tree.source).toBe("ax-service");
    expect(JSON.stringify(tree.tree)).toContain("Log In");
  });

  it("returns the tree a local simulator returns from the same payload", async () => {
    // Same source, same adapter, same tree: if these diverge, the remote arm
    // has stopped being the iOS arm.
    const local = await readTree(resolveDevice(IOS), []);
    const remote = await readTree(resolveDevice(REMOTE), []);

    expect(remote).toEqual(local);
  });
});

// The recorder reads the same source the runner replays against, so a tap it
// captures on a remote sim writes a selector rather than bare coordinates.
describe("the recorder reads the runner's tree on a remote simulator", () => {
  function recordingRegistry(): Registry {
    return {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "gesture-tap") return { tapped: true };
        if (id === "await-ui-element") return { success: true, elapsed: 120 };
        throw new Error(`Tool "${id}" not found`);
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: axService(resolved),
    } as unknown as Registry;
  }

  async function recordTapOn(device: string) {
    await flowStartRecordingTool.execute(
      {},
      { name: "rec", project_root: tmpDir, executionPrerequisite: "on the login screen" }
    );
    const result = await createFlowAddStepTool(recordingRegistry()).execute(
      {},
      {
        name: "rec",
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({
          udid: device,
          x: ROW_FRAME.x + ROW_FRAME.width / 2,
          y: ROW_FRAME.y + ROW_FRAME.height / 2,
        }),
      }
    );
    const yaml = await fs.readFile(path.join(tmpDir, ".argent", "flows", "rec.yaml"), "utf8");
    return { result, steps: parseFlow(yaml).steps };
  }

  it("writes a selector, not the coordinates it tapped", async () => {
    const { result, steps } = await recordTapOn(REMOTE);

    expect(steps).toEqual([{ kind: "tap", selector: { text: "Log In" } }]);
    expect(result.message).not.toContain("kept coordinates");
    expect(resolved.map(([urn]) => urn)).toContain(axServiceRef(resolveDevice(REMOTE)).urn);
  });

  it("writes what a local simulator writes for the same tap", async () => {
    const remote = await recordTapOn(REMOTE);
    __resetRecordingsForTesting();
    await fs.rm(path.join(tmpDir, ".argent"), { recursive: true, force: true });
    const local = await recordTapOn(IOS);

    expect(remote.steps).toEqual(local.steps);
  });

  it("re-probes a recorded wait against the ax-service tree, with a determinate verdict", async () => {
    // The fixture has no "Continue", so the verdict is known-bad, not UNKNOWN.
    await flowStartRecordingTool.execute(
      {},
      { name: "wait", project_root: tmpDir, executionPrerequisite: "on the login screen" }
    );
    const result = await createFlowAddStepTool(recordingRegistry()).execute(
      {},
      {
        name: "wait",
        project_root: tmpDir,
        command: "await-ui-element",
        args: JSON.stringify({
          udid: REMOTE,
          condition: "visible",
          selector: { text: "Continue" },
        }),
      }
    );

    expect(resolved.map(([urn]) => urn)).toContain(axServiceRef(resolveDevice(REMOTE)).urn);
    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    expect(result.message).not.toContain("is UNKNOWN, not known-bad");
  });
});
