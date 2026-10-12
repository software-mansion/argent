import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async () => ({
    tree: { role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] },
    source: "native-devtools" as const,
  })),
}));

import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";

/**
 * The native-devtools precheck RESOLVES its block instead of throwing, so the
 * recorder saw a returned value for a call that terminated and launched
 * nothing. The runner scores that same result a failure
 * (flow-native-devtools-gate.test.ts); a step written from it opens the flow
 * with a `launch:` for an app that never started.
 */

const DEVICE = "00000000-0000-0000-0000-0000000000AB";
const FLOW = "nd-rec";
const BUNDLE = "com.example.app";

let tmpDir: string;

function registryReturning(result: unknown): Registry {
  return {
    invokeTool: vi.fn(async () => result),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

function addStep(registry: Registry, command: string, args: Record<string, unknown>) {
  return createFlowAddStepTool(registry).execute(
    {},
    { name: FLOW, project_root: tmpDir, command, args: JSON.stringify(args) }
  );
}

async function recordedSteps() {
  const content = await fs.readFile(path.join(tmpDir, ".argent", "flows", `${FLOW}.yaml`), "utf8");
  return parseFlow(content).steps;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-record-nd-gate-"));
  __resetRecordingsForTesting();
  await flowStartRecordingTool.execute(
    {},
    { name: FLOW, project_root: tmpDir, executionPrerequisite: "" }
  );
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow-add-step on a blocked native-devtools precheck", () => {
  it.each([
    ["restart_required", "the app must be restarted through argent for native devtools to attach"],
    ["service_stale", "Restarting the app cannot change that — restart the tool-server."],
    ["connect_pending", "It launched moments ago and is still connecting."],
    ["init_failed", "Native devtools failed to initialize for this udid after 3 attempts."],
  ])("refuses a restart-app blocked on %s and records nothing", async (status, message) => {
    const registry = registryReturning({ status, message });

    const err = await addStep(registry, "restart-app", {
      udid: DEVICE,
      bundleId: BUNDLE,
    }).catch((e: unknown) => e as Error);

    // The message is the only field carrying the remedy — for service_stale it
    // is the only thing saying NOT to restart the app.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`restart-app did not run (${status}): ${message}`);
    expect((err as Error).message).toContain("nothing was recorded");
    expect(await recordedSteps()).toEqual([]);
  });

  // The `tool:` spelling reaches the six feature tools the `launch:` rewrite
  // never covers.
  it("refuses a raw native-full-hierarchy step and records nothing", async () => {
    const registry = registryReturning({ status: "restart_required", message: "restart it" });

    await expect(
      addStep(registry, "native-full-hierarchy", { udid: DEVICE, bundleId: BUNDLE })
    ).rejects.toThrow("native-full-hierarchy did not run (restart_required)");
    expect(await recordedSteps()).toEqual([]);
  });

  it("records a launch step when the precheck let restart-app through", async () => {
    await addStep(registryReturning({ restarted: true }), "restart-app", {
      udid: DEVICE,
      bundleId: BUNDLE,
    });

    expect(await recordedSteps()).toEqual([{ kind: "launch", app: BUNDLE }]);
  });

  // Keyed on the tool id as well as the shape: an unrelated tool answering
  // {status} must still record.
  it("records a gesture-tap that answers with one of the block statuses", async () => {
    await addStep(registryReturning({ status: "connect_pending" }), "gesture-tap", {
      udid: DEVICE,
      x: 0.5,
      y: 0.5,
    });

    expect(await recordedSteps()).toEqual([{ kind: "tap", x: 0.5, y: 0.5 }]);
  });
});
