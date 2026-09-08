import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, type Registry } from "@argent/registry";
import type { NativeAppState, NativeDevtoolsApi } from "../../src/blueprints/native-devtools";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// Composition of the two halves the sibling suites pin separately
// (flow-launch-pins-tree-target.test.ts and
// flow-ios-tree-pinned-target.test.ts both assert on the internal target).
// This file asserts the STEP OUTCOME instead, driving the runner's demotion
// through the REAL fetchFlowTree -> queryFullHierarchyTree: nothing on the
// tree path is mocked, and the only seam is the native-devtools service.
//
// The device is the CI shape the pin exists for: the app under test is
// healthy, a second app is connected, and its `Application.getState` never
// answers, so every unhinted read of this simulator times out.

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const APP = "com.example.app";
const OTHER = "com.example.other";
const POISONER = "com.apple.mobilecal";
let tmpDir: string;

function appState(bundleId: string): NativeAppState {
  return {
    bundleId,
    applicationState: "active",
    foregroundActiveSceneCount: 1,
    foregroundInactiveSceneCount: 0,
    backgroundSceneCount: 0,
    unattachedSceneCount: 0,
    isFrontmostCandidate: true,
  };
}

/** What the wedged sibling's `Application.getState` really rejects with. */
function rpcTimeout(): FailureError {
  return new FailureError("ViewInspector RPC timed out: Application.getState", {
    error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT,
    failure_stage: "native_devtools_rpc_request",
    failure_area: "tool_server",
    error_kind: "timeout",
  });
}

/** One spanning window carrying the `ready` marker both asserts look for. */
function readyWindow() {
  return {
    className: "UIWindow",
    frame: { x: 0, y: 0, width: 400, height: 800 },
    windowFrame: { x: 0, y: 0, width: 400, height: 800 },
    children: [
      {
        className: "RCTView",
        identifier: "ready",
        label: "Ready",
        windowFrame: { x: 0, y: 100, width: 400, height: 80 },
        children: [],
      },
    ],
  };
}

/** The healthy app plus a connected sibling whose getState is wedged. */
function nativeApi(hierarchyReads: string[]): NativeDevtoolsApi {
  return {
    listConnectedBundleIds: () => [APP, POISONER],
    isConnected: (id: string) => id === APP || id === POISONER,
    getAppState: async (id: string) => {
      if (id === POISONER) {
        throw rpcTimeout();
      }
      return appState(id);
    },
    queryViewHierarchy: async (id: string) => {
      hierarchyReads.push(id);
      return { windows: [readyWindow()] };
    },
  } as unknown as NativeDevtoolsApi;
}

/** The launched app answering getState from the background, beside a healthy foreground sibling. */
function backgroundedAppApi(hierarchyReads: string[]): NativeDevtoolsApi {
  return {
    listConnectedBundleIds: () => [APP, OTHER],
    isConnected: (id: string) => id === APP || id === OTHER,
    getAppState: async (id: string) =>
      id === APP
        ? {
            ...appState(id),
            applicationState: "background",
            foregroundActiveSceneCount: 0,
            backgroundSceneCount: 1,
            isFrontmostCandidate: false,
          }
        : appState(id),
    queryViewHierarchy: async (id: string) => {
      hierarchyReads.push(id);
      return { windows: [readyWindow()] };
    },
  } as unknown as NativeDevtoolsApi;
}

/** A spanning window with no identified views - the shell a backgrounded app serves. */
function bareWindow() {
  return {
    className: "UIWindow",
    frame: { x: 0, y: 0, width: 400, height: 800 },
    windowFrame: { x: 0, y: 0, width: 400, height: 800 },
    children: [],
  };
}

/**
 * The launched app answers getState from the background, the healthy subject is
 * active, and the wedged sibling's getState never answers. Only the subject's
 * hierarchy carries the `ready` marker - the backgrounded app serves a bare
 * window.
 */
function backgroundedAppWedgedSiblingApi(hierarchyReads: string[]): NativeDevtoolsApi {
  return {
    listConnectedBundleIds: () => [APP, OTHER, POISONER],
    isConnected: (id: string) => id === APP || id === OTHER || id === POISONER,
    getAppState: async (id: string) => {
      if (id === POISONER) {
        throw rpcTimeout();
      }
      return id === APP
        ? {
            ...appState(id),
            applicationState: "background",
            foregroundActiveSceneCount: 0,
            backgroundSceneCount: 1,
            isFrontmostCandidate: false,
          }
        : appState(id);
    },
    queryViewHierarchy: async (id: string) => {
      hierarchyReads.push(id);
      return { windows: [id === OTHER ? readyWindow() : bareWindow()] };
    },
  } as unknown as NativeDevtoolsApi;
}

type ToolCall = { id: string; args: Record<string, unknown> };

// resolveService is the only faked seam; the tool surface just has to answer
// the launch's restart-app and the flow's `tool:` step. `toolCalls` records
// what each dispatch carried.
function mockRegistry(api: NativeDevtoolsApi, toolCalls: ToolCall[] = []): Registry {
  return {
    resolveService: async () => api,
    invokeTool: async (id: string, args: Record<string, unknown>) => {
      toolCalls.push({ id, args });
      return id === "list-devices" ? { devices: [] } : { ok: true };
    },
    getTool: () => ({ inputSchema: { properties: { udid: {} } } }),
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

/** Run an already-written flow, on the poisoned device unless handed another api. */
async function runFlow(
  name: string,
  hierarchyReads: string[],
  toolCalls: ToolCall[] = [],
  api: NativeDevtoolsApi = nativeApi(hierarchyReads)
): Promise<FlowRunResult> {
  return asRun(
    await createRunFlowTool(mockRegistry(api, toolCalls)).execute(
      {},
      { name, project_root: tmpDir, device: DEVICE }
    )
  );
}

/** `launch APP -> assert -> tool: <name> -> assert` on the poisoned device. */
async function runToolStepFlow(
  name: string,
  tool: { name: string; args: Record<string, unknown> },
  hierarchyReads: string[]
): Promise<FlowRunResult> {
  await writeFlow(name, {
    executionPrerequisite: "",
    steps: [
      { kind: "launch", app: APP },
      { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      { kind: "tool", name: tool.name, args: tool.args },
      { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
    ],
  });
  return runFlow(name, hierarchyReads);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-tool-target-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a tool step's tree target against a wedged sibling (end-to-end)", () => {
  it("keeps the launched app as the arbiter across a foreground-neutral tool step", async () => {
    // `screenshot` cannot change the foreground app, so the read after it must
    // still resolve to APP - via the arbiter, since the fan-out it now runs
    // times out on the sibling. Drop the target instead of demoting it and the
    // second assert dies with the sibling's timeout.
    const hierarchyReads: string[] = [];
    const result = await runToolStepFlow(
      "neutral-tool",
      { name: "screenshot", args: {} },
      hierarchyReads
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "tool:pass",
      "assert:pass",
    ]);
    expect(result.ok).toBe(true);
    // One read per assert: the second one is the read the regression lost.
    expect(hierarchyReads).toEqual([APP, APP]);
  });

  it("retires an outage verdict proven while pinned when a tool step demotes the pin", async () => {
    // Every pinned read dies on the foreground guard, so the first tap's settle
    // mints the outage memo. The demoted read never runs that guard, so a memo
    // outliving the demote would have every later gesture skip its settle over
    // a path the run no longer reads.
    const hierarchyReads: string[] = [];
    await writeFlow("outage-outlives-demote", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "tap", x: 0.5, y: 0.5 },
        { kind: "tool", name: "screenshot", args: {} },
        { kind: "tap", x: 0.5, y: 0.5 },
      ],
    });
    const result = await runFlow(
      "outage-outlives-demote",
      hierarchyReads,
      [],
      backgroundedAppApi(hierarchyReads)
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "tap:pass",
      "tool:pass",
      "tap:pass",
    ]);
    // The memo was minted against the foreground guard: the first tap went
    // out warned with its diagnosis, and no read reached the hierarchy.
    expect(result.steps[1].warning).toMatch(/no foreground presence/);
    // The tap after the demote pays for a settle of its own - two reads
    // converging on the sibling, where the stale verdict would have left zero.
    expect(hierarchyReads).toEqual([OTHER, OTHER]);
    expect(result.steps[3].warning).toBeUndefined();
  }, 20_000);

  it("keeps the system-app refusal terminal after a tool step demotes the pin", async () => {
    // The policy verdict must survive the demote, or the demoted read
    // arbitrates toward the system app and reads its hosting view - the
    // false green this covers. Zero hierarchy reads either side of the demote.
    const hierarchyReads: string[] = [];
    await writeFlow("system-app-demote", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: POISONER },
        { kind: "tap", x: 0.5, y: 0.5 },
        { kind: "tool", name: "screenshot", args: {} },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      ],
    });
    const result = await runFlow("system-app-demote", hierarchyReads);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "tap:pass",
      "tool:pass",
      "assert:fail",
    ]);
    expect(result.ok).toBe(false);
    expect(result.steps[1].warning).toMatch(/is an Apple system app/);
    expect(result.steps[3].reason).toMatch(/could not read the UI tree/);
    expect(result.steps[3].reason).toMatch(/is an Apple system app/);
    // The remedy a system-app flow can still act on rides along.
    expect(result.steps[3].reason).toMatch(/tap: \{ x: 0\.5, y: 0\.35 \}/);
    expect(hierarchyReads).toEqual([]);
  }, 20_000);

  it("keeps the foreground refusal across a tool step demoting a backgrounded pin", async () => {
    // The pinned foreground guard refuses the backgrounded app, the flow
    // follows the remedy with a raw `tool:` step, and the wedged sibling sinks
    // the demoted read's fan-out - without a probe of its own the arbiter hands
    // the read back to the app the guard just refused.
    const hierarchyReads: string[] = [];
    await writeFlow("backgrounded-demote", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "tap", x: 0.5, y: 0.5 },
        { kind: "tool", name: "screenshot", args: {} },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      ],
    });
    const result = await runFlow(
      "backgrounded-demote",
      hierarchyReads,
      [],
      backgroundedAppWedgedSiblingApi(hierarchyReads)
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "tap:pass",
      "tool:pass",
      "assert:fail",
    ]);
    expect(result.ok).toBe(false);
    expect(result.steps[1].warning).toMatch(/no foreground presence/);
    expect(result.steps[3].reason).toMatch(/could not read the UI tree/);
    expect(result.steps[3].reason).toMatch(/no foreground presence at all/);
    expect(result.steps[3].reason).toMatch(/applicationState=background/);
    // The refusal, not a verdict decided against the off-screen hierarchy.
    expect(result.steps[3].reason).not.toMatch(/no element matched/);
    expect(hierarchyReads).toEqual([]);
  }, 20_000);

  it("fails a hidden: assert after the demote instead of false-passing on the backgrounded app", async () => {
    // The `hidden:` twin, and the worse failure mode: reading the backgrounded
    // app's bare window finds the subject's marker absent and goes GREEN
    // against a screen that is not on screen. The refusal must instead report a
    // failure, never gone-ness.
    const hierarchyReads: string[] = [];
    await writeFlow("backgrounded-demote-hidden", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "tap", x: 0.5, y: 0.5 },
        { kind: "tool", name: "screenshot", args: {} },
        { kind: "assert", condition: "hidden", selector: { identifier: "ready" } },
      ],
    });
    const result = await runFlow(
      "backgrounded-demote-hidden",
      hierarchyReads,
      [],
      backgroundedAppWedgedSiblingApi(hierarchyReads)
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "tap:pass",
      "tool:pass",
      "assert:fail",
    ]);
    expect(result.ok).toBe(false);
    expect(result.steps[3].reason).toMatch(/could not read the UI tree/);
    expect(result.steps[3].reason).toMatch(/no foreground presence at all/);
    expect(hierarchyReads).toEqual([]);
  }, 20_000);

  it("drops the target across a foreground-changing tool step - the read fails instead", async () => {
    // `launch-app` can put another app on screen, so the pinned target is
    // dropped and re-set from the tool's own args, unpinned. Keep the ORIGINAL
    // app as the hint instead and the runner arbitrates toward an app it can no
    // longer vouch for, false-passing the assert.
    const hierarchyReads: string[] = [];
    const result = await runToolStepFlow(
      "foreground-changing-tool",
      { name: "launch-app", args: { bundleId: "com.example.other" } },
      hierarchyReads
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "tool:pass",
      "assert:fail",
    ]);
    expect(result.steps[3].reason).toMatch(/could not read the UI tree/);
    expect(result.steps[3].reason).toMatch(/RPC timed out/i);
    // Only the pinned read before the tool step ever reached the hierarchy.
    expect(hierarchyReads).toEqual([APP]);
  });

  it("reads the screen aspect for a rotate after a foreground-neutral tool step", async () => {
    // The SILENT variant: `fetchScreenAspect` swallows a failed read and
    // returns undefined, so dropping the target degrades the orbit to the
    // legacy normalized ellipse with the step still green. Hence the assertions
    // on the reads and the geometry - radiusX/radiusY prove the aspect read
    // came back, where a swallowed error dispatches the legacy single
    // `radius`.
    const hierarchyReads: string[] = [];
    const toolCalls: ToolCall[] = [];
    await writeFlow("rotate-after-tool", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
        { kind: "tool", name: "screenshot", args: {} },
        { kind: "rotate", by: 90 },
      ],
    });
    const result = await runFlow("rotate-after-tool", hierarchyReads, toolCalls);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "tool:pass",
      "rotate:pass",
    ]);
    // assert, then the rotate's two settle reads, then the aspect read.
    expect(hierarchyReads).toEqual([APP, APP, APP, APP]);
    expect(result.steps[3]?.warning).toBeUndefined();
    const rotations = toolCalls.filter((c) => c.id === "gesture-rotate");
    expect(rotations).toHaveLength(1);
    // The 400x800 window's aspect, not the aspect-1 fallback: a physical
    // circle has two radii, and on this screen they differ.
    expect(rotations[0].args.radius).toBeUndefined();
    expect(rotations[0].args.radiusX).toEqual(expect.any(Number));
    expect(rotations[0].args.radiusY).toEqual(expect.any(Number));
    expect(rotations[0].args.radiusX).not.toEqual(rotations[0].args.radiusY);
  });

  it("keeps the arbiter when a run: fragment ends in a tool step", async () => {
    // `execRunStep` inlines a fragment into the PARENT's ExecState, so a
    // shared helper ending in a raw `tool:` step un-pins every caller.
    // Dropping the target instead of demoting it kills the parent's next read,
    // in a file the fragment never names.
    const hierarchyReads: string[] = [];
    await writeFlow("dismiss", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "screenshot", args: {} }],
    });
    await writeFlow("fragment-tool", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
        { kind: "run", flow: "dismiss.yaml" },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      ],
    });
    const result = await runFlow("fragment-tool", hierarchyReads);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "run:pass",
      "tool:pass",
      "assert:pass",
    ]);
    expect(result.ok).toBe(true);
    // One read per assert; the second is the one the parent loses if the
    // fragment's tool step drops the target.
    expect(hierarchyReads).toEqual([APP, APP]);
  });

  it("evaluates a when: guard after a tool step instead of stopping the run", async () => {
    // An unreadable tree makes the guard indeterminate, which `execWhenStep`
    // reports as `error` plus `state.stopped` - so a dropped target turns one
    // dead read into a run-level stop, not just one failed assert.
    const hierarchyReads: string[] = [];
    await writeFlow("when-after-tool", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
        { kind: "tool", name: "screenshot", args: {} },
        {
          kind: "when",
          condition: { kind: "ui", condition: "visible", selector: { identifier: "ready" } },
          steps: [{ kind: "echo", message: "guard met" }],
        },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      ],
    });
    const result = await runFlow("when-after-tool", hierarchyReads);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
      "tool:pass",
      "when:pass",
      "echo:pass",
      "assert:pass",
    ]);
    expect(result.ok).toBe(true);
    // assert, the guard's probe read, then the trailing assert.
    expect(hierarchyReads).toEqual([APP, APP, APP]);
  });
});
