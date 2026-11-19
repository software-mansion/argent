import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { AXTreeResponse } from "../../src/blueprints/ax-service";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Runs of each file version through the REAL `e2e-execute`. On an iOS simulator
// a file without `version: 2` runs on the runner from before version 2
// (version-1/), which reads the view hierarchy; a version 2 file runs on the
// current runner, which reads the accessibility tree. A physical iPhone,
// Android and a Mac app run every version on the current runner.
//
// The simulator sources are real behind mocked services, so a test sees which
// service and which native devtools method a read used. The physical-device,
// Android and Mac app sources answer a fixed tree. Pass-through spies record
// which runner read the tree and from which source.

/** One entry per tree read, in order: the runner that read it. */
let runners: string[];
/** One entry per tree read, in order: the source it went to. */
let sources: string[];
/** Calls of `readIosSimulatorUiTree` outside a tree read: the current runner's launch gate. */
let axGateReads: number;

vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-tree")>();
  return {
    ...actual,
    fetchFlowTree: vi.fn((...args: Parameters<typeof actual.fetchFlowTree>) => {
      runners.push("current");
      return actual.fetchFlowTree(...args);
    }),
  };
});
vi.mock("../../src/tools/flows/version-1/flow-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/version-1/flow-tree")>();
  return {
    ...actual,
    fetchFlowTree: vi.fn((...args: Parameters<typeof actual.fetchFlowTree>) => {
      runners.push("version-1");
      return actual.fetchFlowTree(...args);
    }),
  };
});
vi.mock("../../src/tools/flows/version-1/flow-ios-tree", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/tools/flows/version-1/flow-ios-tree")>();
  return {
    ...actual,
    queryFullHierarchyTree: vi.fn((...args: Parameters<typeof actual.queryFullHierarchyTree>) => {
      sources.push("vh");
      return actual.queryFullHierarchyTree(...args);
    }),
  };
});
vi.mock("../../src/tools/flows/flow-ios-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-ios-tree")>();
  return {
    ...actual,
    queryIosSimulatorFlowTree: vi.fn(
      (...args: Parameters<typeof actual.queryIosSimulatorFlowTree>) => {
        sources.push("ax");
        return actual.queryIosSimulatorFlowTree(...args);
      }
    ),
    readIosSimulatorUiTree: vi.fn((...args: Parameters<typeof actual.readIosSimulatorUiTree>) => {
      axGateReads += 1;
      return actual.readIosSimulatorUiTree(...args);
    }),
    queryIosDeviceFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
      sources.push("device");
      return { tree: fixedTree(), source: "xcuitest-runner" };
    }),
  };
});
vi.mock("../../src/tools/flows/flow-android-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-android-tree")>()),
  queryAndroidFullHierarchy: vi.fn(async (): Promise<DescribeTreeData> => {
    sources.push("android");
    return { tree: fixedTree(), source: "android-devtools" };
  }),
}));

vi.mock("../../src/tools/flows/flow-macos-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-macos-tree")>()),
  queryMacosTree: vi.fn(async (): Promise<DescribeTreeData> => {
    sources.push("macos");
    return { tree: fixedTree(), source: "macos-devtools" };
  }),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import {
  __resetRecordingsForTesting,
  serializeFlow,
  type FlowFile,
  type FlowSelector,
} from "../../src/tools/flows/flow-utils";

const LOCAL = "00000000-0000-0000-0000-0000000000ab";
const REMOTE = `remote:${LOCAL}`;
const PHONE = "00008110-000978540290401E";
const ANDROID = "emulator-5554";
const MAC_APP = "macos-app-com.example.mac";
const APP = "com.example.app";

const ROW = { x: 0.1, y: 0.1, width: 0.8, height: 0.05 };
const FIELD = { x: 0.1, y: 0.2, width: 0.8, height: 0.05 };
const AX_ROW = { x: 0.1, y: 0.3, width: 0.8, height: 0.05 };

/** The physical-device, Android and Mac app tree: a ready row and an empty text field. */
function fixedTree(): DescribeNode {
  const n = (partial: Partial<DescribeNode>): DescribeNode => ({
    role: "AXStaticText",
    frame: ROW,
    children: [],
    ...partial,
  });
  return n({
    role: "AXWindow",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [
      n({ identifier: "ready", label: "Ready" }),
      n({ identifier: "email", role: "AXTextField", frame: FIELD }),
    ],
  });
}

/** What the accessibility tree shows: the ready row, an empty field and an AX-only row. */
function axTree(foregroundApp: string): AXTreeResponse {
  return {
    alertVisible: false,
    screenFrame: { width: 400, height: 800 },
    nodes: [
      { index: 0, label: foregroundApp, bundleId: foregroundApp },
      { index: 1, parentIndex: 0, identifier: "ready", label: "Ready", frame: ROW },
      { index: 2, parentIndex: 0, identifier: "email", traits: ["textEntry"], frame: FIELD },
      { index: 3, parentIndex: 0, label: "AX Only", traits: ["staticText"], frame: AX_ROW },
    ],
    truncated: false,
    foregroundApp,
    interfaceOrientation: "portrait",
    treeVersion: 3,
  };
}

/** What `getFullHierarchy` returns: the ready row, an empty field and a VH-only view. */
function viewHierarchy() {
  const at = (r: typeof ROW) => ({
    x: r.x * 400,
    y: r.y * 800,
    width: r.width * 400,
    height: r.height * 800,
  });
  const full = { x: 0, y: 0, width: 400, height: 800 };
  return {
    windows: [
      {
        className: "UIWindow",
        frame: full,
        windowFrame: full,
        children: [
          { className: "RCTView", identifier: "ready", label: "Ready", windowFrame: at(ROW) },
          { className: "UITextField", identifier: "email", windowFrame: at(FIELD) },
          { className: "RCTView", identifier: "vh-only", windowFrame: at(AX_ROW) },
        ],
      },
    ],
  };
}

interface Device {
  registry: Registry;
  /** Service URNs the run resolved, by namespace. */
  services: string[];
  /** Native devtools calls, as `<method>:<arg>`. */
  native: string[];
}

function device(
  opts: {
    nativeDevtoolsDown?: boolean;
    /** Native devtools connects this long after each launch. */
    connectAfterMs?: number;
  } = {}
): Device {
  const d: Device = { services: [], native: [], registry: undefined as unknown as Registry };
  let foreground = APP;
  let launchedAt = Date.now();
  const since = (ms = 0) => Date.now() - launchedAt >= ms;
  const nativeDevtools = {
    isConnected: (id: string) => {
      d.native.push(`isConnected:${id}`);
      return id === APP && since(opts.connectAfterMs);
    },
    listConnectedBundleIds: () => (since(opts.connectAfterMs) ? [APP] : []),
    getAppState: async (id: string) => ({
      bundleId: id,
      applicationState: "active",
      foregroundActiveSceneCount: 1,
      foregroundInactiveSceneCount: 0,
      backgroundSceneCount: 0,
      unattachedSceneCount: 0,
      isFrontmostCandidate: true,
    }),
    appConnectionState: async () => (since(opts.connectAfterMs) ? "connected" : "connecting"),
    reverifyEnv: async () => {},
    queryViewHierarchy: async (id: string, method: string) => {
      d.native.push(`${method}:${id}`);
      return viewHierarchy();
    },
  };
  d.registry = {
    resolveService: async (urn: string) => {
      const namespace = urn.split(":")[0]!;
      d.services.push(namespace);
      if (namespace === "NativeDevtools") {
        if (opts.nativeDevtoolsDown) throw new Error("socket closed");
        return nativeDevtools;
      }
      if (namespace === "AXService")
        return { degraded: false, tree: async () => axTree(foreground) };
      if (namespace === "AndroidDevtools") return { isReady: () => true };
      return {};
    },
    invokeTool: async (id: string, args: Record<string, unknown>, options?: object) => {
      if (id === "list-devices") return { devices: [] };
      // A nested run on the same device, as the real registry runs it.
      if (id === "e2e-execute") {
        return createRunFlowTool(d.registry).execute({}, args as never, options as never);
      }
      if ((id === "restart-app" || id === "launch-app") && typeof args.bundleId === "string") {
        foreground = args.bundleId;
        launchedAt = Date.now();
      }
      return { ok: true };
    },
    getTool: (id: string) => ({
      inputSchema: {
        properties:
          id === "e2e-execute" ? { name: {}, project_root: {}, device: {} } : { udid: {} },
      },
    }),
  } as unknown as Registry;
  return d;
}

type Step = FlowFile["steps"][number];

let root: string;

async function writeFlow(name: string, version: number | undefined, steps: Step[]) {
  const dir = path.join(root, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  const flow: FlowFile = { ...(version ? { version } : {}), executionPrerequisite: "", steps };
  await fs.writeFile(path.join(dir, `${name}.yaml`), fileText(flow), "utf8");
}

/** The YAML of `flow`; without the `version` line when `flow` has none, as an older Argent wrote it. */
function fileText(flow: FlowFile): string {
  const yaml = serializeFlow(flow);
  return flow.version === undefined ? yaml.replace(/^version: \d+\n/, "") : yaml;
}

async function run(d: Device, deviceId: string, name = "flow"): Promise<FlowRunResult> {
  const r = await createRunFlowTool(d.registry).execute(
    {},
    { name, project_root: root, device: deviceId },
    { signal: new AbortController().signal } as never
  );
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

const statuses = (r: FlowRunResult): string[] => r.steps.map((s) => `${s.kind}:${s.status}`);

const assertVisible = (selector: FlowSelector): Step => ({
  kind: "assert",
  condition: "visible",
  selector,
});
const VH_ONLY = assertVisible({ identifier: "vh-only" });
const AX_ONLY = assertVisible({ text: "AX Only" });
const READY = assertVisible({ identifier: "ready" });

beforeEach(async () => {
  runners = [];
  sources = [];
  axGateReads = 0;
  // Removed by its own test's teardown: the concurrent tests below overwrite
  // `root`, so an afterEach would remove only the last one.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-file-version-run-"));
  root = dir;
  return () => fs.rm(dir, { recursive: true, force: true });
});

describe("the runner each version runs on", () => {
  it.each([
    ["a version-less", undefined, LOCAL],
    ["a version 1", 1, LOCAL],
    ["a version-less", undefined, REMOTE],
  ])(
    "%s file on simulator %s runs on version 1, on the view hierarchy",
    async (_n, version, id) => {
      await writeFlow("flow", version, [VH_ONLY]);
      const d = device();

      const result = await run(d, id);

      expect(statuses(result)).toEqual(["assert:pass"]);
      expect(runners).toEqual(["version-1"]);
      expect(sources).toEqual(["vh"]);
      expect(d.native).toContain(`ViewHierarchy.getFullHierarchy:${APP}`);
      expect(d.services).not.toContain("AXService");
    }
  );

  it.each([LOCAL, REMOTE])(
    "a version 2 file on simulator %s runs on the current runner, on the accessibility tree",
    async (id) => {
      await writeFlow("flow", 2, [AX_ONLY]);
      const d = device();

      const result = await run(d, id);

      expect(statuses(result)).toEqual(["assert:pass"]);
      expect(runners).toEqual(["current"]);
      expect(sources).toEqual(["ax"]);
      expect(d.services).not.toContain("NativeDevtools");
    }
  );

  it.each([
    [PHONE, "device"],
    [ANDROID, "android"],
    [MAC_APP, "macos"],
  ])("%s runs every version on the current runner", async (deviceId, source) => {
    for (const version of [undefined, 1, 2]) {
      runners = [];
      sources = [];
      await writeFlow("flow", version, [READY]);
      const result = await run(device(), deviceId);
      expect(statuses(result)).toEqual(["assert:pass"]);
      expect(runners).toEqual(["current"]);
      expect(sources).toEqual([source]);
    }
  });
});

describe("the launch gate", () => {
  it("waits for native devtools in a version-less file", async () => {
    await writeFlow("flow", undefined, [{ kind: "launch", app: APP }, READY]);
    const d = device();

    const result = await run(d, LOCAL);

    expect(statuses(result)).toEqual(["launch:pass", "assert:pass"]);
    expect(d.native[0]).toBe(`isConnected:${APP}`);
    expect(axGateReads).toBe(0);
  });

  it("waits for the foreground app in a version 2 file", async () => {
    await writeFlow("flow", 2, [{ kind: "launch", app: APP }, READY]);
    const d = device();

    const result = await run(d, LOCAL);

    expect(statuses(result)).toEqual(["launch:pass", "assert:pass"]);
    expect(axGateReads).toBeGreaterThan(0);
    expect(d.services).not.toContain("NativeDevtools");
  });
});

const runStep = (flow: string): Step => ({ kind: "run", flow: `${flow}.yaml` });

describe("a file run by another", () => {
  it("a `run:` fragment runs on the runner of the test that runs it", async () => {
    await writeFlow("old", undefined, [AX_ONLY]);
    await writeFlow("new", 2, [VH_ONLY]);
    await writeFlow("flow", 2, [runStep("old")]);
    await writeFlow("old-flow", undefined, [runStep("new")]);

    expect(statuses(await run(device(), LOCAL))).toEqual(["run:pass", "assert:pass"]);
    expect(statuses(await run(device(), LOCAL, "old-flow"))).toEqual(["run:pass", "assert:pass"]);
    expect(runners).toEqual(["current", "version-1"]);
    expect(sources).toEqual(["ax", "vh"]);
  });

  it("an e2e test that `tool: e2e-execute` runs uses its own version", async () => {
    await writeFlow("old", undefined, [VH_ONLY]);
    await writeFlow("new", 2, [AX_ONLY]);
    const execute = (name: string): Step => ({
      kind: "tool",
      name: "e2e-execute",
      args: { name, project_root: root },
    });
    await writeFlow("flow", 2, [execute("old"), AX_ONLY]);
    await writeFlow("old-flow", undefined, [execute("new"), VH_ONLY]);

    expect(statuses(await run(device(), LOCAL))).toEqual(["tool:pass", "assert:pass"]);
    expect(statuses(await run(device(), LOCAL, "old-flow"))).toEqual(["tool:pass", "assert:pass"]);
    expect(runners).toEqual(["version-1", "current", "current", "version-1"]);
    expect(sources).toEqual(["vh", "ax", "ax", "vh"]);
  });
});

// The recorder saves a live `e2e-execute` of another e2e test as a `run:` step,
// which replays at the recording's version 2. On an iOS simulator the live run
// of an old e2e test used the version 1 runner, so the step says so.
describe("recording an e2e-execute of another e2e test", () => {
  const OLD_TEST = "is an old e2e test without `version: 2`";

  it.each([
    ["warns for an old e2e test on a simulator", undefined, LOCAL, true],
    ["does not warn for a version 2 e2e test on a simulator", 2, LOCAL, false],
    ["does not warn for an old e2e test on Android", undefined, ANDROID, false],
  ])("records `run:` and %s", async (_label, version, deviceId, warns) => {
    __resetRecordingsForTesting();
    await writeFlow("other", version, [READY]);
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    const result = await createFlowAddStepTool(device().registry).execute(
      {},
      {
        name: "rec",
        project_root: root,
        command: "e2e-execute",
        args: JSON.stringify({ name: "other", project_root: root, device: deviceId }),
      },
      { signal: new AbortController().signal } as never
    );

    expect(result.recorded).toBe("1. run: ../flows/other.yaml");
    expect(statuses(result.toolResult as FlowRunResult)).toEqual(["assert:pass"]);
    if (warns) {
      expect(result.message).toContain(`"other" ${OLD_TEST}`);
      expect(result.message).toContain("Set `version: 2` in other.yaml");
    } else {
      expect(result.message).toBe('Step added to "rec" e2e test');
    }
  });
});

const PLAIN =
  'no visible element matched selector id="missing" — if it is off-screen, add a scroll-to step before this one';

// A tap waits out the full auto-wait before it misses, so these run side by
// side; neither reads `sources` or `targets`.
describe.concurrent("a selector miss", () => {
  const missingTap: Step = { kind: "tap", selector: { identifier: "missing" } };

  async function missReason(
    version: number | undefined,
    deviceId: string,
    step: Step,
    opts?: Parameters<typeof device>[0]
  ) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-file-version-miss-"));
    try {
      await fs.mkdir(path.join(dir, ".argent", "flows"), { recursive: true });
      const flow: FlowFile = {
        ...(version ? { version } : {}),
        executionPrerequisite: "",
        steps: [step],
      };
      await fs.writeFile(path.join(dir, ".argent", "flows", "miss.yaml"), fileText(flow));
      const r = await createRunFlowTool(device(opts).registry).execute(
        {},
        { name: "miss", project_root: dir, device: deviceId },
        { signal: new AbortController().signal } as never
      );
      if (!("steps" in r) || r.steps[0]?.status !== "fail") {
        throw new Error(`expected the step to fail: ${JSON.stringify(r)}`);
      }
      return r.steps[0].reason ?? "";
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("gives the reason from before version 2 in a version-less file", async ({ expect }) => {
    expect(await missReason(undefined, LOCAL, missingTap)).toBe(PLAIN);
  }, 20_000);

  it("explains a missing id from the accessibility tree in a version 2 file", async ({
    expect,
  }) => {
    const reason = await missReason(2, LOCAL, missingTap);
    expect(reason).toContain("no element with this id is in the accessibility tree right now");
  }, 20_000);
});
