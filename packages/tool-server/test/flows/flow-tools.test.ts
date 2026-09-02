import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolContext } from "@argent/registry";
import { ArtifactStore, Registry, zodObjectToJsonSchema } from "@argent/registry";

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import {
  flowFinishRecordingTool,
  summarizeStep,
} from "../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import {
  createRunFlowTool,
  resolveFlowSource,
  type FlowRunResult,
  type FlowPrerequisiteNotice,
} from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { createRunSequenceTool } from "../../src/tools/run-sequence";
import {
  __resetRecordingsForTesting,
  flowsDirFor,
  getRecordingSession,
  parseFlow,
  serializeFlow,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

/**
 * The flow as PERSISTED. The recorder deliberately no longer returns the whole
 * growing YAML per step (it was the single largest consumer of a session's
 * context), so the file on disk is the assertion surface.
 */
async function onDisk(name: string, root = tmpDir): Promise<string> {
  return fs.readFile(path.join(root, ".argent", "flows", `${name}.yaml`), "utf8");
}

// ── Helpers ──────────────────────────────────────────────────────────

function assertFlowRunResult(
  r: FlowRunResult | FlowPrerequisiteNotice
): asserts r is FlowRunResult {
  if (!("steps" in r)) {
    throw new Error(`expected FlowRunResult, got prerequisite notice: ${r.notice}`);
  }
}

let tmpDir: string;
// A second project root. Recordings are keyed by <project_root>/<name>, so it
// is what the cross-project cases address: same flow name, different project.
let otherDir: string;

function createMockRegistry(
  tools: Record<string, { result: unknown; outputHint?: string; throws?: boolean }> = {}
) {
  return {
    invokeTool: vi.fn(async (id: string) => {
      const entry = tools[id];
      if (!entry) throw new Error(`Tool "${id}" not found`);
      if (entry.throws) throw new Error(`Tool "${id}" failed`);
      return entry.result;
    }),
    getTool: vi.fn((id: string) => {
      const entry = tools[id];
      if (!entry) return undefined;
      return { outputHint: entry.outputHint };
    }),
  } as unknown as Registry;
}

async function readFlowFile(name: string, projectRoot: string = tmpDir): Promise<string> {
  return fs.readFile(path.join(projectRoot, ".argent", "flows", `${name}.yaml`), "utf8");
}

const PREREQ = "App on home screen";

// ── Setup / teardown ─────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-test-"));
  otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-test-other-"));
  __resetRecordingsForTesting();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(otherDir, { recursive: true, force: true });
});

// ── flow-start-recording ─────────────────────────────────────────────

describe("flow-start-recording", () => {
  it("creates the .argent/flows dir and a .yaml file with header", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "test-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    expect(result.message).toContain("test-flow");

    const content = await readFlowFile("test-flow");
    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe(PREREQ);
    expect(flow.steps).toEqual([]);
  });

  it("opens a recording addressable by name + project_root", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "my-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "my-flow", project_root: tmpDir, message: "test" }
    );
    expect(result.message).toContain("my-flow");
  });

  it("overwrites an existing flow file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, message: "line1" }
    );

    // Start again with same name — should reset
    await flowStartRecordingTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, executionPrerequisite: "Different prereq" }
    );
    const content = await readFlowFile("overwrite");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
    expect(flow.executionPrerequisite).toBe("Different prereq");
  });

  it("rejects a relative project_root", async () => {
    await expect(
      flowStartRecordingTool.execute(
        {},
        { name: "relative", project_root: "./not-absolute", executionPrerequisite: PREREQ }
      )
    ).rejects.toThrow("project_root must be an absolute path");
  });
});

// ── flow-start-recording edge cases ──────────────────────────────────

describe("flow-start-recording edge cases", () => {
  it("starting a differently-named flow leaves the earlier recording live", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "first-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "second-flow", project_root: tmpDir, executionPrerequisite: "Different" }
    );

    // A second recording abandons nothing, so there is no switch to report.
    expect(result.message).toContain("second-flow");
    expect(result.message).not.toContain("first-flow");
    expect(result.restarted).toBeUndefined();
    expect(result.discardedSteps).toBeUndefined();

    // Both recordings still take steps, each addressed by its own name.
    const secondEcho = await flowInsertEchoTool.execute(
      {},
      { name: "second-flow", project_root: tmpDir, message: "goes to second" }
    );
    expect(secondEcho.message).toContain("second-flow");
    const firstEcho = await flowInsertEchoTool.execute(
      {},
      { name: "first-flow", project_root: tmpDir, message: "goes to first" }
    );
    expect(firstEcho.message).toContain("first-flow");

    // …and each file ends up holding only its own steps.
    expect(parseFlow(await readFlowFile("first-flow")).steps).toEqual([
      { kind: "echo", message: "goes to first" },
    ]);
    expect(parseFlow(await readFlowFile("second-flow")).steps).toEqual([
      { kind: "echo", message: "goes to second" },
    ]);
  });

  it("keeps same-named recordings in different projects independent", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "shared-name", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "shared-name", project_root: otherDir, executionPrerequisite: PREREQ }
    );

    // Same name, other project — a different key, so nothing was restarted.
    expect(result.restarted).toBeUndefined();
    expect(result.discardedSteps).toBeUndefined();

    await flowInsertEchoTool.execute(
      {},
      { name: "shared-name", project_root: tmpDir, message: "in first project" }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "shared-name", project_root: otherDir, message: "in second project" }
    );

    expect(parseFlow(await readFlowFile("shared-name")).steps).toEqual([
      { kind: "echo", message: "in first project" },
    ]);
    expect(parseFlow(await readFlowFile("shared-name", otherDir)).steps).toEqual([
      { kind: "echo", message: "in second project" },
    ]);
  });

  it("restarting the same flow reports the discarded steps and resets the file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, message: "will be reset" }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, message: "also reset" }
    );

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, executionPrerequisite: "Updated prereq" }
    );

    expect(result.restarted).toBe(true);
    expect(result.discardedSteps).toBe(2);
    expect(result.message).toContain("same-flow");

    // The earlier take is gone from the file too, prerequisite included.
    const flow = parseFlow(await readFlowFile("same-flow"));
    expect(flow.steps).toEqual([]);
    expect(flow.executionPrerequisite).toBe("Updated prereq");

    // The restarted recording is the live one, and it starts from empty.
    const echo = await flowInsertEchoTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, message: "new take" }
    );
    expect(echo.stepCount).toBe(1);
    expect(parseFlow(await onDisk("same-flow")).steps).toEqual([
      { kind: "echo", message: "new take" },
    ]);
  });

  it("does not report a restart when the flow was not already recording", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "fresh-start", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    expect(result.restarted).toBeUndefined();
    expect(result.discardedSteps).toBeUndefined();
  });
});

// ── flow-add-echo ────────────────────────────────────────────────────

describe("flow-add-echo", () => {
  it("appends an echo entry to the flow file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "echo-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "echo-test", project_root: tmpDir, message: "Hello world" }
    );

    expect(result.message).toContain("echo-test");
    // The whole growing YAML is deliberately no longer echoed per step; the
    // file on disk is the assertion surface, and `flowFile` must be gone.
    expect(result).not.toHaveProperty("flowFile");
    // …and unlike flow-add-step, no `recorded` either. The asymmetry is
    // deliberate: an echo step is entirely the `message` the caller just
    // passed, so a rendered line would only quote their own input back, while
    // a recorded step can be REWRITTEN on the way in (a coordinate tap into a
    // selector, a restart-app into a launch) and needs a line saying what
    // actually landed. Asserted so the pair can't silently drift together.
    expect(result).not.toHaveProperty("recorded");
    // With `flowFile` gone, `savedTo` is the only field naming the destination,
    // so it has to be the real path — returning a bogus one used to pass the
    // whole suite. Pinned here and on flow-add-step, the two callers of
    // appendStepToFlow's host branch.
    expect(result.savedTo).toBe(path.join(flowsDirFor(tmpDir), "echo-test.yaml"));
    const flow = parseFlow(await onDisk("echo-test"));
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello world" }]);
  });

  it("appends multiple echo entries", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const first = await flowInsertEchoTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, message: "First" }
    );
    const second = await flowInsertEchoTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, message: "Second" }
    );

    // stepCount reflects the running total, not a constant — it is the only
    // per-step size signal now that the growing YAML is no longer returned.
    expect(first.stepCount).toBe(1);
    expect(second.stepCount).toBe(2);

    const flow = parseFlow(await onDisk("multi-echo"));
    expect(flow.steps).toEqual([
      { kind: "echo", message: "First" },
      { kind: "echo", message: "Second" },
    ]);
  });

  it("throws when that flow has no recording in progress", async () => {
    await expect(
      flowInsertEchoTool.execute(
        {},
        { name: "not-recording", project_root: tmpDir, message: "oops" }
      )
    ).rejects.toThrow("No active recording");
  });

  it("throws when the recording is open under a different project root", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "wrong-root", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    // Right name, wrong project — a different key, so no recording is found.
    const err = await flowInsertEchoTool
      .execute({}, { name: "wrong-root", project_root: otherDir, message: "oops" })
      .catch((e: unknown) => e as Error);

    expect(err.message).toContain("No active recording");
    // The error names the key that was asked for, and counts — without naming —
    // the recordings live under other roots, so a wrong project_root is
    // recognizable without disclosing another project's flows.
    expect(err.message).toContain(`No active recording for flow "wrong-root" in ${otherDir}`);
    expect(err.message).toContain("Active recordings: none in this project (plus 1 in other");
    expect(err.message).not.toContain(tmpDir);
  });
});

// ── flow-add-step ────────────────────────────────────────────────────

describe("flow-add-step", () => {
  it("executes the tool and records on success", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "step-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await tool.execute(
      {},
      {
        name: "step-test",
        project_root: tmpDir,
        command: "tap",
        args: '{"x":0.5,"y":0.3}',
      }
    );

    expect(result.toolResult).toEqual({ tapped: true });
    // The growing YAML is no longer returned per step; `flowFile` must be gone
    // from the add-step result too (the breaking change this PR pins).
    expect(result).not.toHaveProperty("flowFile");
    const flow = parseFlow(await onDisk("step-test"));
    expect(flow.steps).toEqual([{ kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } }]);
    expect(registry.invokeTool).toHaveBeenCalledWith("tap", {
      x: 0.5,
      y: 0.3,
    });
  });

  it("returns the appended step as the `recorded` line, carrying delayMs", async () => {
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "recorded-line", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await tool.execute(
      {},
      {
        name: "recorded-line",
        project_root: tmpDir,
        command: "tap",
        args: '{"x":0.5,"y":0.3}',
        delayMs: 500,
      }
    );

    // `recorded` is the author's only per-step view of the file now that the
    // whole YAML is no longer echoed, and it must spell the step exactly the
    // way flow-finish-recording's summary does — including the pre-step sleep.
    expect(result.stepCount).toBe(1);
    expect(result.recorded).toBe('1. tool: tap {"x":0.5,"y":0.3} (after 500ms)');
    expect(result.recorded).toBe(
      summarizeStep(parseFlow(await onDisk("recorded-line")).steps[0], 1)
    );
    // In host mode `savedTo` is the path the YAML actually landed at, and with
    // `flowFile` gone it is the only field naming it. See the add-echo case.
    expect(result.savedTo).toBe(path.join(flowsDirFor(tmpDir), "recorded-line.yaml"));
  });

  it("reports stepCount as a running total, numbering each recorded line with it", async () => {
    // Only flow-add-echo's running total was pinned; add-step's was asserted
    // only at the value 1, so hardcoding `stepCount: 1` in its return passed
    // the whole suite. stepCount is the recorder's only per-step size signal
    // now that the growing YAML is gone, and it doubles as the line number
    // `recorded` is rendered with — so drift here misnumbers both surfaces.
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "running-total", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const counts: number[] = [];
    for (const y of [0.1, 0.2, 0.3]) {
      const result = await tool.execute(
        {},
        {
          name: "running-total",
          project_root: tmpDir,
          command: "tap",
          args: JSON.stringify({ x: 0.5, y }),
        }
      );
      counts.push(result.stepCount);
      // The number `recorded` opens with IS the reported count, so the author
      // cannot be shown "3." while being told the flow holds one step.
      expect(result.recorded?.startsWith(`${result.stepCount}. `)).toBe(true);
    }

    expect(counts).toEqual([1, 2, 3]);
    // …and the total tracks the file, not just itself.
    expect(parseFlow(await onDisk("running-total")).steps).toHaveLength(3);
  });

  it("records a double-tap's clickCount as `times`, surfaced in the recorded line", async () => {
    // The clickCount→times rewrite (so a recorded double-tap replays as one,
    // not a single tap) only fires on a `gesture-tap` command, so the raw-tool
    // tests above never reach it. Selector capture can't resolve a device under
    // the mock, so the coordinates are kept — all this case needs to drive the
    // rewrite and confirm the ×N reaches the recorded line.
    const registry = createMockRegistry({ "gesture-tap": { result: { tapped: true } } });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "double-tap", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await tool.execute(
      {},
      {
        name: "double-tap",
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({
          udid: "00000000-0000-0000-0000-0000000000ab",
          x: 0.5,
          y: 0.3,
          clickCount: 2,
        }),
      }
    );

    const step = parseFlow(await onDisk("double-tap")).steps[0];
    expect(step).toEqual({ kind: "tap", x: 0.5, y: 0.3, times: 2 });
    expect(result.recorded).toBe("1. tap: (0.5, 0.3) ×2");
    expect(result.recorded).toBe(summarizeStep(step, 1));
  });

  it("finish-recording's summary carries the same delay/times spellings as `recorded`", async () => {
    // The per-step `recorded` lines are unit-covered above; this pins the OTHER
    // summarizeStep consumer — finish-recording's `summary` array — so the two
    // surfaces can't drift. It must render the pre-step delay and the tap count
    // exactly as the recorder echoed them per step.
    const registry = createMockRegistry({
      "screenshot": { result: { ok: true } },
      "gesture-tap": { result: { tapped: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "summary-labels", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const delayed = await tool.execute(
      {},
      {
        name: "summary-labels",
        project_root: tmpDir,
        command: "screenshot",
        args: "{}",
        delayMs: 250,
      }
    );
    const doubled = await tool.execute(
      {},
      {
        name: "summary-labels",
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({
          udid: "00000000-0000-0000-0000-0000000000ab",
          x: 0.5,
          y: 0.3,
          clickCount: 2,
        }),
      }
    );

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "summary-labels", project_root: tmpDir }
    );

    expect(finished.summary).toEqual([
      "1. tool: screenshot {} (after 250ms)",
      "2. tap: (0.5, 0.3) ×2",
    ]);
    // The finished summary and each step's `recorded` line are the same
    // spelling. This whole-array compare works only because neither step is an
    // `await-ui-element`, which adds a `warning:` line with no counterpart.
    expect(finished.summary).toEqual([delayed.recorded, doubled.recorded]);
  });

  it("propagates the request's telemetry attribution to the recorded sub-tool", async () => {
    const registry = createMockRegistry({ tap: { result: { ok: true } } });
    const tool = createFlowAddStepTool(registry);
    const release = vi.fn();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => release);
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await flowStartRecordingTool.execute(
      {},
      { name: "tele-step", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await tool.execute(
      {},
      { name: "tele-step", project_root: tmpDir, command: "tap", args: '{"x":0.5}' },
      ctx
    );

    expect(recordChildInvocation).toHaveBeenCalledOnce();
    const childId = recordChildInvocation.mock.calls[0]![0];
    // The sub-tool's own args reach the recorder so it can derive the platform.
    expect(recordChildInvocation).toHaveBeenCalledWith(childId, { x: 0.5 });
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "tap",
      { x: 0.5 },
      expect.objectContaining({ toolInvocationId: childId, recordChildInvocation })
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not record when tool fails", async () => {
    const registry = createMockRegistry({
      tap: { result: null, throws: true },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "fail-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        { name: "fail-test", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
      )
    ).rejects.toThrow('Tool "tap" failed');

    const content = await readFlowFile("fail-test");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });

  it("handles omitted args", async () => {
    const registry = createMockRegistry({
      screenshot: { result: { url: "http://..." } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "no-args", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await tool.execute({}, { name: "no-args", project_root: tmpDir, command: "screenshot" });

    const content = await readFlowFile("no-args");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([{ kind: "tool", name: "screenshot", args: {} }]);
    expect(registry.invokeTool).toHaveBeenCalledWith("screenshot", {});
  });

  it("throws when that flow has no recording in progress", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await expect(
      tool.execute(
        {},
        { name: "not-recording", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
      )
    ).rejects.toThrow("No active recording");
    // The step must not run either — the recording is resolved first.
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("records a restart-app as a portable launch step (device id dropped)", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true, bundleId: "com.acme.app" } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "launch-rewrite", project_root: tmpDir });
    const result = await tool.execute(
      {},
      {
        name: "launch-rewrite",
        project_root: tmpDir,
        command: "restart-app",
        args: '{"udid":"ABC","bundleId":"com.acme.app"}',
      }
    );

    // Ran live with the full args…
    expect(registry.invokeTool).toHaveBeenCalledWith("restart-app", {
      udid: "ABC",
      bundleId: "com.acme.app",
    });
    // …but recorded the launch directive, making this an e2e flow.
    const steps = parseFlow(await onDisk("launch-rewrite")).steps;
    expect(steps).toEqual([{ kind: "launch", app: "com.acme.app" }]);
    // The rewrite is invisible in the raw result (which echoes restart-app's
    // own output), so `recorded` is what tells the author a launch was stored
    // rather than the tool call they made.
    expect(result.recorded).toBe("1. launch: com.acme.app");
    expect(result.recorded).toBe(summarizeStep(steps[0], 1));
  });

  it("keeps a restart-app with extra args (e.g. activity) as a raw tool step", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "launch-activity", project_root: tmpDir });
    await tool.execute(
      {},
      {
        name: "launch-activity",
        project_root: tmpDir,
        command: "restart-app",
        args: '{"udid":"ABC","bundleId":"com.acme.app","activity":".Main"}',
      }
    );

    expect(parseFlow(await onDisk("launch-activity")).steps).toEqual([
      {
        kind: "tool",
        name: "restart-app",
        args: { bundleId: "com.acme.app", activity: ".Main" },
      },
    ]);
  });

  it("rejects a leading launch recorded into a prerequisite-bearing recording", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true } },
    });
    const tool = createFlowAddStepTool(registry);

    // A prerequisite documents a fragment; a leading launch would make it e2e —
    // contradictory, so the append must fail and record nothing.
    await flowStartRecordingTool.execute(
      {},
      { name: "contradiction", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        {
          name: "contradiction",
          project_root: tmpDir,
          command: "restart-app",
          args: '{"bundleId":"com.acme.app"}',
        }
      )
    ).rejects.toThrow(/must not declare executionPrerequisite/i);

    const flow = parseFlow(await readFlowFile("contradiction"));
    expect(flow.steps).toEqual([]);
  });

  async function writeSiblingFlow(name: string, yaml: string): Promise<void> {
    await fs.writeFile(path.join(tmpDir, ".argent", "flows", `${name}.yaml`), yaml, "utf8");
  }

  it("records a flow-execute of a sibling fragment as a run: directive", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-test", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-test",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({
          name: "login",
          project_root: tmpDir,
          device: "ABC",
          prerequisiteAcknowledged: true,
        }),
      }
    );

    // Ran the fragment live to set up state…
    expect(result.toolResult).toEqual({ ok: true, steps: [] });
    // …but recorded the portable composition directive, not the raw tool call.
    const steps = parseFlow(await onDisk("compose-test")).steps;
    expect(steps).toEqual([{ kind: "run", flow: "login.yaml" }]);
    // Same reason as the launch rewrite: `recorded` is the only place the
    // author sees that a `run:` went in instead of a raw flow-execute step.
    expect(result.recorded).toBe("1. run: login.yaml");
    expect(result.recorded).toBe(summarizeStep(steps[0], 1));
  });

  it("records a run: directive when the target is an e2e flow", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-e2e", project_root: tmpDir });
    await writeSiblingFlow("other-e2e", "steps:\n  - launch: com.acme.app\n  - echo: hi\n");

    await tool.execute(
      {},
      {
        name: "compose-e2e",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "other-e2e", project_root: tmpDir, device: "ABC" }),
      }
    );

    // e2e flows now compose via run: just like fragments — their launch runs inline.
    expect(parseFlow(await onDisk("compose-e2e")).steps).toEqual([
      { kind: "run", flow: "other-e2e.yaml" },
    ]);
  });

  it("records a clean run-sequence as an ordinary tool step", async () => {
    const registry = createMockRegistry({
      "run-sequence": {
        result: {
          completed: 2,
          total: 2,
          steps: [
            { tool: "gesture-tap", result: { tapped: true } },
            { tool: "keyboard", result: { typed: true } },
          ],
        },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-clean", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-clean",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            { tool: "gesture-tap", args: { x: 0.5, y: 0.3 } },
            { tool: "keyboard", args: { text: "hi" } },
          ],
        }),
      }
    );

    expect(result.message).toContain("Step added");
    expect(result.recorded).toBeDefined();
    expect(result.stepCount).toBe(1);
    const steps = parseFlow(await onDisk("sequence-clean")).steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "tool", name: "run-sequence" });
  });

  it("refuses a REAL run-sequence result, not just a hand-written one", async () => {
    const inner = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "gesture-tap") return { tapped: true, timestampMs: 1 };
        return { success: false, elapsed: 5000, note: "no element matched the selector" };
      }),
      getTool: vi.fn(() => ({})),
    } as unknown as Registry;
    const runSequence = createRunSequenceTool(inner);
    const registry = {
      invokeTool: vi.fn(async (id: string, args: unknown) =>
        id === "run-sequence"
          ? runSequence.execute({}, args as never)
          : Promise.reject(new Error(`Tool "${id}" not found`))
      ),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;

    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-real", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-real",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            { tool: "gesture-tap", args: { x: 0.5, y: 0.3 }, delayMs: 0 },
            {
              tool: "await-ui-element",
              args: { condition: "visible", selector: { text: "Home" } },
              delayMs: 0,
            },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.4 }, delayMs: 0 },
          ],
        }),
      }
    );

    expect(result.message).toContain("run-sequence stopped at await-ui-element after 1 of 3 steps");
    expect(result.message).toContain("await-ui-element condition not met");
    expect(result.message).toContain("step NOT recorded");
    expect(result.recorded).toBeUndefined();
    expect(parseFlow(await onDisk("sequence-real")).steps).toEqual([]);
    expect(inner.invokeTool).toHaveBeenCalledTimes(2);
  });

  it("reports the take, the file and the nested report alongside a refusal", async () => {
    const registry = createMockRegistry({
      "gesture-tap": { result: { tapped: true } },
      "run-sequence": {
        result: {
          completed: 1,
          total: 3,
          steps: [
            { tool: "gesture-tap", result: { tapped: true } },
            { tool: "keyboard", error: "keyboard failed: device went away" },
          ],
        },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-fields", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const recorded = await tool.execute(
      {},
      {
        name: "sequence-fields",
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: "ABC", x: 0.5, y: 0.3, delayMs: 1 }),
      }
    );
    expect(recorded.stepCount).toBe(1);

    const result = await tool.execute(
      {},
      {
        name: "sequence-fields",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            { tool: "gesture-tap", args: { x: 0.5, y: 0.3 } },
            { tool: "keyboard", args: { text: "hi" } },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.4 } },
          ],
        }),
      }
    );

    expect(result.recorded).toBeUndefined();
    expect(result.stepCount).toBe(1);
    expect(result.savedTo).toBe(path.join(tmpDir, ".argent", "flows", "sequence-fields.yaml"));
    expect(result.toolResult).toEqual({
      completed: 1,
      total: 3,
      steps: [
        { tool: "gesture-tap", result: { tapped: true } },
        { tool: "keyboard", error: "keyboard failed: device went away" },
      ],
    });
    expect(parseFlow(await onDisk("sequence-fields")).steps).toHaveLength(1);
  });

  it("does not record a run-sequence whose nested step failed", async () => {
    const registry = createMockRegistry({
      "run-sequence": {
        result: {
          completed: 1,
          total: 2,
          steps: [
            { tool: "gesture-tap", result: { tapped: true } },
            { tool: "await-ui-element", error: "await-ui-element condition not met: not seen" },
          ],
        },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-failed", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-failed",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            { tool: "gesture-tap", args: { x: 0.5, y: 0.3 } },
            {
              tool: "await-ui-element",
              args: { condition: "visible", selector: { text: "Home" } },
            },
          ],
        }),
      }
    );

    expect(result.message).toContain("run-sequence stopped at await-ui-element after 1 of 2 steps");
    expect(result.message).toContain("await-ui-element condition not met");
    expect(result.message).toContain("step NOT recorded");
    expect(result.message.startsWith("run-sequence stopped at")).toBe(true);
    expect(result.message).not.toContain("was cancelled");
    expect(result.message).toContain("Prior nested steps may already have changed the device");
    expect(result.message).toContain("state the recorded prefix leaves it in");
    expect(parseFlow(await onDisk("sequence-failed")).steps).toEqual([]);
  });

  it("still warns when the run-sequence failed on its FIRST nested step", async () => {
    const registry = createMockRegistry({
      "run-sequence": {
        result: {
          completed: 0,
          total: 2,
          steps: [{ tool: "keyboard", error: "keyboard failed: device went away mid-type" }],
        },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-failed-first", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-failed-first",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            { tool: "keyboard", args: { text: "hello" } },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.3 } },
          ],
        }),
      }
    );

    expect(result.message).toContain("run-sequence stopped at keyboard after 0 of 2 steps");
    expect(result.message).toContain("step NOT recorded");
    expect(result.message).toContain("Prior nested steps may already have");
    expect(parseFlow(await onDisk("sequence-failed-first")).steps).toEqual([]);
  });

  it("does not record a run-sequence cancelled after partial execution", async () => {
    const controller = new AbortController();
    const registry = {
      invokeTool: vi.fn(async () => {
        controller.abort();
        return {
          completed: 1,
          total: 2,
          steps: [{ tool: "gesture-tap", result: { tapped: true } }],
        };
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-cancelled", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-cancelled",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            { tool: "gesture-tap", args: { x: 0.5, y: 0.3 } },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.4 } },
          ],
        }),
      },
      { signal: controller.signal } as never
    );

    expect(result.message).toContain("run-sequence was aborted after 1 of 2 steps");
    expect(result.message.startsWith("run-sequence was aborted after 1 of 2 steps")).toBe(true);
    expect(result.message).toContain("step NOT recorded");
    expect(result.message).toContain("Prior nested steps may already have changed the device");
    expect(result.message).toContain("state the recorded prefix leaves it in");
    expect(parseFlow(await onDisk("sequence-cancelled")).steps).toEqual([]);
  });

  it("reports a cancel that landed INSIDE a nested step as a cancellation", async () => {
    const controller = new AbortController();
    const registry = {
      invokeTool: vi.fn(async () => {
        controller.abort();
        return {
          completed: 1,
          total: 3,
          steps: [
            { tool: "gesture-tap", result: { tapped: true } },
            { tool: "await-ui-element", error: "await-ui-element condition not met" },
          ],
        };
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-cancelled-in-step", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-cancelled-in-step",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            { tool: "gesture-tap", args: { x: 0.5, y: 0.3 } },
            {
              tool: "await-ui-element",
              args: { condition: "visible", selector: { text: "Home" } },
            },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.4 } },
          ],
        }),
      },
      { signal: controller.signal } as never
    );

    // The un-rewritten reason is the headline `nestedOrchestratorOutcome`
    // builds, so name it: the re-wording demotes it into the brackets rather
    // than dropping it, and only the leading clause tells the two apart.
    expect(result.message.startsWith("run-sequence was cancelled (")).toBe(true);
    expect(result.message).toContain("run-sequence stopped at await-ui-element after 1 of 3 steps");
    expect(result.message).toContain("step NOT recorded");
    expect(parseFlow(await onDisk("sequence-cancelled-in-step")).steps).toEqual([]);
  });

  it("reports a cancelled composed flow as a cancellation, not as ok: false", async () => {
    const registry = createMockRegistry({
      "flow-execute": {
        result: {
          flow: "login",
          device: "ABC",
          executionPrerequisite: "",
          ok: false,
          aborted: true,
          passed: 1,
          failed: 0,
          skipped: 1,
          errored: 0,
          steps: [
            { index: 0, kind: "tap", status: "pass" },
            { index: 1, kind: "tap", status: "skip", reason: "run aborted" },
          ],
        },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute({}, { name: "compose-cancelled", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-cancelled",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "login", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(result.message).toContain('flow "login" was aborted');
    expect(result.message.startsWith('flow "login" was aborted')).toBe(true);
    expect(result.message).not.toContain("failed:");
    expect(result.message).toContain("NOT recorded");
    expect(parseFlow(await onDisk("compose-cancelled")).steps).toEqual([]);
  });

  it("names the failing composed step even when the run was then cancelled", async () => {
    const registry = createMockRegistry({
      "flow-execute": {
        result: {
          flow: "login",
          device: "ABC",
          executionPrerequisite: "",
          ok: false,
          aborted: true,
          passed: 0,
          failed: 0,
          skipped: 1,
          errored: 1,
          steps: [
            {
              index: 0,
              kind: "tool",
              tool: "gesture-tap",
              status: "error",
              reason: "gesture-tap failed: device went away",
            },
            { index: 1, kind: "tap", status: "skip", reason: "run aborted" },
          ],
        },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "compose-cancelled-failure", project_root: tmpDir }
    );
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-cancelled-failure",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "login", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(result.message).toContain('flow "login" was aborted');
    expect(result.message).toContain("gesture-tap: gesture-tap failed: device went away");
    expect(result.message).toContain("NOT recorded");
    expect(parseFlow(await onDisk("compose-cancelled-failure")).steps).toEqual([]);
  });

  it("does not record run: when the composed flow failed, and names the failing step", async () => {
    const registry = createMockRegistry({
      "flow-execute": {
        result: {
          flow: "login",
          device: "ABC",
          executionPrerequisite: "",
          ok: false,
          passed: 1,
          failed: 1,
          skipped: 0,
          errored: 0,
          steps: [
            { index: 0, kind: "tap", status: "pass" },
            { index: 1, kind: "assert", status: "fail", reason: "Home not visible" },
          ],
        },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute({}, { name: "compose-failed", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-failed",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "login", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(result.message).toContain('flow "login" failed: 1 passed, 1 failed, 0 errored');
    expect(result.message).toContain("assert: Home not visible");
    expect(result.message).toContain("NOT recorded");
    expect(result.message.startsWith('flow "login" failed:')).toBe(true);
    expect(result.message).not.toContain("was cancelled");
    expect(result.message).toContain("Prior composed steps may already have changed the device");
    expect(result.message).toContain("state the recorded prefix leaves it in");
    expect(parseFlow(await onDisk("compose-failed")).steps).toEqual([]);
  });

  it("advises a check rather than a restore when the composed flow was read-only", async () => {
    const registry = createMockRegistry({
      "flow-execute": {
        result: {
          flow: "checks",
          device: "ABC",
          executionPrerequisite: "",
          ok: false,
          passed: 1,
          failed: 1,
          skipped: 0,
          errored: 0,
          steps: [
            { index: 0, kind: "assert", status: "pass" },
            { index: 1, kind: "assert", status: "fail", reason: "Home not visible" },
          ],
        },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute({}, { name: "compose-readonly", project_root: tmpDir });
    await writeSiblingFlow("checks", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-readonly",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "checks", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(result.message).toContain("Check the device against the state the recorded prefix");
    expect(result.message).toContain("relaunching the app does NOT reproduce that prefix");
  });

  it("still warns when the composed flow failed with NO step passing", async () => {
    const registry = createMockRegistry({
      "flow-execute": {
        result: {
          flow: "login",
          device: "ABC",
          executionPrerequisite: "",
          ok: false,
          passed: 0,
          failed: 1,
          skipped: 0,
          errored: 0,
          steps: [
            {
              index: 0,
              kind: "scroll-to",
              status: "fail",
              reason: 'scroll-to never found "NoSuchTargetZZZ"',
            },
          ],
        },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "compose-failed-first", project_root: tmpDir }
    );
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-failed-first",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "login", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(result.message).toContain("NOT recorded");
    expect(result.message).toContain("Prior composed steps may already have");
    expect(parseFlow(await onDisk("compose-failed-first")).steps).toEqual([]);
  });

  it("warns on a failed composed flow whose result carries no step list", async () => {
    const registry = createMockRegistry({ "flow-execute": { result: { ok: false } } });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute({}, { name: "compose-shapeless", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-shapeless",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "login", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(result.message).toContain("NOT recorded");
    expect(result.message).toContain("Prior composed steps may already have");
    expect(parseFlow(await onDisk("compose-shapeless")).steps).toEqual([]);
  });

  it("stays silent when every composed step was skipped", async () => {
    const registry = createMockRegistry({
      "flow-execute": {
        result: {
          flow: "login",
          device: "ABC",
          executionPrerequisite: "",
          ok: false,
          aborted: true,
          passed: 0,
          failed: 0,
          skipped: 2,
          errored: 0,
          steps: [
            { index: 0, kind: "tap", status: "skip", reason: "run aborted" },
            { index: 1, kind: "tap", status: "skip", reason: "run aborted" },
          ],
        },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute({}, { name: "compose-all-skipped", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-all-skipped",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "login", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(result.message).toContain("NOT recorded");
    expect(result.message).not.toContain("may already have");
    expect(parseFlow(await onDisk("compose-all-skipped")).steps).toEqual([]);
  });

  it("warns when a composed step was cut short after it had already acted", async () => {
    const registry = createMockRegistry({
      "flow-execute": {
        result: {
          flow: "login",
          device: "ABC",
          executionPrerequisite: "",
          ok: false,
          aborted: true,
          passed: 0,
          failed: 0,
          skipped: 2,
          errored: 0,
          steps: [
            { index: 0, kind: "launch", status: "skip", reason: "run aborted", reached: true },
            { index: 1, kind: "tap", status: "skip", reason: "run aborted" },
          ],
        },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute({}, { name: "compose-cut-short", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-cut-short",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "login", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(result.message).toContain("NOT recorded");
    expect(result.message).toContain("Prior composed steps may already have");
    expect(parseFlow(await onDisk("compose-cut-short")).steps).toEqual([]);
  });

  it("omits the mutation warning only when no nested step was reached", async () => {
    const controller = new AbortController();
    const registry = {
      invokeTool: vi.fn(async () => {
        controller.abort();
        return { completed: 0, total: 2, steps: [] };
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-untouched", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-untouched",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            { tool: "gesture-tap", args: { x: 0.5, y: 0.3 } },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.4 } },
          ],
        }),
      },
      { signal: controller.signal } as never
    );

    expect(result.message).toContain("step NOT recorded");
    expect(result.message).not.toContain("may already have");
    expect(parseFlow(await onDisk("sequence-untouched")).steps).toEqual([]);
  });

  it("stays silent when run-sequence rejected its first step before dispatching it", async () => {
    const inner = { invokeTool: vi.fn(), getTool: vi.fn(() => undefined) } as unknown as Registry;
    const runSequence = createRunSequenceTool(inner);
    const registry = {
      invokeTool: vi.fn(async (id: string, args: unknown) =>
        id === "run-sequence"
          ? runSequence.execute({}, args as never)
          : Promise.reject(new Error(`Tool "${id}" not found`))
      ),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;

    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-rejected", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-rejected",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            { tool: "screenshot", args: {}, delayMs: 0 },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.3 }, delayMs: 0 },
          ],
        }),
      }
    );

    expect(result.message).toContain("run-sequence stopped at screenshot after 0 of 2 steps");
    expect(result.message).toContain("step NOT recorded");
    expect(result.message).not.toContain("may already have");
    expect(inner.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await onDisk("sequence-rejected")).steps).toEqual([]);
  });

  it("stays silent when run-sequence's first step failed its schema check", async () => {
    const inner = new Registry();
    const executed: string[] = [];
    inner.registerTool({
      id: "gesture-tap",
      description: "test double for gesture-tap",
      zodSchema: z.object({ udid: z.string(), x: z.number(), y: z.number() }),
      services: () => ({}),
      execute: async () => {
        executed.push("gesture-tap");
        return { tapped: true };
      },
    } as never);
    const runSequence = createRunSequenceTool(inner);
    const registry = {
      invokeTool: vi.fn(async (id: string, args: unknown) =>
        id === "run-sequence"
          ? runSequence.execute({}, args as never)
          : Promise.reject(new Error(`Tool "${id}" not found`))
      ),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;

    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-bad-args", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-bad-args",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            { tool: "gesture-tap", args: { xx: 0.5, y: 0.3 }, delayMs: 0 },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.4 }, delayMs: 0 },
          ],
        }),
      }
    );

    expect(result.message).toContain("step NOT recorded");
    expect(result.message).not.toContain("may already have");
    expect(executed).toEqual([]);
    expect(parseFlow(await onDisk("sequence-bad-args")).steps).toEqual([]);
  });

  it("stays silent when run-sequence's first step was a wait that never held", async () => {
    const inner = {
      invokeTool: vi.fn(async (id: string) =>
        id === "await-ui-element" ? { success: false, elapsed: 5000, note: "not seen" } : { ok: 1 }
      ),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const runSequence = createRunSequenceTool(inner);
    const registry = {
      invokeTool: vi.fn(async (id: string, args: unknown) =>
        id === "run-sequence"
          ? runSequence.execute({}, args as never)
          : Promise.reject(new Error(`Tool "${id}" not found`))
      ),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;

    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-wait-first", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-wait-first",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            {
              tool: "await-ui-element",
              args: { condition: "visible", selector: { text: "Home" } },
              delayMs: 0,
            },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.3 }, delayMs: 0 },
          ],
        }),
      }
    );

    expect(result.message).toContain("run-sequence stopped at await-ui-element after 0 of 2 steps");
    expect(result.message).toContain("step NOT recorded");
    expect(result.message).not.toContain("may already have");
    expect(inner.invokeTool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(inner.invokeTool).mock.calls[0]![0]).toBe("await-ui-element");
    expect(parseFlow(await onDisk("sequence-wait-first")).steps).toEqual([]);
  });

  it("stays silent when the only step run-sequence completed was a wait that HELD", async () => {
    const inner = {
      invokeTool: vi.fn(async (id: string) =>
        id === "await-ui-element" ? { success: true, elapsed: 12 } : { ok: 1 }
      ),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const runSequence = createRunSequenceTool(inner);
    const registry = {
      invokeTool: vi.fn(async (id: string, args: unknown) =>
        id === "run-sequence"
          ? runSequence.execute({}, args as never)
          : Promise.reject(new Error(`Tool "${id}" not found`))
      ),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;

    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-wait-held", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-wait-held",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            {
              tool: "await-ui-element",
              args: { condition: "visible", selector: { text: "Home" } },
              delayMs: 0,
            },
            { tool: "screenshot", args: {}, delayMs: 0 },
          ],
        }),
      }
    );

    // Same device reality as the unmet twin above: the wait polled and the
    // second step was rejected before dispatch, so nothing moved.
    expect(result.message).toContain("run-sequence stopped at screenshot after 1 of 2 steps");
    expect(result.message).toContain("step NOT recorded");
    expect(result.message).not.toContain("may already have");
    expect(vi.mocked(inner.invokeTool).mock.calls.map((c) => c[0])).toEqual(["await-ui-element"]);
    expect(parseFlow(await onDisk("sequence-wait-held")).steps).toEqual([]);
  });

  it("still warns when a rejected step follows one that DID run", async () => {
    const inner = {
      invokeTool: vi.fn(async () => ({ tapped: true })),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const runSequence = createRunSequenceTool(inner);
    const registry = {
      invokeTool: vi.fn(async (id: string, args: unknown) =>
        id === "run-sequence"
          ? runSequence.execute({}, args as never)
          : Promise.reject(new Error(`Tool "${id}" not found`))
      ),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;

    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-rejected-late", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-rejected-late",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [
            { tool: "gesture-tap", args: { x: 0.5, y: 0.3 }, delayMs: 0 },
            { tool: "screenshot", args: {}, delayMs: 0 },
          ],
        }),
      }
    );

    expect(result.message).toContain("run-sequence stopped at screenshot after 1 of 2 steps");
    expect(result.message).toContain("Prior nested steps may already have changed the device");
    expect(inner.invokeTool).toHaveBeenCalledTimes(1);
    expect(parseFlow(await onDisk("sequence-rejected-late")).steps).toEqual([]);
  });

  it("records a run-sequence whose cancel landed in the trailing delay", async () => {
    const controller = new AbortController();
    const dispatched: string[] = [];
    const inner = {
      invokeTool: vi.fn(async (id: string) => {
        dispatched.push(id);
        setTimeout(() => controller.abort(), 5);
        return { tapped: true };
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const runSequence = createRunSequenceTool(inner);
    const registry = {
      invokeTool: vi.fn(async (id: string, args: unknown, opts?: unknown) =>
        id === "run-sequence"
          ? runSequence.execute({}, args as never, opts as never)
          : Promise.reject(new Error(`Tool "${id}" not found`))
      ),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;

    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-late-cancel", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-late-cancel",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: "ABC",
          steps: [{ tool: "gesture-tap", args: { x: 0.5, y: 0.3 }, delayMs: 60 }],
        }),
      },
      { signal: controller.signal } as never
    );

    expect(dispatched).toEqual(["gesture-tap"]);
    expect(controller.signal.aborted).toBe(true);
    expect(result.recorded).toBeDefined();
    expect(result.message).not.toContain("NOT recorded");
    expect(parseFlow(await onDisk("sequence-late-cancel")).steps).toHaveLength(1);
  });

  it("refuses a composed flow whose cancel landed after its last step passed", async () => {
    const controller = new AbortController();
    const dispatched: string[] = [];
    const runnerRegistry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "list-devices") return { devices: [] };
        dispatched.push(id);
        controller.abort();
        return { tapped: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
    const runFlow = createRunFlowTool(runnerRegistry);
    const registry = {
      invokeTool: vi.fn(async (id: string, args: unknown, opts?: unknown) =>
        id === "flow-execute"
          ? runFlow.execute({}, args as never, opts as never)
          : Promise.reject(new Error(`Tool "${id}" not found`))
      ),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;

    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute({}, { name: "compose-late-cancel", project_root: tmpDir });
    await writeSiblingFlow(
      "frag-pass",
      [
        'executionPrerequisite: ""',
        "steps:",
        "  - tool: gesture-tap",
        "    args: { x: 0.5, y: 0.3 }",
        "",
      ].join("\n")
    );

    const result = await tool.execute(
      {},
      {
        name: "compose-late-cancel",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({
          name: "frag-pass",
          project_root: tmpDir,
          device: "00000000-0000-0000-0000-0000000000ab",
        }),
      },
      { signal: controller.signal } as never
    );

    expect(dispatched).toEqual(["gesture-tap"]);
    const nested = result.toolResult as { ok: boolean; aborted?: boolean; passed: number };
    expect(nested).toMatchObject({ ok: false, aborted: true, passed: 1 });
    expect(result.recorded).toBeUndefined();
    expect(result.message).toContain("step NOT recorded");
    expect(parseFlow(await onDisk("compose-late-cancel")).steps).toEqual([]);
  });

  it("warns when a cancelled composed sequence had already dispatched", async () => {
    const controller = new AbortController();
    const dispatched: string[] = [];
    const inner = {
      invokeTool: vi.fn(async (id: string) => {
        dispatched.push(id);
        controller.abort();
        return { swiped: true };
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const runnerRegistry = new Registry();
    runnerRegistry.registerTool(createRunSequenceTool(inner) as never);
    const runFlow = createRunFlowTool(runnerRegistry);
    const registry = {
      invokeTool: vi.fn(async (id: string, args: unknown, opts?: unknown) =>
        id === "flow-execute"
          ? runFlow.execute({}, args as never, opts as never)
          : Promise.reject(new Error(`Tool "${id}" not found`))
      ),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;

    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute({}, { name: "compose-cancelled", project_root: tmpDir });
    await writeSiblingFlow(
      "frag-seq",
      [
        'executionPrerequisite: ""',
        "steps:",
        "  - tool: run-sequence",
        "    args:",
        "      steps:",
        "        - tool: gesture-swipe",
        "          args: { fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2 }",
        "          delayMs: 0",
        "        - tool: gesture-swipe",
        "          args: { fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2 }",
        "          delayMs: 0",
        "",
      ].join("\n")
    );

    const result = await tool.execute(
      {},
      {
        name: "compose-cancelled",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({
          name: "frag-seq",
          project_root: tmpDir,
          device: "00000000-0000-0000-0000-0000000000ab",
        }),
      },
      { signal: controller.signal } as never
    );

    expect(dispatched).toEqual(["gesture-swipe"]);
    expect(result.message).toContain("step NOT recorded");
    expect(result.message).toContain("Prior composed steps may already have changed the device");
    expect(result.recorded).toBeUndefined();
    expect(parseFlow(await onDisk("compose-cancelled")).steps).toEqual([]);
  });

  it("stays silent when the cancelled composed flow had only WAITED", async () => {
    const controller = new AbortController();
    const invoked: string[] = [];
    const runnerRegistry = {
      invokeTool: vi.fn(async (id: string) => {
        invoked.push(id);
        controller.abort();
        return {
          success: false,
          elapsed: 12,
          note: "wait was cancelled before the condition was met",
          cause: "cancelled",
        };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
    const runFlow = createRunFlowTool(runnerRegistry);
    const registry = {
      invokeTool: vi.fn(async (id: string, args: unknown, opts?: unknown) =>
        id === "flow-execute"
          ? runFlow.execute({}, args as never, opts as never)
          : Promise.reject(new Error(`Tool "${id}" not found`))
      ),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;

    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute({}, { name: "compose-wait-only", project_root: tmpDir });
    await writeSiblingFlow(
      "frag-wait",
      [
        'executionPrerequisite: ""',
        "steps:",
        "  - tool: await-ui-element",
        "    args: { condition: visible, selector: { text: Continue } }",
        "",
      ].join("\n")
    );

    const result = await tool.execute(
      {},
      {
        name: "compose-wait-only",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({
          name: "frag-wait",
          project_root: tmpDir,
          device: "00000000-0000-0000-0000-0000000000ab",
        }),
      },
      { signal: controller.signal } as never
    );

    // The composed run polled the tree and called no device tool, so there is
    // no prefix to check the device against - unlike the dispatching twin above.
    expect(invoked).toEqual(["await-ui-element"]);
    expect(result.message).toContain("step NOT recorded");
    expect(result.message).not.toContain("may already have");
    expect(result.recorded).toBeUndefined();
    expect(parseFlow(await onDisk("compose-wait-only")).steps).toEqual([]);
  });

  it("does not record run: when flow-execute returned a prerequisite notice", async () => {
    const registry = createMockRegistry({
      "flow-execute": {
        result: {
          flow: "login",
          notice: "This flow has an execution prerequisite",
          executionPrerequisite: "On login screen",
        },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute({}, { name: "compose-notice", project_root: tmpDir });
    await writeSiblingFlow(
      "login",
      "executionPrerequisite: On login screen\nsteps:\n  - echo: hi\n"
    );

    const result = await tool.execute(
      {},
      {
        name: "compose-notice",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "login", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(result.message).toContain('flow "login" did not run');
    expect(result.message).toContain("On login screen");
    expect(result.message).toContain("prerequisiteAcknowledged: true");
    expect(result.message).toContain("NOT recorded");
    expect(result.message).not.toContain("may already have");
    expect(result.message.startsWith('flow "login" did not run')).toBe(true);
    expect(parseFlow(await onDisk("compose-notice")).steps).toEqual([]);
  });

  it("does not call a prerequisite notice a cancellation when a cancel is in play", async () => {
    const controller = new AbortController();
    const registry = {
      invokeTool: vi.fn(async () => {
        controller.abort();
        return {
          flow: "login",
          notice: "This flow has an execution prerequisite",
          executionPrerequisite: "On login screen",
        };
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "compose-notice-cancelled", project_root: tmpDir }
    );
    await writeSiblingFlow(
      "login",
      "executionPrerequisite: On login screen\nsteps:\n  - echo: hi\n"
    );

    const result = await tool.execute(
      {},
      {
        name: "compose-notice-cancelled",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "login", project_root: tmpDir, device: "ABC" }),
      },
      { signal: controller.signal } as never
    );

    expect(result.message.startsWith('flow "login" did not run')).toBe(true);
    expect(result.message).not.toContain("was cancelled");
    expect(result.message).toContain("On login screen");
    expect(result.message).toContain("NOT recorded");
    expect(result.message).not.toContain("may already have");
    expect(parseFlow(await onDisk("compose-notice-cancelled")).steps).toEqual([]);
  });

  it("keeps the raw flow-execute step when the target is not a sibling", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-missing", project_root: tmpDir });

    const result = await tool.execute(
      {},
      {
        name: "compose-missing",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "elsewhere", project_root: tmpDir }),
      }
    );

    expect(result.message).toMatch(/could not resolve/i);
    expect(parseFlow(await onDisk("compose-missing")).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "elsewhere", project_root: tmpDir } },
    ]);
  });

  it("strips the device id from a raw flow-execute step (issue #607)", async () => {
    // Deliberately a target that is NOT a resolvable sibling: a resolvable one
    // records as `run:`, which carries no args at all and so could never show
    // this. The raw fallback is the form that kept the record-time device id and
    // pinned every replay to it.
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-pinned", project_root: tmpDir });

    await tool.execute(
      {},
      {
        name: "compose-pinned",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "elsewhere", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(parseFlow(await onDisk("compose-pinned")).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "elsewhere", project_root: tmpDir } },
    ]);
  });

  it("keeps the raw flow-execute step when another project_root resolves the name", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-twin", project_root: tmpDir });
    // Two projects, each holding a different flow named "twin". The nested call
    // named the OTHER project's root, so that is the copy that ran live — while
    // a `run: twin` step resolves beside the recording at replay. Recording one
    // would swap the flow under the same name, both runs green and nothing said.
    await writeSiblingFlow("twin", "steps:\n  - echo: mine\n");
    const otherRoot = path.join(tmpDir, "other-project");
    const otherTwin = path.join(otherRoot, ".argent", "flows", "twin.yaml");
    await fs.mkdir(path.dirname(otherTwin), { recursive: true });
    await fs.writeFile(otherTwin, "steps:\n  - echo: theirs\n", "utf8");

    const args = { name: "twin", project_root: otherRoot };
    const result = await tool.execute(
      {},
      {
        name: "compose-twin",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify(args),
      }
    );

    // The live invoke ran the other project's copy…
    expect(registry.invokeTool).toHaveBeenCalledWith("flow-execute", args);
    // …so the recorded step must be the raw call that reproduces it — naming
    // both files, since either one alone reads as the flow the author meant.
    // Both anchors are canonicalized before the comparison (the recording's
    // real file on one side, the executed path on the other), so the message
    // quotes the realpath'd spellings — on macOS tmpdir lives behind the
    // /var → /private/var symlink, which these paths carry as written.
    expect(result.message).toContain(await fs.realpath(otherTwin));
    expect(result.message).toContain(
      await fs.realpath(path.join(tmpDir, ".argent", "flows", "twin.yaml"))
    );
    expect(result.message).toMatch(/would replay a different flow/);
    expect(parseFlow(await onDisk("compose-twin")).steps).toEqual([
      { kind: "tool", name: "flow-execute", args },
    ]);
  });

  // The two casing cases below decide off the flows dir LISTING, which returns
  // stored bytes on every platform, so they hold identically on case-sensitive
  // (Linux CI) and case-insensitive (APFS, NTFS) filesystems — where before the
  // gate the recorder read the case-folded file and baked its phantom spelling
  // into the committed YAML. The mock registry stands in for a flow-execute
  // that accepted the name; the real one refuses this spelling itself (see
  // "saved-flow name spelling"), so these pin the recorder's own guarantee
  // about the YAML it writes rather than borrowing that tool's.
  it("keeps the raw flow-execute step for a name the flows dir would case-fold", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-name-casing", project_root: tmpDir });
    await writeSiblingFlow("frag", "steps:\n  - echo: hi\n");

    const args = { name: "Frag", project_root: tmpDir };
    const result = await tool.execute(
      {},
      {
        name: "compose-name-casing",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify(args),
      }
    );

    // `run: Frag` names a flow no case-sensitive checkout can find, so the raw
    // step is kept and the warning hands back the recordable spelling.
    expect(result.message).toContain('case-insensitively to "frag.yaml"');
    expect(result.message).toContain('re-run it as name "frag" to record it');
    expect(parseFlow(await onDisk("compose-name-casing")).steps).toEqual([
      { kind: "tool", name: "flow-execute", args },
    ]);
  });

  it("suggests a rename when the on-disk sibling's own extension case is unnameable", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-name-rename", project_root: tmpDir });
    // frag.YAML is reachable by no name at all — this route always builds
    // "<name>.yaml" — so the only honest recovery is the rename.
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "frag.YAML"),
      "steps:\n  - echo: hi\n",
      "utf8"
    );

    const args = { name: "frag", project_root: tmpDir };
    const result = await tool.execute(
      {},
      {
        name: "compose-name-rename",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify(args),
      }
    );

    expect(result.message).toContain('case-insensitively to "frag.YAML"');
    expect(result.message).toContain(
      'rename "frag.YAML" to "frag.yaml" to record it — flow files must be lowercase .yaml'
    );
    expect(result.message).not.toContain("re-run it as name");
    expect(parseFlow(await onDisk("compose-name-rename")).steps).toEqual([
      { kind: "tool", name: "flow-execute", args },
    ]);
  });

  it("composes a sibling saved under a mixed-case name under that exact name", async () => {
    // Byte-for-byte is the contract — not lowercasing: a sibling really saved
    // as MixedCase.yaml composes as `run: MixedCase`.
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-name-mixed", project_root: tmpDir });
    await writeSiblingFlow("MixedCase", "steps:\n  - echo: hi\n");

    await tool.execute(
      {},
      {
        name: "compose-name-mixed",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "MixedCase", project_root: tmpDir }),
      }
    );

    expect(parseFlow(await onDisk("compose-name-mixed")).steps).toEqual([
      { kind: "run", flow: "MixedCase.yaml" },
    ]);
  });

  // A root the recorder cannot anchor is not a root it can check the name
  // against, so it declines to compose rather than compose on an unverified
  // identity. flow-execute's schema requires project_root and its resolver
  // demands an absolute one, so only a direct execute() caller reaches this —
  // and the relative case mocks the server's cwd to make the root name the
  // sibling, the one shape a cwd-anchored comparison would let through.
  it.each<[string, string | undefined, string]>([
    ["is missing", undefined, "(got none)"],
    ["is relative", ".", '(got ".")'],
  ])("keeps the raw flow-execute step when project_root %s", async (_shape, root, detail) => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-unanchored", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const args = root === undefined ? { name: "login" } : { name: "login", project_root: root };
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    try {
      if (root !== undefined) {
        expect(path.resolve(flowsDirFor(root), "login.yaml")).toBe(
          path.join(tmpDir, ".argent", "flows", "login.yaml")
        );
      }
      const result = await tool.execute(
        {},
        {
          name: "compose-unanchored",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify(args),
        }
      );

      expect(result.message).toContain(`project_root must be an absolute path ${detail}`);
      expect(parseFlow(await onDisk("compose-unanchored")).steps).toEqual([
        { kind: "tool", name: "flow-execute", args },
      ]);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  // The runner resolves a recorded `run:` against the CANONICAL containing
  // file's directory (scopeFlowDir in flow-run.ts), so when the recording is
  // itself a symlink the recorder must validate the sibling beside the real
  // file — AND confirm it is the same file the live sub-invoke executed from
  // the flows-dir spelling. The three tests below pin the accept, reject, and
  // divergence directions of those anchors. The base
  // is realpath'd so the only spelling/real divergence is the test's own
  // symlink: macOS's tmpdir lives behind the /var → /private/var symlink,
  // which would otherwise make every path here diverge from its canonical
  // form for reasons unrelated to what's being tested.
  async function symlinkedRecordingSetup(): Promise<{ base: string; vault: string }> {
    const base = await fs.realpath(tmpDir);
    const vault = path.join(base, "vault");
    const flowsDir = path.join(base, ".argent", "flows");
    await fs.mkdir(vault, { recursive: true });
    await fs.mkdir(flowsDir, { recursive: true });
    // The real file must exist before the recording starts: flow-start-recording
    // writes THROUGH .argent/flows/rec.yaml, which is a symlink into vault/.
    await fs.writeFile(path.join(vault, "rec.yaml"), "steps: []\n", "utf8");
    await fs.symlink(path.join(vault, "rec.yaml"), path.join(flowsDir, "rec.yaml"));
    return { base, vault };
  }

  it("validates the run: sibling beside a symlinked recording's real file", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    const { base, vault } = await symlinkedRecordingSetup();
    // The fragment's real file lives in vault/, beside the recording's real
    // file, with the flows dir carrying a symlink to it — the same vault
    // layout the recording itself models. The live sub-invoke resolves the
    // flows-dir spelling (getFlowPath under project_root) and the runner's
    // canonical anchor (scopeFlowDir in flow-run.ts) resolves the vault file;
    // both canonicalize to this one file, so the composition is sound. Vault
    // only would leave the flows-dir path — the one the live sub-invoke reads
    // — nonexistent, a layout the shipped path cannot produce.
    await fs.writeFile(path.join(vault, "frag.yaml"), "steps:\n  - echo: hi\n", "utf8");
    await fs.symlink(
      path.join(vault, "frag.yaml"),
      path.join(base, ".argent", "flows", "frag.yaml")
    );
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: base });

    const result = await tool.execute(
      {},
      {
        name: "rec",
        project_root: base,
        command: "flow-execute",
        args: JSON.stringify({ name: "frag", project_root: base }),
      }
    );

    // Anchored beside the symlink's spelling this would miss the fragment and
    // demote a perfectly replayable composition to a raw tool step.
    expect(result.message).not.toMatch(/could not resolve/i);
    expect(parseFlow(await onDisk("rec", base)).steps).toEqual([
      { kind: "run", flow: "frag.yaml" },
    ]);
  });

  it("keeps the raw step when the sibling exists only beside the symlink's spelling", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    const { base } = await symlinkedRecordingSetup();
    // A decoy beside the symlink's SPELLING only — replay resolves `run:`
    // beside the real file, where nothing exists, so recording this as `run:`
    // would report success for a step that cannot replay.
    await fs.writeFile(
      path.join(base, ".argent", "flows", "frag.yaml"),
      "steps:\n  - echo: decoy\n",
      "utf8"
    );
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: base });

    const result = await tool.execute(
      {},
      {
        name: "rec",
        project_root: base,
        command: "flow-execute",
        args: JSON.stringify({ name: "frag", project_root: base }),
      }
    );

    expect(result.message).toMatch(/could not resolve/i);
    expect(parseFlow(await onDisk("rec", base)).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "frag", project_root: base } },
    ]);
  });

  it("keeps the raw step when the flows-dir file and the real-file sibling diverge", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    const { base, vault } = await symlinkedRecordingSetup();
    // frag.yaml exists at BOTH spellings as two DIFFERENT real files. The live
    // sub-invoke runs the flows-dir one (getFlowPath under project_root); a
    // recorded `run:` would replay the vault one (scopeFlowDir in flow-run.ts
    // anchors at the canonical containing dir). Recording `run:` here would
    // report success for a step naming a flow that never ran — the raw step,
    // which replays via name + project_root, is the only honest record.
    await fs.writeFile(
      path.join(base, ".argent", "flows", "frag.yaml"),
      "steps:\n  - echo: decoy\n",
      "utf8"
    );
    await fs.writeFile(path.join(vault, "frag.yaml"), "steps:\n  - echo: real\n", "utf8");
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: base });

    const result = await tool.execute(
      {},
      {
        name: "rec",
        project_root: base,
        command: "flow-execute",
        args: JSON.stringify({ name: "frag", project_root: base }),
      }
    );

    expect(result.message).toMatch(/not the file the live flow-execute ran/i);
    expect(parseFlow(await onDisk("rec", base)).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "frag", project_root: base } },
    ]);
  });

  it("records a flow-execute of a sibling flow_path as a run: directive", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-path", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
    const sibling = path.join(tmpDir, ".argent", "flows", "login.yaml");

    await tool.execute(
      {},
      {
        name: "compose-path",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ flow_path: sibling, project_root: tmpDir }),
      }
    );

    expect(parseFlow(await onDisk("compose-path")).steps).toEqual([
      { kind: "run", flow: "login.yaml" },
    ]);
    // The live sub-invoke gets no file-input boundary, so it must run the
    // sibling by name…
    const nested = (registry.invokeTool as any).mock.calls[0][1];
    expect(nested).toEqual({ name: "login", project_root: tmpDir });
    // …which a real tool-server resolves to that same file.
    expect(await resolveFlowSource(nested)).toEqual({
      filePath: sibling,
      flowName: "login",
      viaUpload: false,
    });
  });

  it("names the flow_path the author wrote when the rewritten call is rejected", async () => {
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry) as never);
    const tool = createFlowAddStepTool(registry);
    registry.registerTool(tool as never);

    await flowStartRecordingTool.execute({}, { name: "reframe", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
    const sibling = path.join(tmpDir, ".argent", "flows", "login.yaml");

    const authored = await tool
      .execute(
        {},
        {
          name: "reframe",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({ flow_path: sibling, project_root: tmpDir, platform: "iOS" }),
        }
      )
      .then(() => undefined)
      .catch((err: unknown) => (err as Error).message);

    expect(authored).toContain("`platform`");
    expect(authored).toContain("You sent: `flow_path`, `project_root`, `platform`.");
    expect(authored).not.toContain("`name`");

    const byName = await tool
      .execute(
        {},
        {
          name: "reframe",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({ name: "login", project_root: tmpDir, platform: "iOS" }),
        }
      )
      .then(() => undefined)
      .catch((err: unknown) => (err as Error).message);

    expect(byName).toContain("You sent: `name`, `project_root`, `platform`.");

    expect(parseFlow(await onDisk("reframe")).steps).toEqual([]);
  });

  it("rejects a mis-cased sibling flow_path, naming the on-disk spelling", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-casing", project_root: tmpDir });
    await writeSiblingFlow("sibling", "steps:\n  - echo: hi\n");

    // Every lexical check accepts "Sibling.yaml", and a case-insensitive
    // filesystem would open sibling.yaml for it — so before the readdir gate
    // the recorder baked `run: Sibling` into committed YAML, a name no
    // case-sensitive checkout can resolve. The gate compares against the
    // directory LISTING, which returns stored bytes on every platform, so this
    // rejects deterministically on both filesystem flavors.
    const err = await tool
      .execute(
        {},
        {
          name: "compose-casing",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "Sibling.yaml"),
            project_root: tmpDir,
          }),
        }
      )
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    // The refusal must name the phantom spelling, the real directory entry,
    // and hand back the recordable on-disk basename.
    expect(err?.message).toContain("Cannot record a flow-execute of flow_path");
    expect(err?.message).toContain('case-insensitively to "sibling.yaml"');
    expect(err?.message).toContain('pass flow_path with the on-disk basename "sibling.yaml"');
    // Rejected before the live sub-invoke and the append: nothing ran, nothing recorded.
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-casing")).steps).toEqual([]);
  });

  it("suggests a rename when the on-disk sibling's own extension case is unrecordable", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-rename", project_root: tmpDir });
    // The sibling's REAL name trips the lowercase-extension arm, so the
    // message must ask for a rename, not point at a flow_path this same
    // ladder refuses.
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "frag.YAML"),
      "steps:\n  - echo: hi\n",
      "utf8"
    );

    const err = await tool
      .execute(
        {},
        {
          name: "compose-rename",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "frag.yaml"),
            project_root: tmpDir,
          }),
        }
      )
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    expect(err?.message).toContain('case-insensitively to "frag.YAML"');
    expect(err?.message).toContain(
      'rename "frag.YAML" to "frag.yaml" to record it — flow files must be lowercase .yaml'
    );
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-rename")).steps).toEqual([]);
  });

  it("rejects a flow_path outside the recording's flow directory without running it", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-outside", project_root: tmpDir });
    const outside = path.join(tmpDir, "elsewhere.yaml");
    await fs.writeFile(outside, "steps:\n  - echo: hi\n", "utf8");

    await expect(
      tool.execute(
        {},
        {
          name: "compose-outside",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({ flow_path: outside, project_root: tmpDir }),
        }
      )
    ).rejects.toThrow(/not in the recording's flow directory/i);

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-outside")).steps).toEqual([]);
  });

  it('rejects a sibling flow_path containing a ".." segment without running it', async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-dotdot", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
    // Assembled by hand — path.join would collapse the "..". Every resolve-based
    // check downstream accepts this string: it folds back to the sibling
    // login.yaml lexically, but a symlinked "sub" would make the kernel open a
    // different file than the rewritten name runs.
    const dotdot = [tmpDir, ".argent", "flows", "sub", "..", "login.yaml"].join(path.sep);

    await expect(
      tool.execute(
        {},
        {
          name: "compose-dotdot",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({ flow_path: dotdot, project_root: tmpDir }),
        }
      )
    ).rejects.toThrow(/must not contain "\.\." segments/);

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-dotdot")).steps).toEqual([]);
  });

  // The flows dir already supplies the CLI's "dir/" shape, so these vary the
  // basename: path.extname reads each as an extensionless dotfile, and the
  // extension arm would claim ".yaml" is missing from a path that ends in it.
  it.each([[".yaml"], [".YAML"], [".Yaml"]])(
    "names the missing stem, not the extension, for a sibling named %s",
    async (basename) => {
      const registry = createMockRegistry({
        "flow-execute": { result: { ok: true, steps: [] } },
      });
      const tool = createFlowAddStepTool(registry);

      await flowStartRecordingTool.execute({}, { name: "compose-stemless", project_root: tmpDir });
      const stemless = path.join(tmpDir, ".argent", "flows", basename);

      const record = () =>
        tool.execute(
          {},
          {
            name: "compose-stemless",
            project_root: tmpDir,
            command: "flow-execute",
            args: JSON.stringify({ flow_path: stemless, project_root: tmpDir }),
          }
        );
      await expect(record()).rejects.toThrow('Invalid flow name ""');
      await expect(record()).rejects.not.toThrow(/must use the (lowercase )?\.yaml extension/);

      expect(registry.invokeTool).not.toHaveBeenCalled();
      expect(parseFlow(await readFlowFile("compose-stemless")).steps).toEqual([]);
    }
  );

  it("still blames the extension when a sibling's stem carries the wrong case", async () => {
    // The companion to the case above: extname is non-empty here, so this input
    // must keep reaching the lowercase-extension arm.
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-cased", project_root: tmpDir });

    await expect(
      tool.execute(
        {},
        {
          name: "compose-cased",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "Login.YAML"),
            project_root: tmpDir,
          }),
        }
      )
    ).rejects.toThrow('flow files must use the lowercase .yaml extension, not ".YAML"');

    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("rejects a sibling flow_path that the call's project_root does not resolve to", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-mismatch", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    await expect(
      tool.execute(
        {},
        {
          name: "compose-mismatch",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "login.yaml"),
            project_root: path.join(tmpDir, "other-project"),
          }),
        }
      )
    ).rejects.toThrow(/does not resolve "login" to it/);

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-mismatch")).steps).toEqual([]);
  });

  // path.resolve anchors a relative project_root at the tool SERVER's cwd — a
  // directory with no relationship to the calling agent's — so a resolve-based
  // comparison would accept or reject the same call depending on where the
  // server was started. Pin the deterministic contract: a relative root is
  // refused outright, EVEN when it would resolve the sibling correctly against
  // this very process's cwd (the one shape a cwd-anchored comparison would let
  // through). Each case mocks the cwd to make the root line up with tmpDir.
  it.each([
    ['"."', (dir: string) => ({ root: ".", cwd: dir })],
    [
      "a bare directory name",
      (dir: string) => ({ root: path.basename(dir), cwd: path.dirname(dir) }),
    ],
  ])(
    "rejects a relative project_root (%s) even when it resolves against the server's cwd",
    async (_shape, build) => {
      const registry = createMockRegistry({
        "flow-execute": { result: { ok: true, steps: [] } },
      });
      const tool = createFlowAddStepTool(registry);

      await flowStartRecordingTool.execute({}, { name: "compose-relative", project_root: tmpDir });
      await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
      const sibling = path.join(tmpDir, ".argent", "flows", "login.yaml");

      const { root, cwd } = build(tmpDir);
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
      try {
        // Sanity: under this cwd the relative root DOES name the sibling, so a
        // cwd-anchored comparison would have accepted the call.
        expect(path.resolve(flowsDirFor(root), "login.yaml")).toBe(sibling);

        await expect(
          tool.execute(
            {},
            {
              name: "compose-relative",
              project_root: tmpDir,
              command: "flow-execute",
              args: JSON.stringify({ flow_path: sibling, project_root: root }),
            }
          )
        ).rejects.toThrow(/project_root must be an absolute path/);
      } finally {
        cwdSpy.mockRestore();
      }

      // Rejected before the rewrite and the live sub-invoke: the args were
      // never forwarded (mutated or otherwise) and nothing was recorded.
      expect(registry.invokeTool).not.toHaveBeenCalled();
      expect(parseFlow(await readFlowFile("compose-relative")).steps).toEqual([]);
    }
  );

  it("names the absolute-path requirement when project_root is missing", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-rootless", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    await expect(
      tool.execute(
        {},
        {
          name: "compose-rootless",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "login.yaml"),
          }),
        }
      )
    ).rejects.toThrow(/project_root must be an absolute path \(got none\)/);

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-rootless")).steps).toEqual([]);
  });

  // The two shapes add-step must NOT rewrite: naming both sources, or neither,
  // is flow-execute's schema to judge. The both-sources case is the dangerous
  // one — rewriting it would delete flow_path and overwrite the caller's name
  // with the stem, so a call asking for "checkout" would run and record "login"
  // with nothing to say the requested name was discarded.
  it.each([
    [
      "names both sources",
      (sibling: string, root: string) => ({
        name: "checkout",
        flow_path: sibling,
        project_root: root,
      }),
    ],
    ["names neither source", (_sibling: string, root: string) => ({ project_root: root })],
  ])("hands a flow-execute that %s to flow-execute verbatim", async (_shape, buildArgs) => {
    // flow-execute refuses both shapes on the source count, so the sub-invoke
    // fails and nothing is recorded; the throwing mock stands in for that.
    const registry = createMockRegistry({ "flow-execute": { result: null, throws: true } });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-ambiguous", project_root: tmpDir });
    // For the both-sources shape, a genuinely rewritable target: every check
    // downstream of the bail-out accepts this flow_path, so the bail-out is the
    // only thing standing between the caller's "checkout" and a swap to "login".
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
    const args = buildArgs(path.join(tmpDir, ".argent", "flows", "login.yaml"), tmpDir);

    await expect(
      tool.execute(
        {},
        {
          name: "compose-ambiguous",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify(args),
        }
      )
    ).rejects.toThrow();

    // The nested call must reach flow-execute exactly as written — no flow_path
    // deleted, no name substituted…
    expect(registry.invokeTool).toHaveBeenCalledWith("flow-execute", args);
    // …so that a real tool-server is the one that rejects it.
    const nested = (registry.invokeTool as any).mock.calls[0][1];
    await expect(resolveFlowSource(nested)).rejects.toThrow("Pass exactly one flow source");
    expect(parseFlow(await readFlowFile("compose-ambiguous")).steps).toEqual([]);
  });

  it("throws on invalid JSON in args", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "bad-json", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        { name: "bad-json", project_root: tmpDir, command: "tap", args: "not valid json {{{" }
      )
    ).rejects.toThrow();

    // Flow file should remain unchanged (no step recorded)
    const content = await readFlowFile("bad-json");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });

  it("keeps the devices list when recording a scoped teardown, so the YAML stays scoped", async () => {
    // `devices` is a scope, not a target: with it stripped, a correctly scoped
    // teardown recorded as a bare `- tool: stop-all-simulator-servers`, which
    // IS the machine-wide sweep — so hand-running the step from the YAML (the
    // create-flow skill's manual-execution strategy) reaped every device on the
    // machine. Replay rebinds the scope to the run device regardless, so
    // keeping it costs portability nothing.
    const registry = createMockRegistry({
      "stop-all-simulator-servers": { result: { stopped: 1 } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "teardown-test", project_root: tmpDir });
    await tool.execute(
      {},
      {
        name: "teardown-test",
        project_root: tmpDir,
        command: "stop-all-simulator-servers",
        args: JSON.stringify({ devices: ["00000000-HOST-DEVICE-ID"] }),
      }
    );

    // Ran live with the real devices to stop…
    expect(registry.invokeTool).toHaveBeenCalledWith("stop-all-simulator-servers", {
      devices: ["00000000-HOST-DEVICE-ID"],
    });
    // …and the recorded step still reads as the scoped teardown it was.
    expect(parseFlow(await onDisk("teardown-test")).steps).toEqual([
      {
        kind: "tool",
        name: "stop-all-simulator-servers",
        args: { devices: ["00000000-HOST-DEVICE-ID"] },
      },
    ]);
  });

  it("propagates error when tool is not registered in the registry", async () => {
    const registry = createMockRegistry({}); // no tools registered
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "missing-tool", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        { name: "missing-tool", project_root: tmpDir, command: "nonexistent-tool", args: "{}" }
      )
    ).rejects.toThrow('Tool "nonexistent-tool" not found');

    // Flow file should remain unchanged
    const content = await readFlowFile("missing-tool");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });
});

// ── flow-finish-recording ────────────────────────────────────────────

describe("flow-finish-recording", () => {
  it("returns summary with prerequisite and clears that recording", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir, message: "Step 1" }
    );

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir }
    );

    expect(result.message).toContain("finish-test");
    expect(result.executionPrerequisite).toBe(PREREQ);
    expect(result.steps).toBe(1);
    expect(result.summary).toEqual(["1. echo: Step 1"]);

    // The recording is gone — no more steps can be added to it.
    await expect(
      flowInsertEchoTool.execute(
        {},
        { name: "finish-test", project_root: tmpDir, message: "after finish" }
      )
    ).rejects.toThrow("No active recording");
  });

  it("leaves other recordings in progress untouched", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "finish-one", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowStartRecordingTool.execute(
      {},
      { name: "keep-going", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    await flowFinishRecordingTool.execute({}, { name: "finish-one", project_root: tmpDir });

    const result = await flowInsertEchoTool.execute(
      {},
      { name: "keep-going", project_root: tmpDir, message: "still open" }
    );
    expect(result.message).toContain("keep-going");
    expect(parseFlow(await readFlowFile("keep-going")).steps).toEqual([
      { kind: "echo", message: "still open" },
    ]);
  });

  it("throws when that flow has no recording in progress", async () => {
    await expect(
      flowFinishRecordingTool.execute({}, { name: "not-recording", project_root: tmpDir })
    ).rejects.toThrow("No active recording");
  });

  it("handles empty flow", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "empty", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "empty", project_root: tmpDir }
    );

    expect(result.steps).toBe(0);
    expect(result.summary).toEqual([]);
  });

  it("calling finish twice throws on the second call", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "double-finish", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowFinishRecordingTool.execute({}, { name: "double-finish", project_root: tmpDir });

    // Second call should fail — the recording was cleared
    await expect(
      flowFinishRecordingTool.execute({}, { name: "double-finish", project_root: tmpDir })
    ).rejects.toThrow("No active recording");
  });

  it("returns the file path so the agent knows where it was written", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "path-check", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "path-check", project_root: tmpDir }
    );

    expect(result.path).toContain(path.join(".argent", "flows"));
    expect(result.path).toContain("path-check.yaml");
  });

  it("summary includes both echo and tool steps", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const addStep = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "summary-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "summary-test", project_root: tmpDir, message: "Before tap" }
    );
    await addStep.execute(
      {},
      { name: "summary-test", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
    );

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "summary-test", project_root: tmpDir }
    );
    expect(result.summary).toEqual(["1. echo: Before tap", '2. tool: tap {"x":0.5}']);
  });

  // `idle` has no recorder command — it is written by hand into the YAML,
  // which the finish re-reads. Without a case here it fell through to the
  // `tool:` default and the summary described the step as a tool call.
  it("summarizes a hand-written idle step as the wait it is", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "idle-summary", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "idle-summary.yaml"),
      `executionPrerequisite: ${JSON.stringify(PREREQ)}\nsteps:\n  - await: { idle: true }\n`,
      "utf8"
    );

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "idle-summary", project_root: tmpDir }
    );

    expect(result.summary).toEqual(["1. await: screen idle"]);
  });

  it("uses file-facing target labels in gesture summaries", async () => {
    const name = "gesture-target-summary";
    await flowStartRecordingTool.execute(
      {},
      { name, project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", `${name}.yaml`),
      serializeFlow({
        executionPrerequisite: PREREQ,
        steps: [
          {
            kind: "tap",
            selector: { text: "Tap me" },
          },
          {
            kind: "long-press",
            x: 0.25,
            y: 0.75,
          },
          {
            kind: "swipe",
            from: { selector: { text: "Card", loose: true } },
            direction: "left",
          },
          {
            kind: "swipe",
            from: { x: 0.1, y: 0.2 },
            to: { selector: { identifier: "destination" } },
          },
        ],
      })
    );

    const result = await flowFinishRecordingTool.execute({}, { name, project_root: tmpDir });

    expect(result.summary).toEqual([
      '1. tap: {"text":"Tap me"}',
      "2. long-press: (0.25, 0.75)",
      '3. swipe: left from "Card"',
      '4. swipe: to {"id":"destination"} from (0.1, 0.2)',
    ]);
  });

  it("renders swipe options and by-deltas so distinct gestures stay distinguishable", async () => {
    const name = "swipe-options-summary";
    await flowStartRecordingTool.execute(
      {},
      { name, project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    // Raw YAML on purpose: `momentum: true` is normalized to absent by the
    // parser, so step 2 IS a plain `swipe: left` and must render without noise.
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", `${name}.yaml`),
      [
        `executionPrerequisite: ${PREREQ}`,
        "steps:",
        "  - swipe: { direction: left, momentum: false }",
        "  - swipe: { direction: left, momentum: true }",
        "  - swipe: { direction: left, duration: 800 }",
        "  - swipe: { by: { x: -0.31 } }",
        "  - swipe: { direction: left, momentum: false, duration: 800 }",
        "",
      ].join("\n")
    );

    const result = await flowFinishRecordingTool.execute({}, { name, project_root: tmpDir });

    // `by` spelled exactly as the run report's stepTarget spells it.
    expect(result.summary).toEqual([
      "1. swipe: left (momentum-free)",
      "2. swipe: left",
      "3. swipe: left (800ms)",
      "4. swipe: by x=-0.31",
      "5. swipe: left (momentum-free, 800ms)",
    ]);
  });

  it("distinguishes contains, equals, and regex text comparisons in the summary", async () => {
    const name = "text-comparison-summary";
    await flowStartRecordingTool.execute(
      {},
      { name, project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", `${name}.yaml`),
      serializeFlow({
        executionPrerequisite: PREREQ,
        steps: [
          {
            kind: "await",
            condition: "text",
            selector: { identifier: "status" },
            expectedText: 'Ready "now"\nnext',
            textMatch: "contains",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "status" },
            expectedText: "Ready",
            textMatch: "equals",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "total" },
            expectedText: "^Total: \\$\\d+\\.\\d{2}$",
            textMatch: "matches",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "legacy-status" },
            expectedText: "Still running",
          },
        ],
      })
    );

    const result = await flowFinishRecordingTool.execute({}, { name, project_root: tmpDir });

    expect(result.summary).toEqual([
      '1. await: text {"id":"status"} contains "Ready \\"now\\"\\nnext"',
      '2. assert: text {"id":"status"} == "Ready"',
      '3. assert: text {"id":"total"} matches /^Total: \\$\\d+\\.\\d{2}$/',
      '4. assert: text {"id":"legacy-status"} contains "Still running"',
    ]);
  });

  it("renders when text guards with the same comparator spelling as await/assert", async () => {
    const name = "when-text-guard-summary";
    await flowStartRecordingTool.execute(
      {},
      { name, project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const guarded: FlowStep[] = [{ kind: "echo", message: "guarded" }];
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", `${name}.yaml`),
      serializeFlow({
        executionPrerequisite: PREREQ,
        steps: [
          {
            kind: "when",
            condition: {
              kind: "ui",
              condition: "text",
              selector: { identifier: "status" },
              expectedText: 'Ready "now"\nnext',
              textMatch: "contains",
            },
            steps: guarded,
          },
          {
            kind: "when",
            condition: {
              kind: "ui",
              condition: "text",
              selector: { identifier: "status" },
              expectedText: "Ready",
              textMatch: "equals",
            },
            steps: guarded,
          },
          {
            kind: "when",
            condition: {
              kind: "ui",
              condition: "text",
              selector: { identifier: "total" },
              expectedText: "^Total: \\$\\d+\\.\\d{2}$",
              textMatch: "matches",
            },
            steps: [...guarded, { kind: "echo", message: "and again" }],
          },
        ],
      })
    );

    const result = await flowFinishRecordingTool.execute({}, { name, project_root: tmpDir });

    expect(result.summary).toEqual([
      '1. when: text {"id":"status"} contains "Ready \\"now\\"\\nnext" (1 step)',
      '2. when: text {"id":"status"} == "Ready" (1 step)',
      '3. when: text {"id":"total"} matches /^Total: \\$\\d+\\.\\d{2}$/ (2 steps)',
    ]);
  });
});

// ── flow-execute ─────────────────────────────────────────────────────

describe("flow-execute", () => {
  // An iOS-shaped id so resolveDevice classifies it without listing devices,
  // and the runner never shells out to a real status bar (no `expect` steps).
  const DEVICE = "00000000-0000-0000-0000-0000000000ab";

  it("executes all steps in order", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
      screenshot: {
        result: { url: "http://img", path: "/tmp/img.png" },
        outputHint: "image",
      },
    });
    const addStep = createFlowAddStepTool(registry);
    const runFlow = createRunFlowTool(registry);

    // Build a flow
    await flowStartRecordingTool.execute(
      {},
      { name: "run-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "run-test", project_root: tmpDir, message: "Tap button" }
    );
    await addStep.execute(
      {},
      { name: "run-test", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "run-test", project_root: tmpDir, message: "Take screenshot" }
    );
    await addStep.execute(
      {},
      { name: "run-test", project_root: tmpDir, command: "screenshot", args: "{}" }
    );
    await flowFinishRecordingTool.execute({}, { name: "run-test", project_root: tmpDir });

    // Reset mock call counts
    vi.mocked(registry.invokeTool).mockClear();

    // Run the flow
    const result = await runFlow.execute(
      {},
      { name: "run-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );
    assertFlowRunResult(result);

    expect(result.flow).toBe("run-test");
    expect(result.executionPrerequisite).toBe(PREREQ);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(4);

    // Echoes
    expect(result.steps[0]).toMatchObject({ kind: "echo", status: "pass", message: "Tap button" });
    expect(result.steps[2]).toMatchObject({
      kind: "echo",
      status: "pass",
      message: "Take screenshot",
    });

    // Tool calls
    expect(result.steps[1]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "tap",
      result: { tapped: true },
      args: { x: 0.5 },
    });
    expect(result.steps[3]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "screenshot",
      result: { url: "http://img", path: "/tmp/img.png" },
      outputHint: "image",
      args: {},
    });

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
  });

  it("propagates the request's telemetry attribution to each tool step", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
      swipe: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tele-run.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [
          { kind: "tool", name: "tap", args: { x: 0.5 } },
          { kind: "echo", message: "between" },
          { kind: "tool", name: "swipe", args: { direction: "up" } },
        ],
      })
    );

    const release = vi.fn();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => release);
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await runFlow.execute({}, { name: "tele-run", project_root: tmpDir, device: DEVICE }, ctx);

    // Only the two tool steps dispatch; the echo step records nothing.
    expect(recordChildInvocation).toHaveBeenCalledTimes(2);
    const ids = recordChildInvocation.mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(2);
    // Each step's own args reach the recorder so per-step platform can be derived.
    expect(recordChildInvocation).toHaveBeenNthCalledWith(1, ids[0], { x: 0.5 });
    expect(recordChildInvocation).toHaveBeenNthCalledWith(2, ids[1], { direction: "up" });
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      1,
      "tap",
      { x: 0.5 },
      expect.objectContaining({ toolInvocationId: ids[0], recordChildInvocation })
    );
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      2,
      "swipe",
      { direction: "up" },
      expect.objectContaining({ toolInvocationId: ids[1], recordChildInvocation })
    );
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("stops on first error", async () => {
    const registry = createMockRegistry({
      tap: { result: null, throws: true },
    });
    const runFlow = createRunFlowTool(registry);

    // Manually write a flow file in YAML format
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "echo", message: "Should not reach" },
      ],
    });
    await fs.writeFile(path.join(dir, "error-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "error-test", project_root: tmpDir, device: DEVICE }
    );
    assertFlowRunResult(result);

    // tap errors (recorded), the trailing echo is skipped.
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      status: "error",
      tool: "tap",
      reason: expect.stringContaining("failed"),
    });
    expect(result.steps[1]).toMatchObject({ kind: "echo", status: "skip" });
    expect(result.ok).toBe(false);
  });

  it("throws when flow file does not exist", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    await expect(
      runFlow.execute({}, { name: "nonexistent", project_root: tmpDir })
    ).rejects.toThrow();
  });

  it("carries outputHint from tool definition", async () => {
    const registry = createMockRegistry({
      screenshot: {
        result: { url: "http://img" },
        outputHint: "image",
      },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Ready",
      steps: [{ kind: "tool", name: "screenshot", args: { udid: "A" } }],
    });
    await fs.writeFile(path.join(dir, "hint-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "hint-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );
    assertFlowRunResult(result);

    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      outputHint: "image",
    });
  });

  it("returns executionPrerequisite from the flow file", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App freshly reloaded",
      steps: [{ kind: "echo", message: "Start" }],
    });
    await fs.writeFile(path.join(dir, "prereq-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "prereq-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );

    expect(result.executionPrerequisite).toBe("App freshly reloaded");
  });

  it("returns a notice when prerequisite exists but is not acknowledged", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Device unlocked",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "gated.yaml"), content);

    const result = await runFlow.execute({}, { name: "gated", project_root: tmpDir });

    expect(result).toMatchObject({
      flow: "gated",
      notice: expect.stringContaining("prerequisite"),
      executionPrerequisite: "Device unlocked",
    });
    // Should NOT have a steps array — it's a notice, not a run result
    expect(result).not.toHaveProperty("steps");
  });

  it("runs normally when prerequisite exists and is acknowledged", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Device unlocked",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5 } }],
    });
    await fs.writeFile(path.join(dir, "ack-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "ack-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toHaveLength(1);
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
  });

  it("runs normally when prerequisite is empty and not acknowledged", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5 } }],
    });
    await fs.writeFile(path.join(dir, "no-gate.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "no-gate", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toHaveLength(1);
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
  });

  it("returns notice when prerequisiteAcknowledged is explicitly false", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App on settings page",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "explicit-false.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "explicit-false", project_root: tmpDir, prerequisiteAcknowledged: false }
    );

    expect(result).toMatchObject({
      flow: "explicit-false",
      notice: expect.stringContaining("prerequisite"),
      executionPrerequisite: "App on settings page",
    });
    expect(result).not.toHaveProperty("steps");
  });

  it("executes an empty flow (zero steps) successfully", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [],
    });
    await fs.writeFile(path.join(dir, "empty-flow.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "empty-flow", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toEqual([]);
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("executes a flow with only echo steps (no registry calls)", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "First" },
        { kind: "echo", message: "Second" },
        { kind: "echo", message: "Third" },
      ],
    });
    await fs.writeFile(path.join(dir, "echo-only.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "echo-only", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    const steps = (result as { steps: { kind: string; status: string; message?: string }[] }).steps;
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => ({ kind: s.kind, status: s.status, message: s.message }))).toEqual([
      { kind: "echo", status: "pass", message: "First" },
      { kind: "echo", status: "pass", message: "Second" },
      { kind: "echo", status: "pass", message: "Third" },
    ]);
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("error mid-flow reports preceding successful steps", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
      swipe: { result: null, throws: true },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "Start" },
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "tool", name: "swipe", args: { direction: "up" } },
        { kind: "echo", message: "Should not reach" },
      ],
    });
    await fs.writeFile(path.join(dir, "mid-error.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "mid-error", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    const steps = (result as { steps: { kind: string }[] }).steps;
    // echo, tap success, swipe error — then the trailing echo is skipped.
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ kind: "echo", status: "pass", message: "Start" });
    expect(steps[1]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "tap",
      result: { tapped: true },
    });
    expect(steps[2]).toMatchObject({
      kind: "tool",
      status: "error",
      tool: "swipe",
      reason: expect.stringContaining("failed"),
    });
    expect(steps[3]).toMatchObject({ kind: "echo", status: "skip" });
  });

  it("sleeps the step's delayMs before executing it", async () => {
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    const runFlow = createRunFlowTool(registry);
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    // Small delay: the step's configured delayMs is honored before the tool
    // runs. The magnitude is irrelevant to the regression guard — without the
    // delay this completes in ~0ms, so a 25ms wait still proves the behavior
    // while keeping the test off a real ~300ms sleep.
    const delayMs = 25;
    await fs.writeFile(
      path.join(dir, "pre-delay.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "tool", name: "tap", args: { x: 0.5 }, delayMs }],
      })
    );
    const start = Date.now();
    await runFlow.execute({}, { name: "pre-delay", project_root: tmpDir, device: DEVICE });
    expect(Date.now() - start).toBeGreaterThanOrEqual(delayMs - 5);
  });

  it("does not interfere with active recording state", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);
    const addStep = createFlowAddStepTool(registry);

    // A flow to run in the recording's own project AND one in another project —
    // replay must be inert for the recording either way, and a replay under a
    // different project_root is exactly what a second agent's run looks like.
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.1 } }],
    });
    for (const root of [tmpDir, otherDir]) {
      const dir = path.join(root, ".argent", "flows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "side-effect.yaml"), content);
    }

    // Start recording a different flow
    await flowStartRecordingTool.execute(
      {},
      { name: "recording", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const before = await getRecordingSession(tmpDir, "recording");
    expect(before).toBeDefined();

    // Execute saved flows — neither should affect the active recording
    await runFlow.execute({}, { name: "side-effect", project_root: tmpDir, device: DEVICE });
    await runFlow.execute({}, { name: "side-effect", project_root: otherDir, device: DEVICE });

    // The recording still points at the flow it was opened for, in its own
    // project — a replay elsewhere must not rebind name/root/file.
    const after = await getRecordingSession(tmpDir, "recording");
    expect(after).toBe(before);
    expect(after).toMatchObject({
      name: "recording",
      projectRoot: tmpDir,
      filePath: path.join(tmpDir, ".argent", "flows", "recording.yaml"),
    });

    // We should still be able to add steps to the recording…
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "recording", project_root: tmpDir, message: "still recording" }
    );
    expect(result.message).toContain("recording");
    await addStep.execute(
      {},
      { name: "recording", project_root: tmpDir, command: "tap", args: '{"x":0.9}' }
    );

    // …and they land in the original flow's file, not the replayed project's.
    expect(parseFlow(await readFlowFile("recording")).steps).toEqual([
      { kind: "echo", message: "still recording" },
      { kind: "tool", name: "tap", args: { x: 0.9 } },
    ]);
    await expect(readFlowFile("recording", otherDir)).rejects.toThrow();
  });
});

// ── saved-flow name spelling ─────────────────────────────────────────

/**
 * The `name` branch has to hold the same on-disk-spelling invariant the
 * flow_path branch holds: a case-insensitive filesystem (APFS, NTFS) opens
 * snap.yaml for "Snap", and the name — not the file — is what keys the report
 * and __baselines__/, so the run would seed baselines in a directory no entry
 * carries and fail on the first case-sensitive checkout. Every case here reads
 * the directory LISTING, which returns stored bytes on every platform, so they
 * decide identically on case-sensitive (Linux CI) and case-insensitive
 * filesystems.
 */
describe("saved-flow name spelling", () => {
  const DEVICE = "00000000-0000-0000-0000-0000000000ab";

  async function writeFlowFile(basename: string): Promise<string> {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, basename);
    await fs.writeFile(
      filePath,
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "echo", message: "hi" }] }),
      "utf8"
    );
    return filePath;
  }

  it("rejects a name the filesystem would case-fold, handing back the on-disk name", async () => {
    await writeFlowFile("snap.yaml");

    const err = await resolveFlowSource({ name: "Snap", project_root: tmpDir }).then(
      () => null,
      (e: unknown) => e as Error
    );

    // The refusal must name the phantom spelling, the real directory entry,
    // and the stake — then hand back a name, not a flow_path: the caller
    // passed a name and may have no filesystem to spell a path against.
    expect(err?.message).toContain('Invalid flow name "Snap"');
    expect(err?.message).toContain('matched it case-insensitively to "snap.yaml"');
    expect(err?.message).toContain("__baselines__");
    expect(err?.message).toContain('Pass name "snap".');
    expect(err?.message).not.toContain("flow_path");
  });

  it("suggests a rename when the on-disk flow's extension case is unaddressable", async () => {
    // upper.YAML is reachable by no name at all — this branch always builds
    // "<name>.yaml" — and `argent flow list` omits it, so the only honest
    // recovery is the rename.
    await writeFlowFile("upper.YAML");

    const err = await resolveFlowSource({ name: "upper", project_root: tmpDir }).then(
      () => null,
      (e: unknown) => e as Error
    );

    expect(err?.message).toContain('matched it case-insensitively to "upper.YAML"');
    expect(err?.message).toContain(
      'Rename "upper.YAML" to "upper.yaml" to run it — flow files must be lowercase .yaml.'
    );
    expect(err?.message).not.toContain("Pass name");
  });

  it("accepts the exact on-disk spelling, mixed case included", async () => {
    // Byte-for-byte is the contract — not lowercasing: a flow really saved as
    // MixedCase.yaml runs under exactly that name.
    const filePath = await writeFlowFile("MixedCase.yaml");

    await expect(resolveFlowSource({ name: "MixedCase", project_root: tmpDir })).resolves.toEqual({
      filePath,
      flowName: "MixedCase",
      viaUpload: false,
    });
  });

  it("leaves a name that matches nothing as an ordinary missing flow", async () => {
    // No entry case-folds to "nonexistent.yaml", so this is not a spelling
    // problem at all: resolution succeeds and the read reports the absence,
    // exactly as before this gate existed.
    await writeFlowFile("other.yaml");
    const registry = createMockRegistry({});

    await expect(resolveFlowSource({ name: "nonexistent", project_root: tmpDir })).resolves.toEqual(
      {
        filePath: path.join(tmpDir, ".argent", "flows", "nonexistent.yaml"),
        flowName: "nonexistent",
        viaUpload: false,
      }
    );

    const err = await createRunFlowTool(registry)
      .execute({}, { name: "nonexistent", project_root: tmpDir, device: DEVICE })
      .then(
        () => null,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain("ENOENT");
    expect(err?.message).not.toContain("case-insensitively");
  });

  it("skips the check when the flows directory's listing is unavailable", async () => {
    // An execute-only flows directory refuses the listing while still opening
    // the file (here: no .argent/flows at all). An unreadable listing vouches
    // for nothing, so it must refuse nothing — the later read reports absence.
    await expect(resolveFlowSource({ name: "unlisted", project_root: tmpDir })).resolves.toEqual({
      filePath: path.join(tmpDir, ".argent", "flows", "unlisted.yaml"),
      flowName: "unlisted",
      viaUpload: false,
    });
  });

  it("trusts a boundary-materialized upload over the local flows directory", async () => {
    // A remote client's upload lands in a temp dir this server itself named
    // from `name`, so listing it could only agree with itself; the listing that
    // could disagree is the client's, on a host this process cannot read. The
    // co-located snap.yaml below is what THIS host happens to hold at the same
    // path — checking against it would reject a legitimate remote run.
    await writeFlowFile("snap.yaml");
    const uploaded = path.join(os.tmpdir(), "argent-file-input-abc", "Snap.yaml");

    await expect(
      resolveFlowSource(
        { name: "Snap", project_root: tmpDir, flow_file: uploaded },
        {
          clientPath: path.join(tmpDir, ".argent", "flows", "Snap.yaml"),
          presentOnHost: false,
          viaUpload: true,
        }
      )
    ).resolves.toEqual({ filePath: uploaded, flowName: "Snap", viaUpload: true });
  });

  it("flow-execute refuses the mis-cased name before running any step", async () => {
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    await writeFlowFile("checkout.yaml");

    await expect(
      createRunFlowTool(registry).execute(
        {},
        { name: "Checkout", project_root: tmpDir, device: DEVICE }
      )
    ).rejects.toThrow('Pass name "checkout".');
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("flow-read-prerequisite refuses the same name flow-execute would", async () => {
    // Both tools resolve through resolveFlowSource, so the pre-flight cannot
    // answer for a spelling the run itself refuses.
    await writeFlowFile("checkout.yaml");

    await expect(
      flowReadPrerequisiteTool.execute({}, { name: "Checkout", project_root: tmpDir })
    ).rejects.toThrow('Invalid flow name "Checkout"');
  });
});

// ── flow-read-prerequisite ───────────────────────────────────────────

describe("flow-read-prerequisite", () => {
  it("reads the prerequisite from a saved flow", async () => {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App on home screen",
      steps: [{ kind: "echo", message: "Step 1" }],
    });
    await fs.writeFile(path.join(dir, "read-test.yaml"), content);

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "read-test", project_root: tmpDir }
    );

    expect(result.flow).toBe("read-test");
    expect(result.executionPrerequisite).toBe("App on home screen");
  });

  it("returns empty string when flow has no prerequisite", async () => {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "empty-prereq.yaml"), content);

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "empty-prereq", project_root: tmpDir }
    );

    expect(result.flow).toBe("empty-prereq");
    expect(result.executionPrerequisite).toBe("");
  });

  it("throws when the flow file does not exist", async () => {
    await expect(
      flowReadPrerequisiteTool.execute({}, { name: "nonexistent", project_root: tmpDir })
    ).rejects.toThrow();
  });

  it("advertises exactly one of name and flow_path as the flow source", () => {
    // The pre-flight must offer the same source contract as the run it
    // precedes — a schema still requiring `name` would leave flow_path flows
    // unaddressable and silently answer for a saved flow of the same stem.
    const schema = zodObjectToJsonSchema(flowReadPrerequisiteTool.zodSchema!);
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
        flow_path: { type: "string" },
      },
    });
    // Neither source may be `required`: the exactly-one rule cannot be a
    // top-level oneOf (tool-input-schema-contract.test.ts), so the zod
    // superRefine enforces it and the description states it.
    expect(schema.required as string[]).not.toContain("name");
    expect(schema.required as string[]).not.toContain("flow_path");
    expect(flowReadPrerequisiteTool.description).toMatch(/one and only one/i);
  });

  it("reads a boundary-verified flow_path's prerequisite, not the saved flow of the same stem", async () => {
    // Two flows share the stem "gate": the saved copy under .argent/flows and
    // an explicit file elsewhere. The flow_path call must answer with the
    // explicit file's contract and the basename-derived name — exactly what
    // flow-execute would run for the same params — never the saved copy's.
    const savedDir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(savedDir, { recursive: true });
    await fs.writeFile(
      path.join(savedDir, "gate.yaml"),
      serializeFlow({ executionPrerequisite: "SAVED-COPY: HOME screen", steps: [] })
    );
    const elsewhere = path.join(tmpDir, "elsewhere");
    await fs.mkdir(elsewhere, { recursive: true });
    const explicitPath = path.join(elsewhere, "gate.yaml");
    await fs.writeFile(
      explicitPath,
      serializeFlow({ executionPrerequisite: "SHARED-COPY: DETAIL screen", steps: [] })
    );

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { project_root: tmpDir, flow_path: explicitPath },
      {
        artifacts: new ArtifactStore(),
        fileInputs: {
          flow_path: {
            clientPath: explicitPath,
            presentOnHost: true,
            viaUpload: false,
            statVerified: true,
          },
        },
      }
    );

    expect(result.flow).toBe("gate");
    expect(result.executionPrerequisite).toBe("SHARED-COPY: DETAIL screen");
  });

  it("rejects a raw flow_path that skipped the boundary even when the file exists", async () => {
    // Same gate as flow-execute: without boundary evidence an explicit path
    // must not be read — otherwise this tool would hand out prerequisites for
    // arbitrary server files the run tool itself refuses to touch.
    const rawPath = path.join(tmpDir, "raw.yaml");
    await fs.writeFile(rawPath, serializeFlow({ executionPrerequisite: "raw", steps: [] }));

    await expect(
      flowReadPrerequisiteTool.execute({}, { project_root: tmpDir, flow_path: rawPath })
    ).rejects.toThrow("flow_path file-input boundary");
  });

  it("rejects a presence-only flow_path without the client-stat match", async () => {
    // presentOnHost alone is satisfiable by a hand-crafted stat-less wrapper;
    // the read must require the same statVerified evidence flow-execute does,
    // not a weaker copy of the gate.
    const presentPath = path.join(tmpDir, "present.yaml");
    await fs.writeFile(presentPath, serializeFlow({ executionPrerequisite: "p", steps: [] }));

    await expect(
      flowReadPrerequisiteTool.execute(
        {},
        { project_root: tmpDir, flow_path: presentPath },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            flow_path: { clientPath: presentPath, presentOnHost: true, viaUpload: false },
          },
        }
      )
    ).rejects.toThrow("flow_path file-input boundary");
  });

  it("rejects direct callers that provide both flow sources", async () => {
    // Direct execute() bypasses zod, so resolveFlowSource's own exactly-one
    // copy must refuse before either file is consulted.
    await expect(
      flowReadPrerequisiteTool.execute(
        {},
        { name: "gate", project_root: tmpDir, flow_path: path.join(tmpDir, "gate.yaml") }
      )
    ).rejects.toThrow("exactly one flow source");
  });

  it("rejects direct callers that provide NEITHER flow source", async () => {
    await expect(flowReadPrerequisiteTool.execute({}, { project_root: tmpDir })).rejects.toThrow(
      "exactly one flow source"
    );
  });
});

describe("the flow-add-step schema the CLI tests hand-copy", () => {
  // Three CLI test files encode this schema as a fixture — `run-help.test.ts`,
  // `flag-parser.test.ts` and `run-flow-add-step-payload.test.ts` — because
  // `@argent/cli` does not depend on the tool-server and so cannot derive it.
  // That makes drift silent in the direction that matters: relaxing the real
  // schema here (making `project_root` optional, renaming `args`) leaves all
  // three green while the CLI's `--args` handling and help output are decided
  // by a schema nothing resembles any more.
  //
  // So the guard lives on this side, where the schema is. If this fails,
  // update those three fixtures in the same change.
  const CLI_FIXTURE_PROPERTIES = ["name", "project_root", "command", "args", "delayMs"];
  const CLI_FIXTURE_REQUIRED = ["name", "project_root", "command"];

  it("still declares exactly the properties and required keys those fixtures encode", () => {
    const schema = zodObjectToJsonSchema(
      createFlowAddStepTool({} as unknown as Registry).zodSchema!
    ) as { properties: Record<string, unknown>; required?: string[] };

    expect(Object.keys(schema.properties).sort()).toEqual([...CLI_FIXTURE_PROPERTIES].sort());
    expect([...(schema.required ?? [])].sort()).toEqual([...CLI_FIXTURE_REQUIRED].sort());
    // `parseFlags` branches on this one specifically: a tool that declares its
    // own `args` must not also advertise the whole-payload `--args <json>`
    // escape hatch.
    expect(schema.properties["args"]).toMatchObject({ type: "string" });
  });

  it("still opens its description with the sentence those fixtures quote verbatim", () => {
    expect(createFlowAddStepTool({} as unknown as Registry).description).toContain(
      "Execute a tool call and record it as a step in the flow named by `name` + `project_root`"
    );
  });
});

// ── summarizeStep rendering ──────────────────────────────────────────
//
// summarizeStep is the single spelling shared by the recorder's per-step
// `recorded` line and flow-finish-recording's `summary`. `times` (tap),
// `duration` (long-press) and `delayMs` (tool) change what replays, so a
// summary that drops them misdescribes the file. long-press steps have no
// live recorder path, so this is the only coverage of that rendering.
describe("summarizeStep rendering", () => {
  it("renders a tap's times count", () => {
    // A recorded selector spells the id key `identifier`; selectorToYaml maps it
    // to the file's `id` spelling, so the rendered line reads {"id":…}.
    expect(summarizeStep({ kind: "tap", selector: { identifier: "b" }, times: 2 }, 1)).toBe(
      '1. tap: {"id":"b"} ×2'
    );
    expect(summarizeStep({ kind: "tap", x: 0.5, y: 0.3 }, 1)).toBe("1. tap: (0.5, 0.3)");
  });

  it("renders the count it was given, across the range the file can carry", () => {
    // Every other assertion that renders a count uses `times: 2`, so replacing
    // `×${step.times}` with a constant `×2` left the whole suite green. The rest
    // of the range is reachable: gesture-tap takes clickCount up to 10,
    // flow-add-step records it as `times`, and parseTapTimes admits 2..10. Under
    // that mutation a recorded triple-tap renders `×2` on the `recorded` line —
    // the author's only per-step view of what was appended.
    expect(summarizeStep({ kind: "tap", selector: { identifier: "b" }, times: 3 }, 1)).toBe(
      '1. tap: {"id":"b"} ×3'
    );
    expect(summarizeStep({ kind: "tap", x: 0.5, y: 0.3, times: 10 }, 1)).toBe(
      "1. tap: (0.5, 0.3) ×10"
    );
  });

  it("never renders ×1 — the file can't carry times: 1", () => {
    // parseTapTimes normalizes `times: 1` to absent, so a valid flow file never
    // spells a single tap with a count. summarizeStep renders the file's
    // spelling, so a stray in-memory `times: 1` must read as a plain tap, not ×1.
    expect(summarizeStep({ kind: "tap", x: 0.5, y: 0.3, times: 1 }, 1)).toBe("1. tap: (0.5, 0.3)");
    expect(summarizeStep({ kind: "tap", selector: { identifier: "b" }, times: 1 }, 1)).toBe(
      '1. tap: {"id":"b"}'
    );
  });

  it("renders a multi-field selector independently of its key order", () => {
    // This render is also the step anchor. The anchor compares an in-memory
    // selector, whose key order comes from the source object, with one from
    // `parseSelector`, whose key order comes from the zod schema. If the two
    // spellings render differently, the recording loses every verdict, and
    // nothing in the payload shows it. Today `deriveSelector` returns one field
    // on every branch, so nothing else pins this.
    const a = summarizeStep({ kind: "tap", selector: { identifier: "b", text: "Go" } }, 1);
    const b = summarizeStep({ kind: "tap", selector: { text: "Go", identifier: "b" } }, 1);
    expect(a).toBe(b);
    expect(a).toBe('1. tap: {"id":"b","text":"Go"}');
  });

  it("renders a long-press hold duration", () => {
    expect(
      summarizeStep({ kind: "long-press", selector: { text: "Row" }, duration: 1200 }, 3)
    ).toBe('3. long-press: {"text":"Row"} for 1200ms');
    expect(summarizeStep({ kind: "long-press", x: 0.4, y: 0.5 }, 3)).toBe(
      "3. long-press: (0.4, 0.5)"
    );
  });

  it("renders a launch step's app, per-platform map included", () => {
    // `launch` and `run` are the two kinds the recorder builds besides tap and
    // tool, so both reach the author through `recorded` — yet mutating either
    // arm to a constant used to fail nothing. A per-platform launch map is not
    // recorder-reachable (the rewrite only maps a plain bundleId), but it is
    // the arm's other branch and finish-recording renders it.
    expect(summarizeStep({ kind: "launch", app: "com.acme.app" }, 1)).toBe(
      "1. launch: com.acme.app"
    );
    expect(
      summarizeStep({ kind: "launch", app: { ios: "com.acme.app", android: "com.acme" } }, 2)
    ).toBe('2. launch: {"ios":"com.acme.app","android":"com.acme"}');
  });

  it("renders a run step's target as the file spells it", () => {
    // The as-written YAML path, not a resolved absolute one — the summary
    // quotes the file so a reader can find the line they are being told about.
    expect(summarizeStep({ kind: "run", flow: "login.yaml" }, 1)).toBe("1. run: login.yaml");
    expect(summarizeStep({ kind: "run", flow: "../shared/login.yaml" }, 5)).toBe(
      "5. run: ../shared/login.yaml"
    );
  });

  it("renders a tool step's pre-step delay", () => {
    expect(
      summarizeStep({ kind: "tool", name: "screenshot", args: { scale: 0.2 }, delayMs: 500 }, 4)
    ).toBe('4. tool: screenshot {"scale":0.2} (after 500ms)');
    expect(summarizeStep({ kind: "tool", name: "screenshot", args: {} }, 4)).toBe(
      "4. tool: screenshot {}"
    );
  });

  // `fromYamlStep` copies `delayMs` across without checking its type and
  // `validateFlow` does not check it either, so a hand-edited non-number
  // survives a parse and reaches the renderer. The line must describe what the
  // RUNNER does with such a value — it gates on truthiness and hands the raw
  // value to setTimeout — not what `typeof` says about it, since the two
  // disagree in both directions.
  const toolStepWithDelay = (yamlDelay: string) =>
    parseFlow(
      `executionPrerequisite: ""\nsteps:\n  - tool: screenshot\n    args: {}\n    delayMs: ${yamlDelay}\n`
    ).steps[0];

  it("renders no delay for a hand-edited delayMs the runner will not sleep", () => {
    // `soon` coerces to NaN, which setTimeout floors to an immediate tick.
    expect(summarizeStep(toolStepWithDelay("soon"), 4)).toBe("4. tool: screenshot {}");
    // `.nan` IS a number, so a `typeof` check announced `(after NaNms)` — but
    // it is falsy, so the runner's gate skips the sleep entirely.
    expect(summarizeStep(toolStepWithDelay(".nan"), 4)).toBe("4. tool: screenshot {}");
    // Same tick, same silence: neither reaches setTimeout's 1ms floor.
    expect(summarizeStep(toolStepWithDelay("0"), 4)).toBe("4. tool: screenshot {}");
    expect(summarizeStep(toolStepWithDelay("-5"), 4)).toBe("4. tool: screenshot {}");
  });

  it("renders the delay a quoted number really sleeps", () => {
    // A quoted numeric is an ordinary slip in the post-finish hand edit, and it is
    // not inert: the runner's gate is truthiness, and setTimeout coerces the
    // string, so this waits two real seconds on every replay. A `typeof` check
    // rendered nothing at all for it.
    expect(summarizeStep(toolStepWithDelay('"2000"'), 4)).toBe(
      "4. tool: screenshot {} (after 2000ms)"
    );
  });

  it("warns when delayMs prevents gesture-tap selector capture", async () => {
    const registry = createMockRegistry({
      "gesture-tap": { result: { tapped: true } },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "delayed-tap", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "delayed-tap",
        project_root: tmpDir,
        command: "gesture-tap",
        args: '{"udid":"ABC","x":0.5,"y":0.3}',
        delayMs: 500,
      }
    );

    expect(result.message).toContain("raw coordinate tool step");
    expect(result.message).toContain("remove delayMs");
    expect(parseFlow(await onDisk("delayed-tap")).steps).toEqual([
      {
        kind: "tool",
        name: "gesture-tap",
        args: { x: 0.5, y: 0.3 },
        delayMs: 500,
      },
    ]);
  });

  it("warns when delayMs prevents restart-app from becoming the leading launch", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true } },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute({}, { name: "delayed-launch", project_root: tmpDir });

    const result = await tool.execute(
      {},
      {
        name: "delayed-launch",
        project_root: tmpDir,
        command: "restart-app",
        args: '{"udid":"ABC","bundleId":"com.acme.app"}',
        delayMs: 500,
      }
    );

    expect(result.message).toContain("prevents the launch rewrite");
    expect(result.message).toContain("post-launch await-ui-element");
    expect(parseFlow(await onDisk("delayed-launch")).steps[0]).toMatchObject({
      kind: "tool",
      name: "restart-app",
      delayMs: 500,
    });
  });

  it("warns when gesture-custom records an opaque coordinate gesture", async () => {
    const registry = createMockRegistry({
      "gesture-custom": { result: { completed: true } },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "custom-gesture", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "custom-gesture",
        project_root: tmpDir,
        command: "gesture-custom",
        args: '{"udid":"ABC","events":[{"type":"Down","x":0.5,"y":0.3},{"type":"Up","x":0.5,"y":0.3}]}',
      }
    );

    expect(result.message).toContain("raw coordinates");
    expect(result.message).toContain("record that tap individually");
  });

  it("warns when run-sequence hides coordinate taps in one opaque step", async () => {
    const registry = createMockRegistry({
      "run-sequence": {
        result: { completed: 1, total: 1, steps: [{ tool: "gesture-tap", result: {} }] },
      },
    });
    const tool = createFlowAddStepTool(registry);
    await flowStartRecordingTool.execute(
      {},
      { name: "sequence-tap", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const result = await tool.execute(
      {},
      {
        name: "sequence-tap",
        project_root: tmpDir,
        command: "run-sequence",
        args: '{"udid":"ABC","steps":[{"tool":"gesture-tap","args":{"x":0.5,"y":0.3}}]}',
      }
    );

    expect(result.message).toContain("opaque raw step");
    expect(result.message).toContain("record taps individually");
  });
});
