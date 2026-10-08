import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { AXTreeResponse } from "../../src/blueprints/ax-service";

// The flow tree on a remote (cloud) simulator. A remote sim is an iOS simulator
// reached over the sim-remote tunnel, and the ax-service blueprint serves it
// over TCP - so a flow reads the same accessibility daemon tree there that it
// reads on a local simulator.
//
// Nothing here stubs `fetchFlowTree`: the point is which SOURCE it dispatches
// to. Before this, `ios-remote` had no entry in the source table and every read
// fell through to `fetchTree`, which threw `ui-tree matching is not supported on
// platform "ios-remote"` - failing every selector, every `await: { idle: true }`
// and every `snapshot: { cropOn }`, and, worse, silently skipping the settle
// that a coordinate gesture takes before it dispatches.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fetchFlowTree } from "../../src/tools/flows/flow-tree";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";
import { resolveDevice } from "../../src/utils/device-info";

const IOS = "00000000-0000-0000-0000-0000000000ab";
const REMOTE = `remote:${IOS}`;

const ROW_FRAME = { x: 0, y: 0.1, width: 1, height: 0.05 };

/** One daemon `tree` payload: the app element over one labelled button. */
const TREE: AXTreeResponse = {
  alertVisible: false,
  screenFrame: { width: 390, height: 844 },
  nodes: [
    { index: 0, label: "Acme", frame: { x: 0, y: 0, width: 1, height: 1 } },
    {
      index: 1,
      parentIndex: 0,
      label: "Log In",
      traits: ["button"],
      accessible: true,
      frame: ROW_FRAME,
    },
  ],
  truncated: false,
};

/** Records the URN of every daemon read, so a test can assert WHICH service was asked. */
function registryServing(reads: string[]): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "gesture-tap") return { tapped: true };
      if (id === "await-ui-element") return { success: true, elapsed: 120 };
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async (urn: string) => ({
      tree: async () => {
        reads.push(urn);
        return TREE;
      },
    })),
  } as unknown as Registry;
}

/** The tree a flow reads on `device`. */
async function readTree(device: DeviceInfo, reads: string[]) {
  return fetchFlowTree(registryServing(reads), device);
}

let reads: string[];
let tmpDir: string;

beforeEach(async () => {
  reads = [];
  vi.clearAllMocks();
  __resetRecordingsForTesting();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-remote-tree-"));
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a flow reads the accessibility daemon's tree on a remote simulator", () => {
  it("resolves a remote udid to its own platform, which the source table keys on", () => {
    expect(resolveDevice(REMOTE).platform).toBe("ios-remote");
  });

  it("asks the remote device's ax-service for its tree, not the trimmed describe tree", async () => {
    const tree = await readTree(resolveDevice(REMOTE), reads);

    // Before this platform had a source of its own, every read threw before
    // issuing any read at all. The service asked is the remote device's own.
    expect(reads).toEqual([`AXService:${REMOTE}`]);
    expect(tree.source).toBe("ax-service");
    expect(JSON.stringify(tree.tree)).toContain("Log In");
  });

  it("returns the tree a local simulator returns from the same payload", async () => {
    // One control for the whole feature: same source, same projection, same
    // tree. If these ever diverge, the remote arm has stopped being the iOS arm.
    const local = await readTree(resolveDevice(IOS), []);
    const remote = await readTree(resolveDevice(REMOTE), []);

    expect(remote).toEqual(local);
  });
});

// The recorder reads the same source the runner replays against, so a tap it
// captures on a remote sim writes a selector rather than the bare coordinates
// it used to keep behind `selector capture failed (ui-tree matching is not
// supported on platform "ios-remote")`, and a wait it records is re-probed
// against that tree rather than left with an UNKNOWN verdict.
describe("the recorder reads the runner's tree on a remote simulator", () => {
  /** The centre of the one labelled button the fixture tree carries. */
  const ON_THE_ROW = {
    x: ROW_FRAME.x + ROW_FRAME.width / 2,
    y: ROW_FRAME.y + ROW_FRAME.height / 2,
  };

  async function recordTapOn(device: string) {
    await flowStartRecordingTool.execute(
      {},
      { name: "rec", project_root: tmpDir, executionPrerequisite: "on the login screen" }
    );
    const result = await createFlowAddStepTool(registryServing(reads)).execute(
      {},
      {
        name: "rec",
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: device, ...ON_THE_ROW }),
      }
    );
    const yaml = await fs.readFile(path.join(tmpDir, ".argent", "flows", "rec.yaml"), "utf8");
    return { result, steps: parseFlow(yaml).steps };
  }

  it("writes a selector, not the coordinates it tapped", async () => {
    const { result, steps } = await recordTapOn(REMOTE);

    expect(steps).toEqual([{ kind: "tap", selector: { text: "Log In" } }]);
    expect(result.message).not.toContain("kept coordinates");
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set([`AXService:${REMOTE}`]));
  });

  it("writes what a local simulator writes for the same tap", async () => {
    const remote = await recordTapOn(REMOTE);
    __resetRecordingsForTesting();
    await fs.rm(path.join(tmpDir, ".argent"), { recursive: true, force: true });
    const local = await recordTapOn(IOS);

    expect(remote.steps).toEqual(local.steps);
  });

  it("re-probes a recorded wait against the daemon tree, with a determinate verdict", async () => {
    // The fixture has no "Continue", so the verdict is known-bad. Before this
    // platform had a source the read threw, and the same wait came back UNKNOWN.
    await flowStartRecordingTool.execute(
      {},
      { name: "wait", project_root: tmpDir, executionPrerequisite: "on the login screen" }
    );
    const result = await createFlowAddStepTool(registryServing(reads)).execute(
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

    expect(reads).toContain(`AXService:${REMOTE}`);
    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    expect(result.message).not.toContain("is UNKNOWN, not known-bad");
  });
});
