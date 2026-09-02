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
    // Shaped like a real note: `mismatchNote` reports what was typed and what
    // the field holds, never an expected total (which would read as a loss
    // count) and never the field's contents.
    const note =
      "The typed text did NOT land in the focused field: 11 characters were typed and the field " +
      "now holds 3 in total.";
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
    expect(gate.reason).toContain("11 characters were typed and the field now holds 3 in total");
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
  // Vega, Android TV) plus an Android reading that concludes nothing — before or
  // after a repair — and failing on it would green-light nothing while breaking
  // all of those. What a repair does change is a read it BLOCKS: one that failed,
  // was truncated or found another field reports `false` once the field has been
  // backspaced and retyped, because the last measurement is then a failure.
  it("passes when verification is absent — not checked is not failed", async () => {
    const { run, registry } = await runGated("unchecked", {
      typed: "hello world",
      keys: 11,
    });

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
    expect(run.steps.map((s) => s.status)).toEqual(["pass", "pass"]);
    expect(run.ok).toBe(true);
  });

  // A pass is not the whole verdict, and this is the spelling the recorder
  // writes. Nothing renders a step's `result` — the CLI prints the step line and
  // the warning under it — so without this a repair that backspaced the field, or
  // a type nothing checked, is an unqualified green in a recorded flow.
  it("warns when a passing result carries the read-back's note", async () => {
    const note =
      "The typed text is in the field, but not from the first attempt: Android's key-event burst " +
      "did not deliver it, so 8 characters were deleted and the text was retyped in smaller chunks.";
    const { run } = await runGated("repaired", {
      typed: "hello world",
      keys: 11,
      verified: true,
      note,
    });

    expect(run.steps.map((s) => s.status)).toEqual(["pass", "pass"]);
    expect(run.steps[0].warning).toBe(note);
    expect(run.ok).toBe(true);
  });

  // The other spelling the keyboard description prescribes — typing a secret and
  // submitting it in one `run-sequence`. The note is a step deeper, and a gate
  // that only unwrapped the direct result would report this one green.
  it("warns when the note is on a keyboard step inside a run-sequence", async () => {
    const note =
      "The typed text was not verified against the screen: the focused field masks its input.";
    const flowFile = await writeFlow(
      "sequenced",
      `executionPrerequisite: ""
steps:
  - tool: run-sequence
    args:
      udid: 00000000-0000-0000-0000-0000000000ab
      steps:
        - tool: keyboard
          args:
            text: hunter2
`
    );
    const registry = makeRegistry(async () => ({
      completed: 1,
      total: 1,
      steps: [{ tool: "keyboard", result: { typed: "hunter2", keys: 7, note } }],
    }));

    const run = asRun(
      await createRunFlowTool(registry).execute(
        {},
        {
          name: "sequenced",
          project_root: PROJECT_ROOT,
          flow_file: flowFile,
          device: "00000000-0000-0000-0000-0000000000ab",
        }
      )
    );

    expect(run.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(run.steps[0].warning).toBe(note);
  });

  it("takes the note of the keyboard steps only, and says which step each is from", async () => {
    // `await-ui-element` returns a `note` of its own about a wait it decided
    // itself, and it is in run-sequence's allowed tools — read as a read-back
    // note it would report a typing problem that never happened. The two
    // keyboard notes are labelled because each one's advice is about its own
    // field, and the first here is the secret note that says NOT to read one back.
    const secret =
      "This call typed a resolved `{{secret:...}}` value, so do NOT `describe` this field.";
    const second = "The typed text was not verified against the screen: the read was truncated.";
    const flowFile = await writeFlow(
      "two-notes",
      `executionPrerequisite: ""
steps:
  - tool: run-sequence
    args:
      udid: 00000000-0000-0000-0000-0000000000ab
      steps:
        - tool: keyboard
          args:
            text: hunter2
`
    );
    const registry = makeRegistry(async () => ({
      completed: 3,
      total: 3,
      steps: [
        { tool: "keyboard", result: { typed: "hunter2", keys: 7, note: secret } },
        { tool: "await-ui-element", result: { success: true, note: "waited 0 ms" } },
        { tool: "keyboard", result: { typed: "next", keys: 4, note: second } },
      ],
    }));

    const run = asRun(
      await createRunFlowTool(registry).execute(
        {},
        {
          name: "two-notes",
          project_root: PROJECT_ROOT,
          flow_file: flowFile,
          device: "00000000-0000-0000-0000-0000000000ab",
        }
      )
    );

    expect(run.steps[0].warning).toBe(`step 1: ${secret} step 3: ${second}`);
    expect(run.steps[0].warning).not.toContain("waited 0 ms");
  });
});
