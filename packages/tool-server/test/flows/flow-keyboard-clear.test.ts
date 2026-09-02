import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, type Registry } from "@argent/registry";

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// The create-flow skill now prescribes a recorded `tool: keyboard {clear:true}`
// step ahead of a `type:`, and the flow reference documents the two Chromium
// failure codes as things an author will meet. Nothing in test/flows/ executed
// such a step or checked how those codes surface in a report, so the whole
// flow-layer half of the feature rested on the tool tests alone.

const ANDROID_DEVICE = "emulator-5554";
let tmpDir: string;

interface Call {
  id: string;
  args: Record<string, unknown>;
}

/** A registry whose `keyboard` answer is scripted per test. */
function mockRegistry(
  calls: Call[],
  keyboard: (args: Record<string, unknown>) => unknown
): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      calls.push({ id, args });
      if (id === "list-devices") return { devices: [] };
      if (id === "keyboard") return keyboard(args);
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({})),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-clear-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a recorded `keyboard { clear: true }` step", () => {
  it("runs as a raw tool step and passes the switch through unchanged", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ typed: "", keys: 200, cleared: true }));

    await writeFlow("replace-value", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "keyboard", args: { clear: true } },
        { kind: "tool", name: "keyboard", args: { text: "new value" } },
      ],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "replace-value", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tool:pass", "tool:pass"]);
    const keys = calls.filter((c) => c.id === "keyboard");
    // The udid is injected by the runner; everything else is verbatim. A runner
    // that dropped `clear` — or coerced it — would run the second step against a
    // field the first never emptied, appending to the old value.
    expect(keys.map((c) => c.args)).toEqual([
      { udid: ANDROID_DEVICE, clear: true },
      { udid: ANDROID_DEVICE, text: "new value" },
    ]);
  });

  it("fails the step, and the run, when the clear is refused", async () => {
    // The Chromium refusals are the ones an author meets: a focus tap that
    // drifted, or a field this clear cannot empty. A flow that reported `ok`
    // there would type the replacement into the retained value — which is the
    // data bug the whole feature exists to prevent.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, (args) => {
      if (args.clear === true) {
        throw new FailureError("nothing editable has keyboard focus (it is on <body>)", {
          error_code: FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS,
          failure_stage: "keyboard_clear_chromium",
          failure_area: "tool_server",
          error_kind: "validation",
        });
      }
      return { typed: String(args.text ?? ""), keys: 1 };
    });

    await writeFlow("clear-refused", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "keyboard", args: { clear: true } },
        { kind: "tool", name: "keyboard", args: { text: "new value" } },
      ],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "clear-refused", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    // "error", not "fail": the tool threw rather than reporting a false
    // assertion, and the runner keeps those apart so an author can tell a flow
    // that ran and disagreed from one that could not run.
    expect(result.steps[0]!.status).toBe("error");
    // The reason has to reach the report: "step 1 failed" alone does not tell an
    // author whether to move the tap or to stop using `clear` on that field.
    expect(JSON.stringify(result.steps[0])).toMatch(/nothing editable has keyboard focus/);
    // ...and the typing after it must NOT have run into the un-cleared field.
    expect(calls.filter((c) => c.id === "keyboard" && c.args.text !== undefined)).toEqual([]);
  });

  it("runs a tap / clear / type trio in the authored order", async () => {
    // What this pins is the RUNNER's ordering, not a fold: no folding logic
    // exists in the runner at all — the "a focus tap plus a raw
    // `tool: keyboard` becomes one `type:`" rule is an instruction to the
    // authoring agent, in argent-create-flow's live-authoring reference, and it
    // is that agent's job not to apply it across a `clear`.
    //
    // The ordering is worth its own case because this trio is the shape the
    // docs prescribe for replacing a value, and the clear is the step whose
    // outcome depends on the one before it: run before the tap it would refuse
    // on Chromium and, on iOS/Android, burst 200 delete keys into whatever the
    // app happens to focus.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ typed: "", keys: 200, cleared: true }));

    await writeFlow("tap-clear-type", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.5, y: 0.3 },
        { kind: "tool", name: "keyboard", args: { clear: true } },
        { kind: "tool", name: "keyboard", args: { text: "a@b.com" } },
      ],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "tap-clear-type", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.kind)).toEqual(["tap", "tool", "tool"]);
    // The tap comes first, so the clear has a field to land in.
    const order = calls
      .filter((c) => c.id === "gesture-tap" || c.id === "keyboard")
      .map((c) => c.id);
    expect(order).toEqual(["gesture-tap", "keyboard", "keyboard"]);
    // The `tap:` directive settles the tree first, and this registry serves no
    // tree at all — so the case runs out `SETTLE_TIMEOUT_MS` (3s) inside the
    // 5s default, leaving 40% headroom in a repo with a documented 5s-timeout
    // flake class under host load. Explicit budget, like the cases in
    // flow-gesture-settle.test.ts that also burn the settle on purpose.
  }, 15_000);
});
