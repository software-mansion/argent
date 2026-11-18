import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { AXTreeResponse } from "../../src/blueprints/ax-service";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";
import type { FlowTreeTarget } from "../../src/tools/flows/flow-actions";

// Runs of each file version through the REAL runner. On an iOS simulator a
// version-less (or version 1) file reads the view hierarchy and keeps the
// rules from before version 2; a version 2 file reads the accessibility tree.
// A physical iPhone and Android run every version the same.
//
// The simulator sources are real behind mocked services, so a test sees which
// service and which native devtools method a read used. The physical-device
// and Android sources answer a fixed tree. Pass-through spies record every
// read's source and the launch target it carried.

/** One entry per tree read, in order: the source it went to. */
let sources: string[];
/** The target each `fetchFlowTree` call carried, as `pinned:<app>`, `hint:<app>` or `none`. */
let targets: string[];
/** External calls of `readIosSimulatorUiTree`: the launch gate and the stale-selector read. */
let axGateReads: number;

function label(target: FlowTreeTarget | undefined): string {
  return target ? `${target.pinned ? "pinned" : "hint"}:${target.bundleId}` : "none";
}

vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-tree")>();
  return {
    ...actual,
    fetchFlowTree: vi.fn((...args: Parameters<typeof actual.fetchFlowTree>) => {
      targets.push(label(args[2]));
      return actual.fetchFlowTree(...args);
    }),
  };
});
vi.mock("../../src/tools/flows/flow-ios-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-ios-tree")>();
  return {
    ...actual,
    queryFullHierarchyTree: vi.fn((...args: Parameters<typeof actual.queryFullHierarchyTree>) => {
      sources.push("vh");
      return actual.queryFullHierarchyTree(...args);
    }),
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

import {
  createRunFlowTool,
  NATIVE_READY_TIMEOUT_MS,
  type FlowRunResult,
} from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowFile, type FlowSelector } from "../../src/tools/flows/flow-utils";

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

/** Enough 250 ms pumps for two launch gates to time out. */
const PUMP_LIMIT = Math.ceil(NATIVE_READY_TIMEOUT_MS / 250) * 10;

/** {@link run} on a fake clock, for runs that wait out gates and settles. */
async function runPumped(d: Device, deviceId: string): Promise<FlowRunResult> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const pending = run(d, deviceId);
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true)
    );
    for (let i = 0; i < PUMP_LIMIT && !settled; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(250);
    }
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

const assertVisible = (selector: FlowSelector): Step => ({
  kind: "assert",
  condition: "visible",
  selector,
});
const VH_ONLY = assertVisible({ identifier: "vh-only" });
const AX_ONLY = assertVisible({ text: "AX Only" });
const READY = assertVisible({ identifier: "ready" });

beforeEach(async () => {
  sources = [];
  targets = [];
  axGateReads = 0;
  // Removed by its own test's teardown: the concurrent tests below overwrite
  // `root`, so an afterEach would remove only the last one.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-file-version-run-"));
  root = dir;
  return () => fs.rm(dir, { recursive: true, force: true });
});

describe("the tree each version reads", () => {
  it.each([
    ["a version-less", undefined],
    ["a version 1", 1],
  ])("%s file reads the view hierarchy on an iOS simulator", async (_name, version) => {
    await writeFlow("flow", version, [VH_ONLY]);
    const d = device();

    const result = await run(d, LOCAL);

    expect(statuses(result)).toEqual(["assert:pass"]);
    expect(sources).toEqual(["vh"]);
    expect(d.native).toContain(`ViewHierarchy.getFullHierarchy:${APP}`);
    expect(d.services).not.toContain("AXService");
  });

  it("a version 2 file reads the accessibility tree on an iOS simulator", async () => {
    await writeFlow("flow", 2, [AX_ONLY]);
    const d = device();

    const result = await run(d, LOCAL);

    expect(statuses(result)).toEqual(["assert:pass"]);
    expect(sources).toEqual(["ax"]);
    expect(d.services).not.toContain("NativeDevtools");
  });

  it.each([
    ["a version-less", undefined, VH_ONLY, "vh", "NativeDevtools"],
    ["a version 2", 2, AX_ONLY, "ax", "AXService"],
  ])(
    "a remote simulator reads the same tree as a local one in %s file",
    async (_name, version, step, source, service) => {
      await writeFlow("flow", version, [step]);
      const d = device();

      const result = await run(d, REMOTE);

      expect(statuses(result)).toEqual(["assert:pass"]);
      expect(sources).toEqual([source]);
      expect(d.services).toContain(service);
    }
  );

  it.each([
    [PHONE, "device"],
    [ANDROID, "android"],
    [MAC_APP, "macos"],
  ])("%s reads its one tree at every version", async (deviceId, source) => {
    for (const version of [undefined, 1, 2]) {
      sources = [];
      await writeFlow("flow", version, [READY]);
      const result = await run(device(), deviceId);
      expect(statuses(result)).toEqual(["assert:pass"]);
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
    expect(targets).toEqual([`pinned:${APP}`]);
  });

  it("waits for the foreground app in a version 2 file", async () => {
    await writeFlow("flow", 2, [{ kind: "launch", app: APP }, READY]);
    const d = device();

    const result = await run(d, LOCAL);

    expect(statuses(result)).toEqual(["launch:pass", "assert:pass"]);
    expect(axGateReads).toBeGreaterThan(0);
    expect(d.services).not.toContain("NativeDevtools");
  });

  it("fails a version-less launch with the native devtools reason", async () => {
    await writeFlow("flow", undefined, [{ kind: "launch", app: APP }, READY]);

    const result = await run(device({ nativeDevtoolsDown: true }), LOCAL);

    expect(statuses(result)).toEqual(["launch:error", "assert:skip"]);
    expect(result.steps[0]!.reason).toBe(
      `could not connect to native devtools for ${APP}: socket closed`
    );
  });

  it("fails a version-less launch when the app never connects", async () => {
    await writeFlow("flow", undefined, [{ kind: "launch", app: APP }, READY]);

    const result = await runPumped(device({ connectAfterMs: Infinity }), LOCAL);

    expect(statuses(result)).toEqual(["launch:error", "assert:skip"]);
    expect(result.steps[0]!.reason).toMatch(
      new RegExp(`^could not connect to native devtools: ${APP} did not connect within 15000 ms`)
    );
  });
});

describe("`run:` runs a fragment at the version of the test that runs it", () => {
  it("a version 2 test runs a version-less fragment on the accessibility tree", async () => {
    await writeFlow("old", undefined, [AX_ONLY]);
    await writeFlow("flow", 2, [AX_ONLY, { kind: "run", flow: "old.yaml" }, AX_ONLY]);

    const result = await run(device(), LOCAL);

    expect(statuses(result)).toEqual(["assert:pass", "run:pass", "assert:pass", "assert:pass"]);
    expect(sources).toEqual(["ax", "ax", "ax"]);
  });

  it("a version-less test runs a version 2 fragment on the view hierarchy", async () => {
    await writeFlow("new", 2, [VH_ONLY]);
    await writeFlow("flow", undefined, [VH_ONLY, { kind: "run", flow: "new.yaml" }, VH_ONLY]);

    const result = await run(device(), LOCAL);

    expect(statuses(result)).toEqual(["assert:pass", "run:pass", "assert:pass", "assert:pass"]);
    expect(sources).toEqual(["vh", "vh", "vh"]);
  });
});

const runStep = (flow: string): Step => ({ kind: "run", flow: `${flow}.yaml` });

describe("a file of each version run by another", () => {
  it("fails a `run:` of an unsupported version with the parse error", async () => {
    const dir = path.join(root, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "newer.yaml"), "version: 3\nsteps: []\n", "utf8");
    await writeFlow("flow", 2, [runStep("newer"), AX_ONLY]);

    const result = await run(device(), LOCAL);

    expect(statuses(result)).toEqual(["run:error", "assert:skip"]);
    expect(result.steps[0]!.reason).toContain(
      'could not load fragment "newer.yaml": The e2e test file is version 3, but this Argent reads up to version 2.'
    );
  });

  it("rejects an unsupported version in the e2e test it runs", async () => {
    const dir = path.join(root, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "flow.yaml"), "version: 0\nsteps: []\n", "utf8");

    await expect(run(device(), LOCAL)).rejects.toThrow(
      "Invalid e2e test file: version must be a positive integer, got 0"
    );
  });

  it("runs a version-less e2e test that a version 2 test runs with `tool: e2e-execute` on the view hierarchy", async () => {
    await writeFlow("old", undefined, [VH_ONLY]);
    await writeFlow("flow", 2, [
      { kind: "tool", name: "e2e-execute", args: { name: "old", project_root: root } },
      AX_ONLY,
    ]);

    const result = await run(device(), LOCAL);

    expect(statuses(result)).toEqual(["tool:pass", "assert:pass"]);
    expect(sources).toEqual(["vh", "ax"]);
  });
});

describe("an empty text field in a `matches` check", () => {
  const emptyCheck: Step = {
    kind: "assert",
    condition: "text",
    selector: { identifier: "email" },
    expectedText: "^$",
    textMatch: "matches",
  };

  it("never reads as empty in a version-less file on an iOS simulator", async () => {
    await writeFlow("flow", undefined, [emptyCheck]);

    const result = await run(device(), LOCAL);

    expect(statuses(result)).toEqual(["assert:fail"]);
    expect(result.steps[0]!.reason).toContain('element matched id="email" but its text was ""');
  });

  it.each([
    ["a version 2 file on an iOS simulator", 2, LOCAL],
    ["a version-less file on a physical iPhone", undefined, PHONE],
    ["a version-less file on Android", undefined, ANDROID],
  ])("reads as empty in %s", async (_name, version, deviceId) => {
    await writeFlow("flow", version, [emptyCheck]);

    const result = await run(device(), deviceId);

    expect(statuses(result)).toEqual(["assert:pass"]);
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

  it("keeps main's reason in a version-less file", async ({ expect }) => {
    expect(await missReason(undefined, LOCAL, missingTap)).toBe(PLAIN);
  }, 20_000);

  it("explains a missing id from the accessibility tree in a version 2 file", async ({
    expect,
  }) => {
    const reason = await missReason(2, LOCAL, missingTap);
    expect(reason).toContain("no element with this id is in the accessibility tree right now");
  }, 20_000);
});
