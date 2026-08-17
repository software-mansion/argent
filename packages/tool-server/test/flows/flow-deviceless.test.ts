import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { zodObjectToJsonSchema } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";
import {
  flowRequiresDevice,
  flowScopesDevice,
  stepRequiresDevice,
} from "../../src/tools/flows/flow-device";
import { createStopAllSimulatorServersTool } from "../../src/tools/simulator/stop-all-simulator-servers";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

/**
 * Tools keyed by the device argument they declare — what decides whether a step
 * acts on a device. `undefined` models a tool the registry does not know.
 */
const TOOLS: Record<string, { inputSchema?: unknown } | undefined> = {
  "tap": { inputSchema: { properties: { udid: {}, x: {}, y: {} } } },
  "stop-metro": { inputSchema: { properties: { port: {} } } },
  // Declares a device LIST rather than a single id — the shape the runner has
  // to rebind to the run device, and therefore one that makes a step need one.
  "stop-all-simulator-servers": { inputSchema: { properties: { devices: {} } } },
  // A tool that declares no input at all.
  "gather-workspace-data": {},
  // Takes a device without receiving the run's own.
  "flow-execute": { inputSchema: { properties: { name: {}, device: {} } } },
};

function mockRegistry(opts: { booted?: string[] } = {}) {
  const invokeTool = vi.fn(async (id: string) => {
    if (id === "list-devices") {
      return {
        devices: (opts.booted ?? []).map((udid) => ({ platform: "ios", udid, state: "Booted" })),
      };
    }
    return { ok: true };
  });
  const registry = {
    invokeTool,
    getTool: vi.fn((name: string) => TOOLS[name]),
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
  return { registry, invokeTool };
}

async function writeFlow(name: string, steps: FlowStep[]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({ executionPrerequisite: "", steps }),
    "utf8"
  );
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

/** Run without an explicit device, the case where auto-detection would kick in. */
async function runAuto(registry: Registry, name: string) {
  const runFlow = createRunFlowTool(registry);
  return runFlow.execute({}, { name, project_root: tmpDir });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-deviceless-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a flow that touches no device", () => {
  it("runs with nothing booted, and never looks for a device", async () => {
    await writeFlow("echo-only", [
      { kind: "echo", message: "first step" },
      { kind: "echo", message: "second step" },
    ]);
    const { registry, invokeTool } = mockRegistry({ booted: [] });

    const result = asRun(await runAuto(registry, "echo-only"));

    expect(result.ok).toBe(true);
    expect(result.device).toBe("");
    expect(result.steps.map((s) => [s.kind, s.status])).toEqual([
      ["echo", "pass"],
      ["echo", "pass"],
    ]);
    expect(invokeTool).not.toHaveBeenCalledWith(
      "list-devices",
      expect.anything(),
      expect.anything()
    );
  });

  it("is not attributed to a device that merely happens to be booted", async () => {
    // Otherwise an identical flow reports differently on a laptop with a
    // simulator open than in CI with none.
    await writeFlow("echo-only", [{ kind: "echo", message: "hi" }]);
    const { registry, invokeTool } = mockRegistry({ booted: [DEVICE] });

    const result = asRun(await runAuto(registry, "echo-only"));

    expect(result.device).toBe("");
    expect(invokeTool).not.toHaveBeenCalledWith(
      "list-devices",
      expect.anything(),
      expect.anything()
    );
  });

  it("still names the device when one was asked for explicitly", async () => {
    await writeFlow("echo-only", [{ kind: "echo", message: "hi" }]);
    const { registry } = mockRegistry({ booted: [DEVICE] });
    const runFlow = createRunFlowTool(registry);

    const result = asRun(
      await runFlow.execute({}, { name: "echo-only", project_root: tmpDir, device: DEVICE })
    );

    expect(result.device).toBe(DEVICE);
  });

  it("runs a wait-only flow", async () => {
    await writeFlow("waiting", [{ kind: "wait", ms: 1 }]);
    const { registry } = mockRegistry({ booted: [] });

    expect(asRun(await runAuto(registry, "waiting")).ok).toBe(true);
  });

  it("runs a tool step whose tool takes no device", async () => {
    await writeFlow("stop", [{ kind: "tool", name: "stop-metro", args: { port: 8081 } }]);
    const { registry } = mockRegistry({ booted: [] });

    const result = asRun(await runAuto(registry, "stop"));
    expect(result.ok).toBe(true);
    expect(result.device).toBe("");
  });

  it("runs a tool step whose tool declares no input at all", async () => {
    // A tool with no schema must not be mistaken for one that needs a device,
    // and reading its absent schema must not throw.
    await writeFlow("no-schema", [{ kind: "tool", name: "gather-workspace-data", args: {} }]);
    const { registry } = mockRegistry({ booted: [] });

    expect(asRun(await runAuto(registry, "no-schema")).ok).toBe(true);
  });

  it("runs an empty flow", async () => {
    await writeFlow("nothing", []);
    const { registry } = mockRegistry({ booted: [] });

    const result = asRun(await runAuto(registry, "nothing"));
    expect(result.ok).toBe(true);
    expect(result.device).toBe("");
    expect(result.steps).toEqual([]);
  });
});

describe("a flow that does touch a device still demands one", () => {
  const expectDemandsDevice = async (name: string) => {
    const { registry } = mockRegistry({ booted: [] });
    await expect(runAuto(registry, name)).rejects.toThrow(/No booted device found/);
  };

  it("when a directive step is mixed in with narration", async () => {
    await writeFlow("mixed", [
      { kind: "echo", message: "about to tap" },
      { kind: "tap", x: 0.5, y: 0.5 },
    ]);
    await expectDemandsDevice("mixed");
  });

  it("when the only device step is inside a when block", async () => {
    await writeFlow("guarded", [
      { kind: "echo", message: "checking" },
      {
        kind: "when",
        condition: { kind: "ui", condition: "visible", selector: { text: "Settings" } },
        steps: [{ kind: "tap", x: 0.5, y: 0.5 }],
      },
    ]);
    await expectDemandsDevice("guarded");
  });

  it("when a when block guards on platform and contains only narration", async () => {
    // The guard reads the device's platform, so the block's contents are beside
    // the point.
    await writeFlow("platform-guarded", [
      {
        kind: "when",
        condition: { kind: "platform", platform: "ios" },
        steps: [{ kind: "echo", message: "on ios" }],
      },
    ]);
    await expectDemandsDevice("platform-guarded");
  });

  it("when it launches an app", async () => {
    await writeFlow("launcher", [{ kind: "launch", app: { ios: "com.example.app" } }]);
    await expectDemandsDevice("launcher");
  });

  it("when a tool step's tool declares a device argument", async () => {
    await writeFlow("tapping", [{ kind: "tool", name: "tap", args: { x: 0.5 } }]);
    await expectDemandsDevice("tapping");
  });

  it("when a tool step's tool takes a device without being given the run's own", async () => {
    // A nested flow drives a device even though the runner does not hand it one.
    await writeFlow("nested", [{ kind: "tool", name: "flow-execute", args: { name: "inner" } }]);
    await expectDemandsDevice("nested");
  });

  it("when the tool is unknown to the registry", async () => {
    await writeFlow("mystery", [{ kind: "tool", name: "not-a-tool", args: {} }]);
    await expectDemandsDevice("mystery");
  });

  it("when it composes another flow, even a narration-only one", async () => {
    // The fragment is resolved at run time, so composition is taken to need a
    // device rather than resolved twice and risking disagreement.
    await writeFlow("child", [{ kind: "echo", message: "quiet" }]);
    await writeFlow("parent", [
      { kind: "echo", message: "calling child" },
      { kind: "run", flow: "child.yaml" },
    ]);
    await expectDemandsDevice("parent");
  });
});

describe("stepRequiresDevice", () => {
  it("classifies every step kind", () => {
    // Keyed on the union, so a new step kind fails to compile until it is
    // classified here as well as in the implementation.
    const expected: Record<FlowStep["kind"], boolean> = {
      "echo": false,
      "wait": false,
      "tool": true,
      "run": true,
      "when": true,
      "launch": true,
      "tap": true,
      "long-press": true,
      "type": true,
      "await": true,
      "assert": true,
      "idle": true,
      "scroll-to": true,
      "pinch": true,
      "rotate": true,
      "snapshot": true,
    };
    const samples: Record<FlowStep["kind"], FlowStep> = {
      "echo": { kind: "echo", message: "x" },
      "wait": { kind: "wait", ms: 1 },
      "tool": { kind: "tool", name: "tap", args: {} },
      "run": { kind: "run", flow: "other" },
      "when": { kind: "when", condition: { kind: "platform", platform: "ios" }, steps: [] },
      "launch": { kind: "launch", app: { ios: "com.example" } },
      "tap": { kind: "tap", x: 0, y: 0 },
      "long-press": { kind: "long-press", x: 0, y: 0 },
      "type": { kind: "type", into: { text: "f" }, text: "hi" },
      "await": { kind: "await", condition: "visible", selector: { text: "f" } },
      "assert": { kind: "assert", condition: "visible", selector: { text: "f" } },
      "idle": { kind: "idle" },
      "scroll-to": { kind: "scroll-to", target: { text: "f" }, direction: "down" },
      "pinch": { kind: "pinch", scale: 2 },
      "rotate": { kind: "rotate", by: 90 },
      "snapshot": { kind: "snapshot", name: "s" },
    };

    const { registry } = mockRegistry();
    for (const kind of Object.keys(expected) as FlowStep["kind"][]) {
      expect(stepRequiresDevice(registry, samples[kind]), `kind: ${kind}`).toBe(expected[kind]);
    }
  });

  it("distinguishes tool steps by the device argument their tool declares", () => {
    const { registry } = mockRegistry();
    const toolStep = (name: string): FlowStep => ({ kind: "tool", name, args: {} });

    expect(stepRequiresDevice(registry, toolStep("tap"))).toBe(true);
    expect(stepRequiresDevice(registry, toolStep("flow-execute"))).toBe(true);
    expect(stepRequiresDevice(registry, toolStep("stop-metro"))).toBe(false);
    expect(stepRequiresDevice(registry, toolStep("gather-workspace-data"))).toBe(false);
    expect(stepRequiresDevice(registry, toolStep("not-a-tool"))).toBe(true);
  });

  it("does NOT count the REAL stop-all-simulator-servers schema as needing a device", () => {
    // Against the derived JSON schema, not the mock above: the mock is only as
    // good as its agreement with the tool, and the failure this guards is
    // exactly a drift between the two. Catches a rename of `devices` too.
    //
    // `devices` is a SCOPE, not a target: the unscoped call is a complete,
    // meaningful machine-wide sweep, so a flow whose only step is this one
    // needs no device. Counting it made such a flow demand one — see the
    // cleanup-flow cases below, which are the two situations it actually runs
    // in.
    const schema = zodObjectToJsonSchema(
      createStopAllSimulatorServersTool({} as unknown as Registry).zodSchema!
    );
    expect(Object.keys((schema as { properties: Record<string, unknown> }).properties)).toContain(
      "devices"
    );
    const registry = { getTool: () => ({ inputSchema: schema }) } as unknown as Registry;
    expect(
      stepRequiresDevice(registry, { kind: "tool", name: "stop-all-simulator-servers", args: {} })
    ).toBe(false);
  });

  it("counts a device TARGET argument, but not a device LIST scope", () => {
    // The distinction is what a missing device does to the step: `screenshot`
    // with no `udid` has nothing to point at, while the teardown with no
    // `devices` is the sweep itself.
    const { registry } = mockRegistry();
    expect(
      stepRequiresDevice(registry, { kind: "tool", name: "stop-all-simulator-servers", args: {} })
    ).toBe(false);
    expect(stepRequiresDevice(registry, { kind: "tool", name: "tap", args: {} })).toBe(true);
  });
});

describe("flowRequiresDevice", () => {
  // These pin the function's ANSWERS. With `when` the only block kind, its
  // header decides every case - no FlowStep value can exercise the child walk.
  const whenOver = (steps: FlowStep[]): FlowStep => ({
    kind: "when",
    condition: { kind: "platform", platform: "ios" },
    steps,
  });

  it("answers false for an empty flow", () => {
    const { registry } = mockRegistry();
    expect(flowRequiresDevice(registry, [])).toBe(false);
  });

  it("answers false for narration and waits alone", () => {
    const { registry } = mockRegistry();
    expect(
      flowRequiresDevice(registry, [
        { kind: "echo", message: "hi" },
        { kind: "wait", ms: 1 },
      ])
    ).toBe(false);
  });

  it("answers false for a tool step whose tool takes no device", () => {
    const { registry } = mockRegistry();
    expect(
      flowRequiresDevice(registry, [{ kind: "tool", name: "stop-metro", args: { port: 8081 } }])
    ).toBe(false);
  });

  it("answers true for a tool step whose tool declares a device argument", () => {
    const { registry } = mockRegistry();
    expect(flowRequiresDevice(registry, [{ kind: "tool", name: "tap", args: {} }])).toBe(true);
  });

  it("answers true for a when over a device-free body - the guard reads the device", () => {
    const { registry } = mockRegistry();
    expect(flowRequiresDevice(registry, [whenOver([{ kind: "echo", message: "quiet" }])])).toBe(
      true
    );
  });

  it("answers true for a when nested three deep", () => {
    const { registry } = mockRegistry();
    expect(flowRequiresDevice(registry, [whenOver([whenOver([whenOver([])])])])).toBe(true);
  });

  it("answers true when only a later step in a mixed list needs a device", () => {
    const { registry } = mockRegistry();
    expect(
      flowRequiresDevice(registry, [
        { kind: "echo", message: "about to tap" },
        { kind: "tool", name: "stop-metro", args: { port: 8081 } },
        { kind: "tap", x: 0.5, y: 0.5 },
      ])
    ).toBe(true);
  });
});

describe("flowScopesDevice", () => {
  // These pin the function's ANSWERS. The child walk shows in them - unlike
  // `flowRequiresDevice`, a `when` header scopes nothing itself - but only
  // under a direct call: a run reaches this question only once
  // `flowRequiresDevice` said no, and `when`, the only block kind, answers that
  // one yes for any flow holding a block.
  const whenOver = (steps: FlowStep[]): FlowStep => ({
    kind: "when",
    condition: { kind: "platform", platform: "ios" },
    steps,
  });
  const teardown: FlowStep = { kind: "tool", name: "stop-all-simulator-servers", args: {} };

  it("answers false for an empty flow", () => {
    const { registry } = mockRegistry();
    expect(flowScopesDevice(registry, [])).toBe(false);
  });

  it("answers false for a tool step whose tool declares no device scope", () => {
    const { registry } = mockRegistry();
    expect(
      flowScopesDevice(registry, [
        { kind: "echo", message: "hi" },
        { kind: "tool", name: "stop-metro", args: { port: 8081 } },
      ])
    ).toBe(false);
  });

  it("answers false for a device TARGET argument - a target is not a scope", () => {
    const { registry } = mockRegistry();
    expect(flowScopesDevice(registry, [{ kind: "tool", name: "tap", args: {} }])).toBe(false);
  });

  it("answers true for a tool step whose tool declares a device LIST scope", () => {
    const { registry } = mockRegistry();
    expect(flowScopesDevice(registry, [teardown])).toBe(true);
  });

  it("answers false for a when over a body that scopes nothing", () => {
    const { registry } = mockRegistry();
    expect(flowScopesDevice(registry, [whenOver([{ kind: "echo", message: "quiet" }])])).toBe(
      false
    );
  });

  it("answers true for a scope inside a when, nested three deep", () => {
    const { registry } = mockRegistry();
    expect(flowScopesDevice(registry, [whenOver([whenOver([whenOver([teardown])])])])).toBe(true);
  });
});

describe("a cleanup flow whose only step is stop-all-simulator-servers", () => {
  const teardownOnly: FlowStep[] = [
    // What the recorder writes for an UNSCOPED `stop-all-simulator-servers`.
    // A scoped one keeps its `devices` in the YAML — `stripDeviceKeys` touches
    // only the target keys, and `flow-tools.test.ts`'s "keeps the devices list
    // when recording a scoped teardown" pins that — so the empty args here are
    // the recording of the machine-wide sweep, which replay then NARROWS onto
    // the run device.
    { kind: "tool", name: "stop-all-simulator-servers", args: {} },
  ];

  it("replays against the run device when exactly one is booted", async () => {
    await writeFlow("teardownonly", teardownOnly);
    const { registry, invokeTool } = mockRegistry({ booted: [DEVICE] });
    const run = asRun(await runAuto(registry, "teardownonly"));

    expect(run.device).toBe(DEVICE);
    expect(run.ok).toBe(true);
    expect(invokeTool).toHaveBeenCalledWith("stop-all-simulator-servers", { devices: [DEVICE] });
  });

  it("runs as the machine-wide sweep with NOTHING booted", async () => {
    // One of the two situations a cleanup flow actually runs in. Requiring a
    // device here failed it with "No booted device found" — on a flow whose
    // entire purpose is to run when the machine needs clearing.
    await writeFlow("teardownonly", teardownOnly);
    const { registry, invokeTool } = mockRegistry({ booted: [] });
    const run = asRun(await runAuto(registry, "teardownonly"));

    expect(run.ok).toBe(true);
    expect(run.passed).toBe(1);
    // No scope, and emphatically not `[""]` — an id that owns nothing would
    // reap nothing and still pass.
    expect(invokeTool).toHaveBeenCalledWith("stop-all-simulator-servers", {});
  });

  it("runs as the machine-wide sweep with SEVERAL booted, without disambiguation", async () => {
    // The other one. Requiring a device here failed with "2 booted devices
    // matched — pass --device or --platform", which is not a question a sweep
    // has an answer to.
    await writeFlow("teardownonly", teardownOnly);
    const other = "11111111-1111-1111-1111-111111111111";
    const { registry, invokeTool } = mockRegistry({ booted: [DEVICE, other] });
    const run = asRun(await runAuto(registry, "teardownonly"));

    expect(run.ok).toBe(true);
    expect(invokeTool).toHaveBeenCalledWith("stop-all-simulator-servers", {});
  });

  it("scopes to an explicitly passed device", async () => {
    // The narrowing is deliberate where the run has an answer: a replayed
    // teardown must not reap devices another agent is mid-session on.
    await writeFlow("teardownonly", teardownOnly);
    const other = "11111111-1111-1111-1111-111111111111";
    const { registry, invokeTool } = mockRegistry({ booted: [DEVICE, other] });
    const runFlow = createRunFlowTool(registry);
    const run = asRun(
      await runFlow.execute({}, { name: "teardownonly", project_root: tmpDir, device: DEVICE })
    );

    expect(run.ok).toBe(true);
    expect(invokeTool).toHaveBeenCalledWith("stop-all-simulator-servers", { devices: [DEVICE] });
  });

  it("falls back to the sweep when a passed platform still matches several", async () => {
    // A platform that does not narrow to one device is not an answer either,
    // and the flow must still run rather than demanding --device.
    await writeFlow("teardownonly", teardownOnly);
    const other = "11111111-1111-1111-1111-111111111111";
    const { registry, invokeTool } = mockRegistry({ booted: [DEVICE, other] });
    const runFlow = createRunFlowTool(registry);
    const run = asRun(
      await runFlow.execute({}, { name: "teardownonly", project_root: tmpDir, platform: "ios" })
    );

    expect(run.ok).toBe(true);
    expect(invokeTool).toHaveBeenCalledWith("stop-all-simulator-servers", {});
  });

  it("fails the run when list-devices itself breaks, rather than sweeping the machine", async () => {
    // The opportunistic resolve swallows one answer — "nothing booted, or
    // several" — and used to swallow every other failure with it: an
    // adb/simctl error, a dead sub-tool, an abort. The teardown then ran
    // UNSCOPED and reported pass, which is the machine-wide sweep this path
    // exists to avoid, on a machine whose device list nobody could even read.
    await writeFlow("teardownonly", teardownOnly);
    const { registry, invokeTool } = mockRegistry({ booted: [DEVICE] });
    vi.mocked(registry.invokeTool).mockImplementation(async (id: string) => {
      if (id === "list-devices") throw new Error("adb: device offline");
      return { ok: true };
    });

    await expect(runAuto(registry, "teardownonly")).rejects.toThrow(/adb: device offline/);
    expect(invokeTool).not.toHaveBeenCalledWith(
      "stop-all-simulator-servers",
      expect.anything(),
      expect.anything()
    );
  });

  it("still scopes the teardown when the flow ALSO has a device step", async () => {
    // A flow with a real device step resolves one as it always did, and the
    // teardown is scoped to it — the cross-agent protection the scope exists
    // for is unaffected by any of the above.
    await writeFlow("teardownmixed", [
      { kind: "tool", name: "tap", args: { x: 1, y: 2 } },
      ...teardownOnly,
    ]);
    const { registry, invokeTool } = mockRegistry({ booted: [DEVICE] });
    const run = asRun(await runAuto(registry, "teardownmixed"));

    expect(run.device).toBe(DEVICE);
    expect(run.ok).toBe(true);
    expect(invokeTool).toHaveBeenCalledWith("stop-all-simulator-servers", { devices: [DEVICE] });
  });
});
