import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, type Registry } from "@argent/registry";
import type { NativeAppState, NativeDevtoolsApi } from "../../src/blueprints/native-devtools";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// Composition of the two halves the sibling suites pin separately:
// flow-launch-pins-tree-target.test.ts proves a `tool:` step un-pins the tree
// target, but stubs the tree source; flow-ios-tree-pinned-target.test.ts proves
// an unpinned target arbitrates a fan-out a wedged sibling sank, but is handed
// that target by hand. Both assert on the internal target; this file is the
// only one that asserts the STEP OUTCOME a run gets on such a device, driving
// the runner's demotion through the REAL fetchFlowTree ->
// queryFullHierarchyTree - nothing on the tree path is mocked, and the only
// seam is the native-devtools service.
//
// The device is the CI shape the pin exists for: the app under test is
// healthy, a second app is connected, and its `Application.getState` never
// answers (a process parked mid-RPC). Auto-resolution `Promise.all`s getState
// over both, so every unhinted read of this simulator times out.

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const APP = "com.example.app";
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
        throw new FailureError("ViewInspector RPC timed out: Application.getState", {
          error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT,
          failure_stage: "native_devtools_rpc_request",
          failure_area: "tool_server",
          error_kind: "timeout",
        });
      }
      return appState(id);
    },
    requiresAppRestart: async () => false,
    queryViewHierarchy: async (id: string) => {
      hierarchyReads.push(id);
      return { windows: [readyWindow()] };
    },
  } as unknown as NativeDevtoolsApi;
}

// resolveService is the only faked seam; the tool surface just has to answer
// the launch's restart-app and the flow's `tool:` step.
function mockRegistry(api: NativeDevtoolsApi): Registry {
  return {
    resolveService: async () => api,
    invokeTool: async (id: string) => (id === "list-devices" ? { devices: [] } : { ok: true }),
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
  return asRun(
    await createRunFlowTool(mockRegistry(nativeApi(hierarchyReads))).execute(
      {},
      { name, project_root: tmpDir, device: DEVICE }
    )
  );
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

  it("drops the target across a foreground-changing tool step - the read fails instead", async () => {
    // `launch-app` can put another app on screen, so the launched app is not
    // even a hint: the read auto-resolves, the fan-out times out on the
    // sibling, and the assert reports it. This is what keeps the two
    // confidence levels distinct - demote here and the runner would arbitrate
    // toward an app it can no longer vouch for.
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
});
