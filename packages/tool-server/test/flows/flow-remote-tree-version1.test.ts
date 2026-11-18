import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { fetchFlowTree } from "../../src/tools/flows/flow-tree";
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
  return fetchFlowTree(
    registryServing(queries),
    device,
    {
      bundleId: APP,
      pinned: true,
      probeAnswered: false,
    },
    true
  );
}

let queries: Query[];

beforeEach(async () => {
  queries = [];
  vi.clearAllMocks();
});

describe("a flow reads the full view hierarchy on a remote simulator", () => {
  it("resolves a remote udid to its own platform, which the source table keys on", () => {
    expect(resolveDevice(REMOTE).platform).toBe("ios-remote");
  });

  it("asks native devtools for the full hierarchy, not the trimmed describe tree", async () => {
    const tree = await readTree(resolveDevice(REMOTE), queries);

    // Before this platform had a source of its own, every read threw before
    // issuing any query at all.
    expect(queries).toEqual([[APP, "ViewHierarchy.getFullHierarchy", expect.any(Object)]]);
    expect(tree.source).toBe("native-devtools");
    expect(JSON.stringify(tree.tree)).toContain("Log In");
  });

  it("asks for the same depth and fields a local simulator asks for", async () => {
    // The read itself must not diverge either: 100 is the depth cap a deeply
    // nested React Native screen needs, and the fields carry the label and
    // identifier a selector resolves against.
    const localQueries: Query[] = [];
    await readTree(resolveDevice(IOS), localQueries);
    await readTree(resolveDevice(REMOTE), queries);

    expect(queries).toEqual(localQueries);
    expect(queries[0][2]).toMatchObject({ maxDepth: 100 });
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
