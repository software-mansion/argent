import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { __resetRecordingsForTesting } from "../../src/tools/flows/flow-utils";

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
  __resetRecordingsForTesting();
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

const invoked = (registry: Registry) => vi.mocked(registry.invokeTool).mock.calls.map(([id]) => id);

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
    const note = "11 characters were typed and the field holds 3 in total.";
    const { run, registry } = await runGated("unlanded", {
      typed: "hello world",
      keys: 11,
      verified: false,
      note,
    });

    expect(invoked(registry)).not.toContain("gesture-tap");
    const gate = run.steps[0];
    expect(gate.tool).toBe("keyboard");
    expect(gate.status).toBe("fail");
    expect(gate.reason).toBe(`typed text did not land: ${note}`);
    expect(run.steps[1].status).toBe("skip");
    expect(run.ok).toBe(false);
    // The same fields a passing raw step reports, plus `reason`.
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

    expect(invoked(registry)).toEqual(["keyboard", "gesture-tap"]);
    expect(run.steps.map((s) => s.status)).toEqual(["pass", "pass"]);
    expect(run.ok).toBe(true);
  });

  it("passes when verification is absent — not checked is not failed", async () => {
    const { run, registry } = await runGated("unchecked", {
      typed: "hello world",
      keys: 11,
    });

    expect(invoked(registry)).toEqual(["keyboard", "gesture-tap"]);
    expect(run.steps.map((s) => s.status)).toEqual(["pass", "pass"]);
    expect(run.ok).toBe(true);
  });
});

describe("recording a keyboard step", () => {
  async function record(name: string, result: unknown): Promise<string> {
    await flowStartRecordingTool.execute(
      {},
      { name, project_root: PROJECT_ROOT, executionPrerequisite: "" }
    );
    const registry = makeRegistry(async () => result);
    const { message } = await createFlowAddStepTool(registry).execute(
      {},
      {
        name,
        project_root: PROJECT_ROOT,
        command: "keyboard",
        args: JSON.stringify({ udid: "emulator-5554", text: "display" }),
      }
    );
    return message;
  }

  const finish = (name: string) =>
    flowFinishRecordingTool.execute({}, { name, project_root: PROJECT_ROOT });

  it("warns that a verified:false step fails at replay, and repeats it at finish", async () => {
    const message = await record("rec-unlanded", { typed: "display", keys: 7, verified: false });
    expect(message).toContain("the text did not land in the field");
    expect(message).toContain("FAILS and stops the run");

    const finished = await finish("rec-unlanded");
    expect(finished.message).toBe(
      'Finished recording "rec-unlanded" flow (1 steps) — 1 step recorded text that did not ' +
        "land; read `summary` before converting or replaying"
    );
    expect(finished.summary).toEqual([
      '1. tool: keyboard {"text":"display"}',
      `   warning: ${message.slice(message.indexOf("recorded, but"))}`,
    ]);
  });

  it.each([
    ["verified", { typed: "display", keys: 7, verified: true }],
    ["unchecked", { typed: "display", keys: 7 }],
  ])("does not warn on a %s step", async (name, result) => {
    expect(await record(`rec-${name}`, result)).toBe(`Step added to "rec-${name}" flow`);
    expect((await finish(`rec-${name}`)).message).toBe(
      `Finished recording "rec-${name}" flow (1 steps)`
    );
  });
});
