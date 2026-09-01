import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

/**
 * `keyboard` reports an Android typed-text read-back failure (`verified: false`,
 * see platforms/android-verify.ts) in its result instead of throwing, so a raw
 * `tool:` step whose text demonstrably did not land would read green without
 * this gate, and the run would submit a field holding the wrong value. Mirrors
 * flow-native-devtools-gate.test.ts and the flow `type` directive's own gate.
 */

const PROJECT_ROOT = nodePath.join(os.tmpdir(), `flow-kb-gate-tests-${process.pid}`);

function makeRegistry(invoke: (id: string, args: unknown) => Promise<unknown>) {
  return {
    invokeTool: vi.fn(invoke),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: string): Promise<string> {
  const flowsDir = nodePath.join(PROJECT_ROOT, ".argent", "flows");
  const file = nodePath.join(flowsDir, `${name}.yaml`);
  await fs.mkdir(flowsDir, { recursive: true });
  await fs.writeFile(file, yaml, "utf8");
  return file;
}

afterEach(async () => {
  await fs.rm(PROJECT_ROOT, { recursive: true, force: true });
});

/** A gated step followed by a tap, so a green gate is visible as a second call. */
function gatedFlow(): string {
  return `executionPrerequisite: ""
steps:
  - tool: keyboard
    args:
      udid: 00000000-0000-0000-0000-0000000000ab
      text: hello world
  - tool: gesture-tap
    args:
      udid: 00000000-0000-0000-0000-0000000000ab
      x: 0.5
      y: 0.5
`;
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a FlowRunResult, got a notice: ${r.notice}`);
  return r;
}

async function runGated(
  name: string,
  result: unknown
): Promise<{ run: FlowRunResult; registry: Registry }> {
  const flowFile = await writeFlow(name, gatedFlow());
  const registry = makeRegistry(async (id) => (id === "keyboard" ? result : { tapped: true }));
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

describe("a raw tool: keyboard step the read-back failed", () => {
  it("fails the step and stops the run", async () => {
    const note =
      "The typed text did NOT land in the focused field: it holds 3 characters where 11 were expected.";
    const { run, registry } = await runGated("unlanded", {
      typed: "hello world",
      keys: 11,
      verified: false,
      note,
    });

    // The gate ran; the trailing tap did NOT.
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
    const gate = run.steps[0];
    expect(gate.tool).toBe("keyboard");
    expect(gate.status).toBe("fail");
    expect(gate.reason).toContain("did not land");
    expect(gate.reason).toContain("holds 3 characters where 11 were expected");
    expect(run.steps[1].status).toBe("skip");
    expect(run.ok).toBe(false);
    // The fail branch echoes what a passing raw step echoes — the result, the
    // args it ran with and the output hint — so a report reader can see WHAT was
    // typed and what came back without re-running anything. Unasserted, the
    // branch could drop any of them and stay green.
    expect(gate.result).toEqual({ typed: "hello world", keys: 11, verified: false, note });
    expect(gate.args).toMatchObject({ text: "hello world" });
    const passing = (await runGated("unlanded-control", { typed: "hi", keys: 2 })).run.steps[0];
    expect(
      Object.keys(gate)
        .filter((k) => k !== "reason")
        .sort()
    ).toEqual(Object.keys(passing).sort());
  });

  it("passes when the read-back verified the text", async () => {
    const { run, registry } = await runGated("landed", {
      typed: "hello world",
      keys: 11,
      verified: true,
    });

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
    expect(run.steps.map((s) => s.status)).toEqual(["pass", "pass"]);
    expect(run.ok).toBe(true);
  });

  // Absent `verified` is every platform without a read-back (iOS, Chromium,
  // Vega, Android TV) plus every Android case that could not conclude — failing
  // on it would green-light nothing while breaking all of those.
  it("passes when verification is absent — not checked is not failed", async () => {
    const { run, registry } = await runGated("unchecked", {
      typed: "hello world",
      keys: 11,
    });

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
    expect(run.steps.map((s) => s.status)).toEqual(["pass", "pass"]);
    expect(run.ok).toBe(true);
  });
});
