import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import {
  parseFlow,
  serializeFlow,
  type FlowFile,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";
import { useAutoAdvancingClock } from "../helpers/auto-clock";

useAutoAdvancingClock();

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

/**
 * A device-free tool: it records the tag it was called with, and throws when
 * asked to, or runs the `during` hook (to cancel the run mid-step).
 */
function mockRegistry(during?: (tag: string) => void) {
  const calls: string[] = [];
  const invokeTool = vi.fn(async (id: string, args: { tag?: string; fail?: boolean }) => {
    // A `run:` step resolves a device, so one is booted.
    if (id === "list-devices") {
      return { devices: [{ platform: "ios", udid: DEVICE, state: "Booted" }] };
    }
    if (id !== "probe") return { ok: true };
    calls.push(String(args.tag));
    during?.(String(args.tag));
    if (args.fail) throw new Error(`probe ${args.tag} failed`);
    return { ok: true };
  });
  const registry = {
    invokeTool,
    getTool: vi.fn((name: string) =>
      name === "probe" ? { inputSchema: { properties: { tag: {}, fail: {} } } } : undefined
    ),
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
  return { registry, calls };
}

const probe = (tag: string, fail = false): FlowStep => ({
  kind: "tool",
  name: "probe",
  args: fail ? { tag, fail: true } : { tag },
});

async function writeFlow(name: string, flow: Partial<FlowFile>): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "e2e");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({ executionPrerequisite: "", steps: [], ...flow }),
    "utf8"
  );
}

async function run(
  registry: Registry,
  name: string,
  opts: { signal?: AbortSignal; prerequisiteAcknowledged?: boolean } = {}
): Promise<FlowRunResult> {
  const result = await createRunFlowTool(registry).execute(
    {},
    {
      name,
      project_root: tmpDir,
      ...(opts.prerequisiteAcknowledged ? { prerequisiteAcknowledged: true } : {}),
    },
    (opts.signal ? { signal: opts.signal } : undefined) as never
  );
  if (!("steps" in result)) throw new Error(`expected a run, got notice: ${result.notice}`);
  return result;
}

const lines = (r: FlowRunResult) =>
  r.steps.map((s) => [s.kind, s.status, s.shutdown === true, s.e2eTest]);

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-shutdown-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("shutdown: in the YAML", () => {
  it("round-trips, and an empty list is dropped", () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [probe("a")],
      shutdown: [{ kind: "echo", message: "bye" }, probe("z")],
    };
    const text = serializeFlow(flow);
    expect(text).toMatch(/\nshutdown:\n/);
    expect(parseFlow(text)).toEqual(flow);
    expect(parseFlow("steps: []\nshutdown: []\n")).toEqual({
      executionPrerequisite: "",
      steps: [],
    });
  });

  it("refuses a shutdown that is not a list", () => {
    expect(() => parseFlow("steps: []\nshutdown: 3\n")).toThrow(/shutdown must be a list/);
  });

  it("names a shutdown step when an output reference in it is malformed", () => {
    expect(() => parseFlow('steps: []\nshutdown:\n  - echo: "{{output:a}}"\n')).toThrow(
      /^Shutdown step 1 \(`echo`\)/
    );
  });

  it("leaves the leading-launch rule to steps:", () => {
    // A launch in shutdown does not make a fragment standalone.
    expect(() =>
      parseFlow(
        "executionPrerequisite: logged in\nsteps:\n  - echo: hi\nshutdown:\n  - launch: com.example\n"
      )
    ).not.toThrow();
  });
});

describe("running shutdown:", () => {
  it("runs after a passing run's steps, tagged and counted", async () => {
    await writeFlow("t", { steps: [probe("a")], shutdown: [probe("z")] });
    const { registry, calls } = mockRegistry();

    const result = await run(registry, "t");

    expect(calls).toEqual(["a", "z"]);
    expect(lines(result)).toEqual([
      ["tool", "pass", false, "t"],
      ["tool", "pass", true, "t"],
    ]);
    expect(result.ok).toBe(true);
    expect(result.passed).toBe(2);
    expect(result.shutdownFailed).toBeUndefined();
  });

  it("runs after a step failed, and leaves the verdict to that failure", async () => {
    await writeFlow("t", { steps: [probe("a", true), probe("b")], shutdown: [probe("z")] });
    const { registry, calls } = mockRegistry();

    const result = await run(registry, "t");

    expect(calls).toEqual(["a", "z"]);
    expect(lines(result)).toEqual([
      ["tool", "error", false, "t"],
      ["tool", "skip", false, "t"],
      ["tool", "pass", true, "t"],
    ]);
    expect(result.ok).toBe(false);
    expect(result.shutdownFailed).toBeUndefined();
  });

  it("keeps going past a failed shutdown step, and fails the run", async () => {
    await writeFlow("t", {
      steps: [probe("a")],
      shutdown: [probe("y", true), probe("z")],
    });
    const { registry, calls } = mockRegistry();

    const result = await run(registry, "t");

    expect(calls).toEqual(["a", "y", "z"]);
    expect(lines(result)).toEqual([
      ["tool", "pass", false, "t"],
      ["tool", "error", true, "t"],
      ["tool", "pass", true, "t"],
    ]);
    expect(result.ok).toBe(false);
    expect(result.shutdownFailed).toBe(true);
  });

  it("stops a when: block in shutdown at its own failure, then runs the next entry", async () => {
    await writeFlow("t", {
      steps: [],
      shutdown: [
        {
          kind: "when",
          condition: { kind: "output", check: { path: "user", test: "exists", expected: false } },
          steps: [probe("w1", true), probe("w2")],
        },
        probe("z"),
      ],
    });
    const { registry, calls } = mockRegistry();

    const result = await run(registry, "t");

    expect(calls).toEqual(["w1", "z"]);
    expect(result.steps.map((s) => [s.kind, s.status, s.shutdown])).toEqual([
      ["when", "pass", true],
      ["tool", "error", true],
      ["tool", "skip", true],
      ["tool", "pass", true],
    ]);
    expect(result.shutdownFailed).toBe(true);
  });

  it("is skipped when the run is cancelled", async () => {
    await writeFlow("t", { steps: [probe("a"), probe("b")], shutdown: [probe("z")] });
    const controller = new AbortController();
    const { registry, calls } = mockRegistry((tag) => {
      if (tag === "a") controller.abort();
    });

    const result = await run(registry, "t", { signal: controller.signal });

    expect(calls).toEqual(["a"]);
    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
    const shutdown = result.steps.filter((s) => s.shutdown);
    expect(shutdown.map((s) => [s.status, s.reason])).toEqual([["skip", "run aborted"]]);
  });

  it("stops when the run is cancelled during it", async () => {
    await writeFlow("t", { steps: [probe("a")], shutdown: [probe("y"), probe("z")] });
    const controller = new AbortController();
    const { registry, calls } = mockRegistry((tag) => {
      if (tag === "y") controller.abort();
    });

    const result = await run(registry, "t", { signal: controller.signal });

    expect(calls).toEqual(["a", "y"]);
    expect(result.aborted).toBe(true);
    expect(result.steps.at(-1)).toMatchObject({
      shutdown: true,
      status: "skip",
      reason: "run aborted",
    });
  });

  it("runs the fragments' shutdowns at the run's end, newest first, then the test's", async () => {
    await writeFlow("first", { steps: [probe("f1")], shutdown: [probe("first-down")] });
    // A fragment whose own step fails still cleans up: it loaded.
    await writeFlow("second", { steps: [probe("f2", true)], shutdown: [probe("second-down")] });
    await writeFlow("t", {
      steps: [
        { kind: "run", flow: "first.yaml" },
        { kind: "run", flow: "second.yaml" },
        probe("after"),
      ],
      shutdown: [probe("root-down")],
    });
    const { registry, calls } = mockRegistry();

    const result = await run(registry, "t");

    expect(calls).toEqual(["f1", "f2", "second-down", "first-down", "root-down"]);
    expect(
      result.steps.filter((s) => s.shutdown).map((s) => [s.e2eTest, s.status, s.depth])
    ).toEqual([
      ["second", "pass", undefined],
      ["first", "pass", undefined],
      ["t", "pass", undefined],
    ]);
  });

  it("runs the shutdown of a fragment that shutdown loads before the next entry", async () => {
    await writeFlow("frag", { steps: [probe("frag-step")], shutdown: [probe("frag-down")] });
    await writeFlow("t", {
      steps: [probe("main")],
      shutdown: [{ kind: "run", flow: "frag.yaml" }, probe("root-down-2")],
    });
    const { registry, calls } = mockRegistry();

    await run(registry, "t");

    expect(calls).toEqual(["main", "frag-step", "frag-down", "root-down-2"]);
  });

  it("queues a fragment's shutdown once per load", async () => {
    await writeFlow("make-user", { steps: [], shutdown: [probe("delete-user")] });
    await writeFlow("t", {
      steps: [
        { kind: "run", flow: "make-user.yaml" },
        { kind: "run", flow: "make-user.yaml" },
      ],
    });
    const { registry, calls } = mockRegistry();

    await run(registry, "t");

    expect(calls).toEqual(["delete-user", "delete-user"]);
  });

  it("does not queue the shutdown of a fragment that never loaded", async () => {
    await writeFlow("frag", { steps: [], shutdown: [probe("frag-down")] });
    await writeFlow("t", {
      steps: [probe("a", true), { kind: "run", flow: "frag.yaml" }],
      shutdown: [probe("root-down")],
    });
    const { registry, calls } = mockRegistry();

    await run(registry, "t");

    expect(calls).toEqual(["a", "root-down"]);
  });

  it("does not run when the run stops for its prerequisite", async () => {
    await writeFlow("t", {
      executionPrerequisite: "logged in",
      steps: [probe("a")],
      shutdown: [probe("z")],
    });
    const { registry, calls } = mockRegistry();

    const notice = await createRunFlowTool(registry).execute(
      {},
      { name: "t", project_root: tmpDir }
    );

    expect(notice).toHaveProperty("notice");
    expect(calls).toEqual([]);
  });

  it("refuses a retired tool key in shutdown before any step runs", async () => {
    await writeFlow("t", {
      steps: [probe("a")],
      shutdown: [{ kind: "tool", name: "probe", args: { tag: "z", settle: true } }],
    });
    const { registry, calls } = mockRegistry();
    (registry.getTool as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === "probe"
        ? { inputSchema: { properties: { tag: {}, settle: { not: {}, description: "gone" } } } }
        : undefined
    );

    await expect(run(registry, "t")).rejects.toThrow(/shutdown step 1 as written/);
    expect(calls).toEqual([]);
  });
});
