import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, type Registry } from "@argent/registry";
import type { DescribeTreeData } from "../../src/tools/describe/contract";

const describeVega = vi.fn(async (): Promise<DescribeTreeData> => {
  throw new Error("describeVega result not stubbed for this test");
});
vi.mock("../../src/tools/describe/platforms/vega", () => ({
  vegaRequires: ["adb"],
  describeVega: (...args: unknown[]) => describeVega(...(args as [])),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const VEGA = "amazon-4a27df03c9777152";

function notRegistered(): FailureError {
  return new FailureError("VVD not registered with adb yet.", {
    error_code: FAILURE_CODES.VEGA_DEVICE_NOT_REGISTERED,
    failure_stage: "vega_adb_register",
    failure_area: "tool_server",
    error_kind: "timeout",
  });
}
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-vega-gate-")));
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "main.yaml"),
    serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app.main" },
        { kind: "echo", message: "should never run" },
      ],
    }),
    "utf8"
  );
});
afterEach(async () => {
  describeVega.mockReset();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function runMain(): Promise<FlowRunResult> {
  const registry = {
    invokeTool: vi.fn(async (id: string) =>
      id === "list-devices" ? { devices: [] } : { ok: true }
    ),
    getTool: vi.fn(() => undefined),
    resolveService: vi.fn(),
  } as unknown as Registry;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const pending = createRunFlowTool(registry).execute(
      {},
      { name: "main", project_root: tmpDir, device: VEGA }
    );
    let settled = false;
    void pending.then(() => (settled = true));
    for (let i = 0; i < 400 && !settled; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(250);
    }
    const result = await pending;
    if (!("steps" in result))
      throw new Error(`expected a run result, got notice: ${result.notice}`);
    return result;
  } finally {
    vi.useRealTimers();
  }
}

describe("flow launch gate on Vega", () => {
  it("errors the launch step with the discovery failure still standing at the deadline", async () => {
    describeVega.mockRejectedValueOnce(notRegistered()).mockRejectedValue(
      new FailureError("No running Vega Virtual Device found.", {
        error_code: FAILURE_CODES.VEGA_DEVICE_NOT_FOUND,
        failure_stage: "vega_discover_console_port",
        failure_area: "tool_server",
        error_kind: "not_found",
      })
    );
    const result = await runMain();
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:error", "echo:skip"]);
    expect(result.steps[0].reason).toContain(
      "Vega device discovery failed: No running Vega Virtual Device found."
    );
  });

  it("keeps the relaunch advice when the toolkit answered but never served a tree", async () => {
    describeVega.mockRejectedValueOnce(notRegistered()).mockResolvedValue({
      tree: { role: "root", frame: { x: 0, y: 0, width: 0, height: 0 }, children: [] },
      source: "vega-automation",
      hint: "relaunch the foreground app",
    } as DescribeTreeData);
    const result = await runMain();
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:error", "echo:skip"]);
    expect(result.steps[0].reason).toContain("never served a page source for com.acme.app.main");
    expect(result.steps[0].reason).not.toContain("VVD not registered");
  });
});
