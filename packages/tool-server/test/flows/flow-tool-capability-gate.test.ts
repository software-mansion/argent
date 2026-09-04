import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry, TypedEventEmitter } from "@argent/registry";
import type { ToolDefinition } from "@argent/registry";

import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import { rotateTool } from "../../src/tools/rotate";
import { SIMULATOR_SERVER_NAMESPACE } from "../../src/blueprints/simulator-server";

// The reviewer's repro: a recorded `- tool: rotate` step replays against a
// HarmonyOS device. `Registry.invokeTool` does not run the HTTP layer's
// capability gate, so before flow-run pre-flighted the step itself the invoke
// reached `SimulatorServer.factory`, which rejects the platform — wrapping that
// low-level refusal in "Service dependency failed: ..." and leaving an ERROR
// node behind for a server that was never started.

const HARMONY_DEVICE = "harmony-127.0.0.1:5555";
const ANDROID_DEVICE = "emulator-5556";

let tmpDir: string;
let registry: Registry;

/** Factory stand-in for SimulatorServer: records every start attempt it sees,
 * and rejects HarmonyOS exactly as the real blueprint does. */
const factory = vi.fn(async (_deps, _payload, options?: { device?: { platform?: string } }) => {
  if (options?.device?.platform !== "android") {
    throw new Error(
      `${SIMULATOR_SERVER_NAMESPACE}.factory does not support platform "${options?.device?.platform}". Use the platform-specific service blueprint instead.`
    );
  }
  return { api: {}, dispose: async () => {}, events: new TypedEventEmitter() };
});

function urns(): string[] {
  return [...registry.getSnapshot().services.keys()];
}

async function writeRotateFlow(name: string): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "rotate", args: { orientation: "LandscapeLeft" } }],
    }),
    "utf8"
  );
}

async function run(device: string) {
  await writeRotateFlow("rotate-step");
  const tool = createRunFlowTool(registry);
  const result = await tool.execute({}, { name: "rotate-step", project_root: tmpDir, device });
  if (!("steps" in result)) throw new Error("expected a run result");
  return result;
}

beforeEach(() => {
  // The real definition supplies id, zodSchema, capability and services(); only
  // the executor is replaced, since its real body drives the (stubbed) server.
  const rotate = {
    ...rotateTool,
    execute: async () => ({ orientation: "LandscapeLeft" }),
  } as unknown as ToolDefinition;
  registry = new Registry();
  registry.registerBlueprint({
    namespace: SIMULATOR_SERVER_NAMESPACE,
    getURN: (payload: string) => `${SIMULATOR_SERVER_NAMESPACE}:${payload}`,
    factory,
  });
  registry.registerTool(rotate);
});

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-tool-gate-"));
});

afterEach(async () => {
  factory.mockClear();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a raw tool: step is capability-gated before dispatch", () => {
  it("stops a rotate against harmony with the refusal and no service node minted", async () => {
    const r = await run(HARMONY_DEVICE);

    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ kind: "tool", status: "error", tool: "rotate" });
    // The refusal names the capability declaration, not the service blueprint's
    // rejection wrapped as a dependency failure.
    expect(r.steps[0].reason).toContain("Tool 'rotate' is not supported on harmony");
    expect(r.steps[0].reason).not.toContain("Service dependency failed");
    // Nothing was started and no node was left behind: the gate runs before
    // `invokeTool` resolves any service.
    expect(factory).not.toHaveBeenCalled();
    expect(urns()).not.toContain(`SimulatorServer:${HARMONY_DEVICE}`);
  });

  it("still dispatches the same step on a supported platform", async () => {
    const r = await run(ANDROID_DEVICE);

    expect(r.ok).toBe(true);
    expect(r.steps[0]).toMatchObject({ kind: "tool", status: "pass", tool: "rotate" });
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[2]).toMatchObject({
      device: { platform: "android", id: ANDROID_DEVICE },
    });
    expect(urns()).toEqual([`SimulatorServer:${ANDROID_DEVICE}`]);
  });
});
