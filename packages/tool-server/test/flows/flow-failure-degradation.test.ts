/**
 * Diagnostics degrade the PAYLOAD, never the run.
 *
 * Capture happens between `execLeafStep` returning and `pushReport` — on a step
 * whose verdict is already decided — so every way it can go wrong must cost at
 * most a field. That is not defensive habit: the flow test harness invokes the
 * tool with NO `ctx` at all and a `screenshot` stub that returns `{ ok: true }`,
 * so one unguarded `requireArtifacts` here would break ~20 existing test files.
 *
 * Each test therefore asserts the same two things: the diagnostics degraded the
 * way they are supposed to, AND the verdict, the step statuses and the reasons
 * are exactly what a run with no diagnostics at all would have produced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

let currentFetch: () => DescribeTreeData | Promise<DescribeTreeData>;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentFetch()),
}));

import { ArtifactStore } from "../../src/artifacts";
import {
  createRunFlowTool,
  type FlowRunResult,
  type StepReport,
} from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import type { FlowStepFailure } from "../../src/tools/flows/flow-failure";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

const HOME: DescribeTreeData = {
  tree: screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]),
  source: "native-devtools",
};

function mockRegistry(onInvoke?: (id: string, args: Record<string, unknown>) => unknown): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown> = {}) => {
      if (id === "list-devices") return { devices: [] };
      const scripted = onInvoke?.(id, args);
      return scripted === undefined ? { ok: true } : scripted;
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function writeFlow(name: string, flow: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(flow), "utf8");
}

async function run(
  name: string,
  opts: { registry?: Registry; ctx?: Partial<ToolContext> } = {}
): Promise<FlowRunResult> {
  const tool = createRunFlowTool(opts.registry ?? mockRegistry());
  const result = await tool.execute(
    {},
    { name, project_root: tmpDir, device: DEVICE },
    opts.ctx as ToolContext | undefined
  );
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return result;
}

function singleFailure(result: FlowRunResult): FlowStepFailure {
  const carrying = result.steps.filter((s) => s.failure !== undefined);
  expect(carrying).toHaveLength(1);
  return carrying[0]!.failure!;
}

/**
 * The verdict a run WITHOUT diagnostics would have produced: the same statuses,
 * the same counters, and a `reason` on every non-passing step that the failure
 * object merely duplicates. Asserted in every case below — degradation that
 * changed any of this would be a broken run dressed up as a report.
 */
function expectVerdict(
  result: FlowRunResult,
  expected: {
    statuses: string[];
    ok: boolean;
    passed?: number;
    failed?: number;
    errored?: number;
    skipped?: number;
  }
): void {
  expect(result.steps.map((s: StepReport) => `${s.kind}:${s.status}`)).toEqual(expected.statuses);
  expect(result.ok).toBe(expected.ok);
  expect(result.passed).toBe(expected.passed ?? 0);
  expect(result.failed).toBe(expected.failed ?? 0);
  expect(result.errored).toBe(expected.errored ?? 0);
  expect(result.skipped).toBe(expected.skipped ?? 0);
  for (const step of result.steps) {
    if (step.status === "fail" || step.status === "error") {
      expect(step.reason, "a non-passing step still carries its prose reason").toBeTruthy();
      // The wire-compat guarantee: a renderer that ignores `failure` prints
      // exactly what it printed before.
      if (step.failure) expect(step.failure.message).toBe(step.reason);
    }
  }
}

/** The two-step flow every case below fails on: assert, then a step that skips. */
async function writeFailingFlow(name: string): Promise<void> {
  await writeFlow(name, {
    executionPrerequisite: "",
    steps: [
      { kind: "assert", condition: "exists", selector: { text: "Nothing Here" } },
      { kind: "wait", ms: 5 },
    ],
  });
}

const FAILING_VERDICT = {
  statuses: ["assert:fail", "wait:skip"],
  ok: false,
  failed: 1,
  skipped: 1,
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-failure-degradation-"));
  currentFetch = () => HOME;
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("no artifact store (the unit-test path)", () => {
  it("captures no screenshot and no tree dump, and leaves the verdict alone", async () => {
    await writeFailingFlow("no-ctx");

    const result = await run("no-ctx"); // no ctx at all — the harness's own shape
    const failure = singleFailure(result);

    expect(failure.screenshot).toBeUndefined();
    expect(failure.tree).toBeUndefined();
    // Everything that does not need a store still works: the screen, the
    // candidates and the classification are all derived from the tree the
    // directive already read.
    expect(failure.screen.state).toBe("available");
    expect(failure.code).toBe("selector-not-found");
    expectVerdict(result, FAILING_VERDICT);
  });
});

describe("a post-hoc tree read that fails", () => {
  it("reports the screen as unavailable and leaves the verdict alone", async () => {
    // A `tool` failure carries no tree of its own, so the assembler reads one
    // after the fact — and that read throws.
    const registry = mockRegistry((id) => {
      if (id === "button") throw new Error("no such button");
      return undefined;
    });
    currentFetch = () => {
      throw new Error("native devtools disconnected");
    };
    await writeFlow("post-hoc-throws", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "button", args: { button: "back" } },
        { kind: "wait", ms: 5 },
      ],
    });

    const result = await run("post-hoc-throws", { registry });
    const failure = singleFailure(result);

    expect(failure.screen).toMatchObject({
      state: "unavailable",
      reason: "read-failed",
      detail: expect.stringContaining("native devtools disconnected"),
    });
    expect(failure.candidates).toEqual([]);
    expect(failure.code).toBe("tool-step-failed");
    expectVerdict(result, {
      statuses: ["tool:error", "wait:skip"],
      ok: false,
      errored: 1,
      skipped: 1,
    });
  });
});

describe("cancellation", () => {
  it("keeps a cancelled directive a SKIP with no diagnostics at all", async () => {
    const controller = new AbortController();
    let reads = 0;
    currentFetch = () => {
      if (++reads >= 3) controller.abort();
      return HOME;
    };
    await writeFlow("cancelled", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", selector: { text: "Checkout", loose: true } },
        { kind: "wait", ms: 5 },
      ],
    });

    const result = await run("cancelled", { ctx: { signal: controller.signal } });

    // A cancelled run says nothing about the app: skip, never a fail — and a
    // skip carries no failure object for a renderer to print.
    expect(result.steps.every((s) => s.failure === undefined)).toBe(true);
    expect(result.steps[0]!.reason).toBe("run aborted");
    expectVerdict(result, { statuses: ["tap:skip", "wait:skip"], ok: false, skipped: 2 });
    expect(result.aborted).toBe(true);
  }, 15000);

  it("marks the screen `aborted` when a real failure races the cancellation", async () => {
    // The narrow window where a failure and an abort coexist: the tool step
    // rejects after the run was cancelled, so the step is a genuine error but
    // no capture may be attempted against a device the caller has let go of.
    const controller = new AbortController();
    const registry = mockRegistry((id) => {
      if (id === "button") {
        controller.abort();
        throw new Error("no such button");
      }
      return undefined;
    });
    await writeFlow("abort-mid-capture", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "button", args: { button: "back" } }],
    });

    const result = await run("abort-mid-capture", {
      registry,
      ctx: { signal: controller.signal, artifacts: new ArtifactStore() },
    });
    const failure = singleFailure(result);

    expect(failure.screen).toEqual({ state: "unavailable", reason: "aborted" });
    // No post-abort invoke: it would reject, and a cancelled run's screen says
    // nothing about the failure anyway.
    expect(failure.screenshot).toBeUndefined();
    expect(failure.tree).toBeUndefined();
    expectVerdict(result, { statuses: ["tool:error"], ok: false, errored: 1 });
  });
});

describe("screenshot capture", () => {
  it("degrades to no screenshot when the capture invoke rejects", async () => {
    const registry = mockRegistry((id) => {
      if (id === "screenshot") throw new Error("simulator-server not reachable");
      return undefined;
    });
    await writeFailingFlow("shot-throws");

    const result = await run("shot-throws", {
      registry,
      ctx: { artifacts: new ArtifactStore() },
    });
    const failure = singleFailure(result);

    expect(failure.screenshot).toBeUndefined();
    // The rest of the bundle is unaffected — the tree dump proves the artifact
    // path was live and it was only the capture that failed.
    expect(failure.tree?.mimeType).toBe("text/plain");
    expect(failure.screen.state).toBe("available");
    expectVerdict(result, FAILING_VERDICT);
  });

  it("ignores a screenshot result that is not an artifact handle", async () => {
    // The harness's registry answers every tool with `{ ok: true }`, so
    // `shot.image` is undefined. Reading `.hostPath` off that would throw
    // inside the assembler on every unit-test run.
    await writeFailingFlow("shot-stub");

    const result = await run("shot-stub", { ctx: { artifacts: new ArtifactStore() } });
    const failure = singleFailure(result);

    expect(failure.screenshot).toBeUndefined();
    expect(failure.tree?.mimeType).toBe("text/plain");
    expectVerdict(result, FAILING_VERDICT);
  });

  it("reuses a snapshot's `current` artifact instead of capturing a second time", async () => {
    // A second capture would show a DIFFERENT screen than the one that was
    // diffed — the single most misleading thing a snapshot failure could carry.
    const store = new ArtifactStore();
    const pngPath = path.join(tmpDir, "shot.png");
    const png = Buffer.alloc(24);
    png.writeUInt32BE(390, 16);
    png.writeUInt32BE(844, 20);
    await fs.writeFile(pngPath, png);

    // The screenshot tool registers its own capture, so `shot.image` is a
    // ready-made handle; mirror that exactly.
    const handle = await store.register(pngPath, { mimeType: "image/png" });
    let screenshots = 0;
    const registry = mockRegistry((id) => {
      if (id !== "screenshot") return undefined;
      screenshots++;
      return { image: handle };
    });

    await writeFlow("snapshot-fail", {
      executionPrerequisite: "",
      steps: [
        { kind: "snapshot", name: "home" },
        { kind: "wait", ms: 5 },
      ],
    });

    const result = await run("snapshot-fail", { registry, ctx: { artifacts: store } });
    const failure = singleFailure(result);

    expect(failure.code).toBe("snapshot-baseline-missing");
    // Exactly one capture for the whole run: the snapshot's own.
    expect(screenshots).toBe(1);
    expect(failure.screenshot).toBeUndefined();
    expect(result.steps[0]!.artifacts?.current).toBeDefined();
    expectVerdict(result, {
      statuses: ["snapshot:fail", "wait:skip"],
      ok: false,
      failed: 1,
      skipped: 1,
    });
  });
});
