import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";

// The flow tree on a remote (cloud) simulator. A remote sim is an iOS simulator
// reached over the sim-remote tunnel, and the native-devtools blueprint routes
// `ViewHierarchy.getFullHierarchy` to it over TCP - so a flow reads the same
// full view hierarchy there that it reads on a local simulator.
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
import { fetchFlowTree, supportsFlowTree } from "../../src/tools/flows/flow-tree";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";
import { resolveDevice } from "../../src/utils/device-info";

const IOS = "00000000-0000-0000-0000-0000000000ab";
const REMOTE = `remote:${IOS}`;
const APP = "com.acme.app";

const WINDOW_FRAME = { x: 0, y: 0, width: 390, height: 844 };
const ROW_FRAME = { x: 0, y: 100, width: 390, height: 40 };

/** One `ViewHierarchy.getFullHierarchy` payload, the shape the iOS adapter takes. */
const HIERARCHY = {
  windows: [
    {
      className: "UIWindow",
      frame: WINDOW_FRAME,
      windowFrame: WINDOW_FRAME,
      children: [
        {
          className: "RCTParagraphComponentView",
          label: "Log In",
          frame: ROW_FRAME,
          windowFrame: ROW_FRAME,
          children: [],
        },
      ],
    },
  ],
};

type Query = [string, string, Record<string, unknown>];

/** Records every hierarchy query, so a test can assert WHICH read was issued. */
function nativeDevtools(queries: Query[]) {
  return {
    isConnected: () => true,
    listConnectedBundleIds: () => [APP],
    getAppState: async () => ({
      bundleId: APP,
      applicationState: "active" as const,
      foregroundActiveSceneCount: 1,
      foregroundInactiveSceneCount: 0,
      backgroundSceneCount: 0,
      unattachedSceneCount: 0,
      isFrontmostCandidate: true,
    }),
    queryViewHierarchy: vi.fn(
      async (bundleId: string, method: string, params: Record<string, unknown>) => {
        queries.push([bundleId, method, params]);
        return HIERARCHY;
      }
    ),
  };
}

function registryServing(queries: Query[]): Registry {
  return {
    resolveService: vi.fn(async () => nativeDevtools(queries)),
  } as unknown as Registry;
}

/** The tree a flow reads on `device`, with the launched app pinned. */
async function readTree(device: DeviceInfo, queries: Query[]) {
  return fetchFlowTree(registryServing(queries), device, { bundleId: APP, pinned: true });
}

let queries: Query[];
let tmpDir: string;

beforeEach(async () => {
  queries = [];
  vi.clearAllMocks();
  __resetRecordingsForTesting();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-remote-tree-"));
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a flow reads the full view hierarchy on a remote simulator", () => {
  it("declares a tree source for the platform at all", () => {
    expect(resolveDevice(REMOTE).platform).toBe("ios-remote");
    expect(supportsFlowTree("ios-remote")).toBe(true);
  });

  it("asks native devtools for the full hierarchy, not the trimmed describe tree", async () => {
    const tree = await readTree(resolveDevice(REMOTE), queries);

    // `fetchTree` - the fallthrough that used to serve this platform - would
    // have thrown before issuing any query at all.
    expect(queries).toEqual([[APP, "ViewHierarchy.getFullHierarchy", expect.any(Object)]]);
    expect(tree.source).toBe("native-devtools");
    expect(JSON.stringify(tree.tree)).toContain("Log In");
  });

  it("asks for the same depth and fields a local simulator asks for", async () => {
    // The read itself must not diverge either: 40 is the depth a deep React
    // Native screen needs, and the fields carry the label and identifier a
    // selector resolves against.
    const localQueries: Query[] = [];
    await readTree(resolveDevice(IOS), localQueries);
    await readTree(resolveDevice(REMOTE), queries);

    expect(queries).toEqual(localQueries);
    expect(queries[0][2]).toMatchObject({ maxDepth: 40 });
    expect(queries[0][2].fields).toEqual(expect.arrayContaining(["label", "identifier"]));
  });

  it("returns the tree a local simulator returns from the same payload", async () => {
    // One control for the whole feature: same source, same adapter, same tree.
    // If these ever diverge, the remote arm has stopped being the iOS arm.
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
  /** Serves the hierarchy AND runs the recorded tool - what recording one step needs. */
  function recordingRegistry(): Registry {
    return {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "gesture-tap") return { tapped: true };
        if (id === "await-ui-element") return { success: true, elapsed: 120 };
        throw new Error(`Tool "${id}" not found`);
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => nativeDevtools(queries)),
    } as unknown as Registry;
  }

  /** The centre of the one labelled row the fixture hierarchy carries. */
  const ON_THE_ROW = {
    x: (ROW_FRAME.x + ROW_FRAME.width / 2) / WINDOW_FRAME.width,
    y: (ROW_FRAME.y + ROW_FRAME.height / 2) / WINDOW_FRAME.height,
  };

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
  });

  it("writes what a local simulator writes for the same tap", async () => {
    const remote = await recordTapOn(REMOTE);
    __resetRecordingsForTesting();
    await fs.rm(path.join(tmpDir, ".argent"), { recursive: true, force: true });
    const local = await recordTapOn(IOS);

    expect(remote.steps).toEqual(local.steps);
  });

  it("re-probes a recorded wait against the full hierarchy, with a determinate verdict", async () => {
    // The fixture has no "Continue", so the verdict is known-bad. Before this
    // platform had a source the read threw, and the same wait came back UNKNOWN.
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

    expect(queries.map(([, method]) => method)).toContain("ViewHierarchy.getFullHierarchy");
    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    expect(result.message).not.toContain("is UNKNOWN, not known-bad");
  });
});
