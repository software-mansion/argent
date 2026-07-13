import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import {
  createRunFlowTool,
  type FlowRunResult,
  type StepReport,
} from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "boom") throw new Error("kaput");
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
    // iOS flows gate on a native-devtools connection: report connected so the
    // run proceeds, but expose no target app so the tree fetch falls back to
    // the AX tree (these tests don't drive the native hierarchy).
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
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

/** ToolContext carrying only the progress hook — the flows under test touch nothing else. */
function progressCtx(events: StepReport[]): ToolContext {
  return { emitProgress: (e: unknown) => events.push(e as StepReport) } as unknown as ToolContext;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-progress-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow progress streaming (ctx.emitProgress)", () => {
  it("emits every report in execution order, identical to the final result", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "starting" },
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "tool", name: "swipe", args: {} },
      ],
    });

    const events: StepReport[] = [];
    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE },
        progressCtx(events)
      )
    );

    // Every appended report streamed, in order, as the same objects.
    expect(events).toEqual(result.steps);
    expect(events.map((e) => `${e.kind}:${e.status}`)).toEqual([
      "echo:pass",
      "tool:pass",
      "tool:pass",
    ]);
    // Echo is narration — the counters cover only the two real steps.
    expect(result.passed).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("streams nested fragment steps (run:) with their source-flow attribution", async () => {
    await writeFlow("login", {
      executionPrerequisite: "On login screen",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5 } }],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "login" },
        { kind: "echo", message: "done" },
      ],
    });

    const events: StepReport[] = [];
    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE },
        progressCtx(events)
      )
    );

    expect(events).toEqual(result.steps);
    // The run marker and the fragment's expanded step both stream, attributed
    // to the fragment.
    expect(events.map((e) => `${e.kind}:${e.flow}`)).toEqual([
      "run:login",
      "tool:login",
      "echo:main",
    ]);
  });

  it("streams the failing step and the skip-flood that follows it", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "tap", args: {} },
        { kind: "tool", name: "boom", args: {} },
        { kind: "tool", name: "swipe", args: {} },
        { kind: "echo", message: "never reached" },
      ],
    });

    const events: StepReport[] = [];
    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE },
        progressCtx(events)
      )
    );

    expect(events).toEqual(result.steps);
    expect(events.map((e) => e.status)).toEqual(["pass", "error", "skip", "skip"]);
    expect(result.ok).toBe(false);
    // The skipped echo stays out of the counters like a passed one would.
    expect(result.passed).toBe(1);
    expect(result.errored).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("labels directive steps with their target selector", async () => {
    // A failing first step hard-stops the run, so every directive below is
    // reported as a skip — which must still carry its target label.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "boom", args: {} },
        { kind: "tap", selector: { text: "Clear logs", loose: true } },
        { kind: "tap", x: 0.5, y: 0.25 },
        {
          kind: "assert",
          condition: "hidden",
          selector: { text: "] outer Touchable", loose: true },
        },
        {
          kind: "await",
          condition: "text",
          selector: { identifier: "total" },
          expectedText: "Total",
          textMatch: "contains",
        },
        { kind: "scroll-to", target: { text: "Nested touchables", loose: true }, direction: "up" },
        { kind: "type", into: { identifier: "email" }, text: "a@b.c" },
        { kind: "snapshot", name: "home" },
      ],
    });

    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );

    expect(result.steps.map((s) => s.target)).toEqual([
      undefined,
      '"Clear logs"',
      "(0.5, 0.25)",
      'hidden "] outer Touchable"',
      'id=total contains "Total"',
      '"Nested touchables" (up)',
      "into id=email",
      '"home"',
    ]);
  });

  it("runs identically when no progress consumer is attached", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: {} }],
    });

    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(1);
  });
});
