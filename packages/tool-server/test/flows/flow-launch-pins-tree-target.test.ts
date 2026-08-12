import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";
import type { PixelFrame } from "../../src/tools/flows/flow-pixels";

// A launch step must pin every later tree read to the launched app - unpinned
// iOS reads auto-resolve across every connected process, which one poisoned
// background system process sinks. The mock sits at the iOS tree SOURCE
// (queryFullHierarchyTree), not at fetchFlowTree, so the real fetchFlowTree
// dispatches every read and dropping the pin on its ios branch is observable
// here; treePins records the bundleId each read actually reached the source
// with.

let treePins: Array<string | undefined>;
let treeData: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-ios-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-ios-tree")>()),
  queryFullHierarchyTree: vi.fn(
    async (_r: unknown, _d: unknown, bundleId?: string): Promise<DescribeTreeData> => {
      treePins.push(bundleId);
      return treeData();
    }
  ),
}));

// The idle step's status-bar mask asks the iOS runtime whether this fabricated
// UDID is a tvOS simulator; pin the mobile answer instead of shelling out.
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));

// idle settles only on a comparable capture pair; a constant frame lets the
// real comparison call the screen still instead of burning the step's timeout.
vi.mock("../../src/tools/flows/flow-pixels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-pixels")>()),
  capturePixelsWithin: vi.fn(async (): Promise<PixelFrame> => STILL_FRAME),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const APP = "com.acme.app";
const STILL_FRAME: PixelFrame = { width: 10, height: 10, data: Buffer.alloc(400) };
let tmpDir: string;

function n(partial: Partial<DescribeNode>): DescribeNode {
  return {
    role: "AXOther",
    frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
    children: [],
    ...partial,
  };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function readyTree(): DescribeTreeData {
  return {
    tree: screen([n({ identifier: "ready", label: "Ready" })]),
    source: "native-devtools",
  };
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    // The iOS launch step gates on a native-devtools connection; report
    // connected so the run proceeds past it.
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [APP],
    })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

async function run(
  name: string,
  registry: Registry,
  args: Record<string, unknown> = {}
): Promise<FlowRunResult> {
  return asRun(
    await createRunFlowTool(registry).execute(
      {},
      { name, project_root: tmpDir, device: DEVICE, ...args },
      { signal: new AbortController().signal } as never
    )
  );
}

beforeEach(async () => {
  treePins = [];
  treeData = readyTree;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pin-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("launch pins the flow tree target", () => {
  it("every read after a launch step carries the launched app id", async () => {
    await writeFlow("pinned", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      ],
    });

    const result = await run("pinned", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
    ]);
    expect(treePins.length).toBeGreaterThan(0);
    expect(treePins.every((pin) => pin === APP)).toBe(true);
  });

  it("a fragment's steps inherit the pin from the parent run's launch", async () => {
    await writeFlow("frag", {
      executionPrerequisite: "App is running",
      steps: [{ kind: "assert", condition: "visible", selector: { identifier: "ready" } }],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "run", flow: "frag.yaml" },
      ],
    });

    const result = await run("main", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "run:pass",
      "assert:pass",
    ]);
    expect(treePins.length).toBeGreaterThan(0);
    expect(treePins.every((pin) => pin === APP)).toBe(true);
  });

  it("a raw tool step clears the pin - later reads auto-resolve again", async () => {
    // The tool step's effect on the screen is opaque to the runner (it could
    // be launch-app, open-url, button {home}...), so the pin must not survive
    // it: reads before the tool step carry the launched app, reads after none.
    await writeFlow("escaped", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
        { kind: "tool", name: "screenshot", args: {} },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      ],
    });

    const result = await run("escaped", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "tool:pass",
      "assert:pass",
    ]);
    const firstUnpinned = treePins.indexOf(undefined);
    expect(firstUnpinned).toBeGreaterThan(0);
    expect(treePins.slice(0, firstUnpinned).every((pin) => pin === APP)).toBe(true);
    expect(treePins.slice(firstUnpinned).every((pin) => pin === undefined)).toBe(true);
  });

  it("a later launch re-pins after a tool step cleared the pin", async () => {
    const OTHER = "com.acme.other";
    await writeFlow("repinned", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
        { kind: "tool", name: "screenshot", args: {} },
        { kind: "launch", app: OTHER },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      ],
    });

    const result = await run("repinned", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "tool:pass",
      "launch:pass",
      "assert:pass",
    ]);
    // First reads carry the first app, final reads the second - the second
    // launch must overwrite (not keep-if-set) the cleared pin.
    const firstOther = treePins.indexOf(OTHER);
    expect(firstOther).toBeGreaterThan(0);
    expect(treePins.slice(0, firstOther).every((pin) => pin === APP)).toBe(true);
    expect(treePins.slice(firstOther).every((pin) => pin === OTHER)).toBe(true);
  });

  it("back-to-back launches move the pin to the newest app", async () => {
    // No tool step between the launches, so nothing clears the pin before the
    // second one runs - it must overwrite (not keep-if-set) a still-set pin.
    const OTHER = "com.acme.other";
    await writeFlow("relaunched", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
        { kind: "launch", app: OTHER },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      ],
    });

    const result = await run("relaunched", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "launch:pass",
      "assert:pass",
    ]);
    expect(treePins).toEqual([APP, OTHER]);
  });

  it("a run with no launch step keeps the auto-resolve fallback (no pin)", async () => {
    await writeFlow("unpinned", {
      executionPrerequisite: "App is running",
      steps: [{ kind: "assert", condition: "visible", selector: { identifier: "ready" } }],
    });

    const result = await run("unpinned", mockRegistry(), { prerequisiteAcknowledged: true });

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["assert:pass"]);
    expect(treePins.length).toBeGreaterThan(0);
    expect(treePins.every((pin) => pin === undefined)).toBe(true);
  });

  it("every retry poll of a condition carries the pin, not just the first", async () => {
    await writeFlow("retried", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      ],
    });
    // The element appears only on the third poll, so waitForCondition retries
    // - a regression that pins only the first read of a step cannot hide
    // behind a first-poll pass. The mock pushes the pin before serving, so
    // treePins.length is the 1-based index of the read being served.
    treeData = () =>
      treePins.length <= 2
        ? {
            tree: screen([n({ identifier: "loading", label: "Loading" })]),
            source: "native-devtools",
          }
        : readyTree();

    const result = await run("retried", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
    ]);
    expect(treePins.length).toBeGreaterThanOrEqual(3);
    expect(treePins.every((pin) => pin === APP)).toBe(true);
  });
});

// Each directive below routes its reads through a different fetchFlowTree call
// site (settleTree, waitForFocus, fetchScreenAspect, waitForIdle) - dropping
// env.launchedAppId from any one of them must fail its test here.
describe("every read path carries the launch pin", () => {
  it("tap - the settle reads resolving the target (settleTree)", async () => {
    await writeFlow("tapped", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "tap", selector: { identifier: "ready" } },
      ],
    });

    const result = await run("tapped", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass", "tap:pass"]);
    // settleTree resolves the target on two identical consecutive reads.
    expect(treePins).toEqual([APP, APP]);
  });

  it("type - the focus-wait read (waitForFocus) after the settle reads", async () => {
    await writeFlow("typed", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "type", into: { identifier: "field" }, text: "hello" },
      ],
    });
    // The field already reports focus, so the focus wait confirms on its
    // first read.
    treeData = () => ({
      tree: screen([n({ identifier: "field", role: "AXTextField", focused: true })]),
      source: "native-devtools",
    });

    const result = await run("typed", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass", "type:pass"]);
    // Two settle reads resolve the field, one focus-wait read confirms.
    expect(treePins).toEqual([APP, APP, APP]);
  });

  it("rotate - the screen-aspect read (fetchScreenAspect)", async () => {
    await writeFlow("rotated", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "rotate", by: 90 },
      ],
    });

    const result = await run("rotated", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "rotate:pass",
    ]);
    // A selector-less rotate settles first (two reads), then reads once more
    // for the aspect.
    expect(treePins).toEqual([APP, APP, APP]);
  });

  it("idle - every settle-poll read (waitForIdle)", async () => {
    await writeFlow("idled", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "idle", timeout: 2000, stableFor: 0 },
      ],
    });

    const result = await run("idled", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass", "idle:pass"]);
    // A settle is three reads spanning two still intervals (tree + pixels).
    expect(treePins).toEqual([APP, APP, APP]);
  });
});
