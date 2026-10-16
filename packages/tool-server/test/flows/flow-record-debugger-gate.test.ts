import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";

/**
 * debugger-status / debugger-log-registry RESOLVE a not_connected result, and
 * the runner scores it a failure (flow-debugger-gate.test.ts), so the recorder
 * must not write it as a step.
 */

const FLOW = "dbg-rec";
const NOT_CONNECTED = {
  status: "not_connected",
  connected: false,
  port: 8081,
  reason: "no_app_connected",
  detail: "Metro at port 8081 has no CDP targets",
  guidance: "launch the app",
};

let tmpDir: string;

function addStep(result: unknown, command: string) {
  const registry = {
    invokeTool: vi.fn(async () => result),
    getTool: vi.fn(() => ({ inputSchema: { properties: {} } })),
  } as unknown as Registry;
  return createFlowAddStepTool(registry).execute(
    {},
    { name: FLOW, project_root: tmpDir, command, args: JSON.stringify({ device_id: "dev" }) }
  );
}

async function recordedSteps() {
  const content = await fs.readFile(path.join(tmpDir, ".argent", "flows", `${FLOW}.yaml`), "utf8");
  return parseFlow(content).steps;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-record-dbg-gate-"));
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

describe("flow-add-step on a not_connected debugger result", () => {
  it.each(["debugger-status", "debugger-log-registry"])(
    "refuses %s and records nothing",
    async (command) => {
      await expect(addStep(NOT_CONNECTED, command)).rejects.toThrow(
        `${command} found no debugger (no_app_connected): Metro at port 8081 has no CDP targets - nothing was recorded; launch the app`
      );
      expect(await recordedSteps()).toEqual([]);
    }
  );

  it("records a connected debugger-status", async () => {
    await addStep({ status: "connected", connected: true }, "debugger-status");
    expect(await recordedSteps()).toEqual([
      expect.objectContaining({ kind: "tool", name: "debugger-status" }),
    ]);
  });

  // Keyed on the tool id as well as the shape.
  it("records a non-debugger tool that answers status not_connected", async () => {
    await addStep(NOT_CONNECTED, "native-devtools-status");
    expect(await recordedSteps()).toEqual([
      expect.objectContaining({ kind: "tool", name: "native-devtools-status" }),
    ]);
  });
});
