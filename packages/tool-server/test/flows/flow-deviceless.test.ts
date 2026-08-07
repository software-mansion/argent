import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";
import { stepRequiresDevice } from "../../src/tools/flows/flow-device";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

/**
 * Tools keyed by the device argument they declare — what decides whether a step
 * acts on a device. `undefined` models a tool the registry does not know.
 */
const TOOLS: Record<string, { inputSchema?: unknown } | undefined> = {
  "tap": { inputSchema: { properties: { udid: {}, x: {}, y: {} } } },
  "stop-metro": { inputSchema: { properties: { port: {} } } },
  // A real tool that declares no input at all.
  "stop-all-simulator-servers": {},
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
    await writeFlow("stop-all", [{ kind: "tool", name: "stop-all-simulator-servers", args: {} }]);
    const { registry } = mockRegistry({ booted: [] });

    expect(asRun(await runAuto(registry, "stop-all")).ok).toBe(true);
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
    expect(stepRequiresDevice(registry, toolStep("stop-all-simulator-servers"))).toBe(false);
    expect(stepRequiresDevice(registry, toolStep("not-a-tool"))).toBe(true);
  });
});
