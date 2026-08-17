import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";
import type { FlowTreeTarget } from "../../src/tools/flows/flow-actions";
import type { PixelFrame } from "../../src/tools/flows/flow-pixels";

// A launch step must pin every later tree read to the launched app - unpinned
// iOS reads auto-resolve across every connected process, which one poisoned
// background system process sinks. A raw `tool:` step demotes that pin to an
// unpinned hint (still the timeout arbiter for the fan-out, see
// flow-ios-tree.ts) - or drops it outright, when the tool can change the
// foreground app. The mock sits at the iOS tree SOURCE
// (queryFullHierarchyTree), not at fetchFlowTree, so the real fetchFlowTree
// dispatches every read and dropping the target on its ios branch is
// observable here; treeTargets records the target each read actually reached
// the source with, rendered by `label` as level:bundleId.

let treeTargets: Array<FlowTreeTarget | undefined>;
let treeData: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-ios-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-ios-tree")>()),
  queryFullHierarchyTree: vi.fn(
    async (_r: unknown, _d: unknown, target?: FlowTreeTarget): Promise<DescribeTreeData> => {
      // A COPY: the runner hands every read of one pin the same object, so
      // recording the reference would let a later mutation rewrite what the
      // earlier reads saw.
      treeTargets.push(target ? { ...target } : undefined);
      // Stands in for an answered `Application.getState` probe, which the real
      // source records on the target itself (see FlowTreeTarget.probeAnswered).
      if (target?.pinned) target.probeAnswered = true;
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

/** One read's target as `pinned:<app>` / `hint:<app>` / `none`. */
function label(target: FlowTreeTarget | undefined): string {
  return target ? `${target.pinned ? "pinned" : "hint"}:${target.bundleId}` : "none";
}

/** What every read of the run carried, in order. */
function labels(): string[] {
  return treeTargets.map(label);
}

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
  treeTargets = [];
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
    expect(treeTargets.length).toBeGreaterThan(0);
    expect(labels().every((l) => l === `pinned:${APP}`)).toBe(true);
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
    expect(treeTargets.length).toBeGreaterThan(0);
    expect(labels().every((l) => l === `pinned:${APP}`)).toBe(true);
  });

  it("a foreground-neutral tool step demotes the pin to a hint - later reads auto-resolve again", async () => {
    // The tool step's effect on the screen is opaque to the runner, so the pin
    // must not survive it: reads after it auto-resolve. screenshot cannot
    // change the foreground app though, so the launched app stays behind as an
    // unpinned hint - the arbiter that rescues an auto-resolve a wedged
    // sibling process timed out (see flow-tool-step-tree-target-e2e.test.ts).
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
    const firstUnpinned = labels().indexOf(`hint:${APP}`);
    expect(firstUnpinned).toBeGreaterThan(0);
    expect(
      labels()
        .slice(0, firstUnpinned)
        .every((l) => l === `pinned:${APP}`)
    ).toBe(true);
    expect(
      labels()
        .slice(firstUnpinned)
        .every((l) => l === `hint:${APP}`)
    ).toBe(true);
  });

  it("a foreground-changing tool step that names no app drops the target outright", async () => {
    // `button` home can put anything on screen and names nothing, so the
    // launched app is not even a hint afterwards: keeping it would let the
    // arbiter target an app that is no longer frontmost. `launch-app` /
    // `restart-app` are the exception - their args name the app they just
    // started, which is restored as a hint (flow-composition.test.ts).
    await writeFlow("switched", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
        { kind: "tool", name: "button", args: { name: "home" } },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      ],
    });

    const result = await run("switched", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "tool:pass",
      "assert:pass",
    ]);
    const firstDropped = labels().indexOf("none");
    expect(firstDropped).toBeGreaterThan(0);
    expect(
      labels()
        .slice(0, firstDropped)
        .every((l) => l === `pinned:${APP}`)
    ).toBe(true);
    expect(
      labels()
        .slice(firstDropped)
        .every((l) => l === "none")
    ).toBe(true);
  });

  it("a later launch re-pins after a tool step demoted the pin", async () => {
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
    // launch must overwrite (not keep-if-set) the demoted target, and re-pin
    // it rather than inherit its unpinned level.
    const firstOther = labels().indexOf(`pinned:${OTHER}`);
    expect(firstOther).toBeGreaterThan(0);
    expect(
      labels()
        .slice(0, firstOther)
        .every((l) => l.endsWith(`:${APP}`))
    ).toBe(true);
    expect(
      labels()
        .slice(firstOther)
        .every((l) => l === `pinned:${OTHER}`)
    ).toBe(true);
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
    expect(labels()).toEqual([`pinned:${APP}`, `pinned:${OTHER}`]);
  });

  it("a later launch re-arms the probe ride-out on a fresh, unanswered target", async () => {
    // `probeAnswered` decides how a pinned read reads an unanswerable getState:
    // before the pin's first answer it is a cold-start stall to ride out, after
    // it the app has stopped servicing its main queue and the read is refused.
    // A relaunched app cold-starts again, so the second launch must hand out a
    // FRESH target rather than carry the first one's answered flag - otherwise
    // the new app's own cold start is misdiagnosed as a suspension.
    const OTHER = "com.acme.other";
    await writeFlow("rearmed", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
        { kind: "launch", app: OTHER },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      ],
    });
    // The marker appears only on the second poll of the first assert, so that
    // step reads twice - read 2 proves the answer recorded on read 1 really
    // does reach the next read of the same pin.
    treeData = () =>
      treeTargets.length <= 1
        ? {
            tree: screen([n({ identifier: "loading", label: "Loading" })]),
            source: "native-devtools",
          }
        : readyTree();

    const result = await run("rearmed", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "launch:pass",
      "assert:pass",
    ]);
    expect(treeTargets.map((t) => `${label(t)}:${t?.probeAnswered}`)).toEqual([
      `pinned:${APP}:false`,
      `pinned:${APP}:true`,
      `pinned:${OTHER}:false`,
    ]);
  });

  it("a run with no launch step keeps the auto-resolve fallback (no target)", async () => {
    await writeFlow("unpinned", {
      executionPrerequisite: "App is running",
      steps: [{ kind: "assert", condition: "visible", selector: { identifier: "ready" } }],
    });

    const result = await run("unpinned", mockRegistry(), { prerequisiteAcknowledged: true });

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["assert:pass"]);
    expect(treeTargets.length).toBeGreaterThan(0);
    expect(labels().every((l) => l === "none")).toBe(true);
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
    // behind a first-poll pass. The mock pushes the target before serving, so
    // treeTargets.length is the 1-based index of the read being served.
    treeData = () =>
      treeTargets.length <= 2
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
    expect(treeTargets.length).toBeGreaterThanOrEqual(3);
    expect(labels().every((l) => l === `pinned:${APP}`)).toBe(true);
  });
});

// Each directive below routes its reads through a different fetchFlowTree call
// site (settleTree, waitForFocus, fetchScreenAspect, waitForIdle) - dropping
// env.treeTarget from any one of them must fail its test here.
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
    expect(labels()).toEqual([`pinned:${APP}`, `pinned:${APP}`]);
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
    expect(labels()).toEqual([`pinned:${APP}`, `pinned:${APP}`, `pinned:${APP}`]);
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
    expect(labels()).toEqual([`pinned:${APP}`, `pinned:${APP}`, `pinned:${APP}`]);
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
    expect(labels()).toEqual([`pinned:${APP}`, `pinned:${APP}`, `pinned:${APP}`]);
  });
});
