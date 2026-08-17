import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

/**
 * The native-devtools precheck RESOLVES its block instead of throwing, so a
 * `tool:` step that ran one of these tools and got nothing done still returned
 * a value — and a saved regression flow reported `ok: true` for a native read
 * that never happened. `launch:` guards its own `restart-app` inside
 * `runLaunch`; this is the `tool:` spelling, which reaches the same two
 * sub-tools plus the six feature tools the directive form never covers.
 * Mirrors flow-debugger-gate.test.ts for the debugger's precondition results.
 */

const PROJECT_ROOT = path.join(os.tmpdir(), `flow-nd-gate-tests-${process.pid}`);

function makeRegistry(invoke: (id: string, args: unknown) => Promise<unknown>) {
  return {
    invokeTool: vi.fn(invoke),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: string): Promise<string> {
  const flowsDir = path.join(PROJECT_ROOT, ".argent", "flows");
  const file = path.join(flowsDir, `${name}.yaml`);
  await fs.mkdir(flowsDir, { recursive: true });
  await fs.writeFile(file, yaml, "utf8");
  return file;
}

afterEach(async () => {
  await fs.rm(PROJECT_ROOT, { recursive: true, force: true });
});

/** A gate step followed by a tap, so a green gate is visible as a second call. */
function gatedFlow(tool: string, args: string): string {
  return `executionPrerequisite: ""
steps:
  - tool: ${tool}
    args:
${args}
  - tool: gesture-tap
    args:
      udid: 00000000-0000-0000-0000-0000000000ab
      x: 0.5
      y: 0.5
`;
}

const NATIVE_ARGS = `      udid: 00000000-0000-0000-0000-0000000000ab
      bundleId: com.example.app`;

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a FlowRunResult, got a notice: ${r.notice}`);
  return r;
}

async function runGated(
  name: string,
  tool: string,
  args: string,
  result: unknown
): Promise<{ run: FlowRunResult; registry: Registry }> {
  const flowFile = await writeFlow(name, gatedFlow(tool, args));
  const registry = makeRegistry(async (id) => (id === tool ? result : { tapped: true }));
  const run = asRun(
    await createRunFlowTool(registry).execute(
      {},
      {
        name,
        project_root: PROJECT_ROOT,
        flow_file: flowFile,
        device: "00000000-0000-0000-0000-0000000000ab",
      }
    )
  );
  return { run, registry };
}

describe("a flow step whose native-devtools precheck blocked", () => {
  // All four, not just the pre-existing `restart_required`: `service_stale` and
  // `connect_pending` were added by the state derivation, so a flow written
  // against the older behaviour green-passes two more ways than before.
  it.each([
    ["restart_required", "com.example.app has no running process on this simulator."],
    ["service_stale", "Restarting the app cannot change that — restart the tool-server."],
    ["connect_pending", "It launched moments ago and is still connecting."],
    ["init_failed", "Native devtools failed to initialize for this udid after 3 attempts."],
  ])("fails the step and stops the run on %s", async (status, message) => {
    const { run, registry } = await runGated(status, "native-full-hierarchy", NATIVE_ARGS, {
      status,
      message,
    });

    // The gate ran; the trailing tap did NOT.
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
    const gate = run.steps[0];
    expect(gate.tool).toBe("native-full-hierarchy");
    expect(gate.status).toBe("fail");
    expect(gate.reason).toContain(status);
    // The message is the only field carrying the remedy — and for the two new
    // statuses, the only thing saying NOT to restart the app.
    expect(gate.reason).toContain(message);
    expect(gate.result).toEqual({ status, message });
    expect(run.steps[1].status).toBe("skip");
    expect(run.ok).toBe(false);
  });

  // `launch:` covers restart-app through runLaunch; the raw `tool:` spelling of
  // the same two sub-tools reached none of that guard.
  it.each(["restart-app", "launch-app"])(
    "fails a raw %s step that never launched",
    async (tool) => {
      const { run } = await runGated(
        tool,
        tool,
        `      udid: 00000000-0000-0000-0000-0000000000ab
      bundleId: com.example.app`,
        { status: "init_failed", message: "Native devtools failed to initialize.", attempts: 3 }
      );

      expect(run.steps[0].status).toBe("fail");
      expect(run.steps[0].reason).toContain("init_failed");
      expect(run.ok).toBe(false);
    }
  );

  it("passes the step when the tool did its work", async () => {
    const { run, registry } = await runGated("ok", "native-full-hierarchy", NATIVE_ARGS, {
      status: "ok",
      windows: [],
    });

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
    expect(run.steps.map((s) => s.status)).toEqual(["pass", "pass"]);
    expect(run.ok).toBe(true);
  });

  // The tool id is load-bearing: the four status strings are ordinary words, so
  // matching them on any result would fail a step for a tool that never runs
  // this precheck and happens to answer with one.
  it("leaves a tool outside the precheck set alone", async () => {
    const { run } = await runGated(
      "unrelated",
      "gesture-scroll",
      `      udid: 00000000-0000-0000-0000-0000000000ab
      direction: down`,
      { status: "restart_required", message: "not this tool's precheck" }
    );

    expect(run.steps[0].status).toBe("pass");
    expect(run.ok).toBe(true);
  });
});
