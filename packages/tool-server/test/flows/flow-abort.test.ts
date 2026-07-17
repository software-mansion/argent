import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Cancel the run mid-directive by tripping an AbortController from inside the
// tree fetch itself: the mock counts reads and aborts on a scripted one, which
// lands the abort deterministically inside a directive's auto-wait / focus-wait
// poll (no timer races).
let currentFetch: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentFetch()),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function mockRegistry(calls: string[]): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      calls.push(id);
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
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

async function run(name: string, registry: Registry, signal: AbortSignal): Promise<FlowRunResult> {
  return asRun(
    await createRunFlowTool(registry).execute({}, { name, project_root: tmpDir, device: DEVICE }, {
      signal,
    } as never)
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-abort-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("run cancellation mid-directive", () => {
  it("fails the verdict when an already-aborted run only contains echo narration", async () => {
    const controller = new AbortController();
    controller.abort();
    currentFetch = () => ({ tree: screen([]), source: "native-devtools" });

    await writeFlow("cancelled-echo", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "never narrated" }],
    });

    const result = await run("cancelled-echo", mockRegistry([]), controller.signal);

    expect(result.steps).toMatchObject([{ kind: "echo", status: "skip", reason: "run aborted" }]);
    // Echo remains excluded from displayed counters, but cancellation still
    // makes the run incomplete rather than a zero-step pass.
    expect(result.skipped).toBe(0);
    expect(result.ok).toBe(false);
  });

  it("reports a tap cancelled during its auto-wait as a skip, not an offscreen failure", async () => {
    const controller = new AbortController();
    // The target never appears; the run is cancelled on the third tree read
    // (i.e. while the tap's auto-wait is still polling).
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 3) controller.abort();
      return {
        tree: screen([n({ label: "Other", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-tap", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Checkout", loose: true } }],
    });

    const result = await run("cancelled-tap", mockRegistry(calls), controller.signal);

    // A skip with the uniform abort reason — NOT a fail with the misleading
    // "no visible element matched … add a scroll-to step" hint.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(result.ok).toBe(false);
    expect(calls).not.toContain("gesture-tap");
  });

  it("dispatches no tap when the run is cancelled during the settle-completing tree read", async () => {
    const controller = new AbortController();
    // The target is visible and the tree is stable, so read 2 is the read that
    // completes the settle (two identical fingerprints). The abort lands inside
    // that read — settleTree must NOT hand the tree back to waitForFrame, or the
    // tap would be dispatched post-cancellation and recorded as a pass.
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 2) controller.abort();
      return {
        tree: screen([
          n({ label: "Checkout", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
        ]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-tap-settle", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Checkout", loose: true } }],
    });

    const result = await run("cancelled-tap-settle", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(result.ok).toBe(false);
    expect(calls).not.toContain("gesture-tap");
  });

  it("dispatches no tap when the run is cancelled one read before the settle completes", async () => {
    // Control for the settle-completing case above: aborting during the FIRST
    // read (not yet a fingerprint match) already skipped correctly — keep it so.
    const controller = new AbortController();
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 1) controller.abort();
      return {
        tree: screen([
          n({ label: "Checkout", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
        ]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-tap-first-read", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Checkout", loose: true } }],
    });

    const result = await run("cancelled-tap-first-read", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).not.toContain("gesture-tap");
  });

  it("dispatches no scroll increment when the run is cancelled during a mid-scroll settle read", async () => {
    const controller = new AbortController();
    // The target never appears and the tree is stable — after read 2 settles,
    // scroll-to would dispatch its first swipe increment. The abort lands inside
    // that settle-completing read, so no gesture may follow it.
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 2) controller.abort();
      return {
        tree: screen([n({ label: "Row 1", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-scroll-settle", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const result = await run("cancelled-scroll-settle", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["scroll-to:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).not.toContain("gesture-swipe");
    expect(calls).not.toContain("gesture-scroll");
  });

  it("dispatches no focus tap when a type step is cancelled during the settle-completing read", async () => {
    const controller = new AbortController();
    // Same timing as the tap case, but for `type`: the leak would be the focus
    // tap (the keyboard dispatches are separately guarded already).
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 2) controller.abort();
      return {
        tree: screen([
          n({ identifier: "email", frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 } }),
        ]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-type-settle", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = await run("cancelled-type-settle", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).not.toContain("gesture-tap");
    expect(calls).not.toContain("keyboard");
  });

  it("injects no keyboard input when the run is cancelled during the focus wait", async () => {
    const controller = new AbortController();
    // Reads 1-2 are the pre-tap tree settle and read 3 is its post-pixel tree
    // revalidation; read 4 is the focus poll's first look. The field never
    // reports focus, and the run is cancelled there.
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 4) controller.abort();
      return {
        tree: screen([
          n({ identifier: "email", frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 } }),
        ]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-type", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = await run("cancelled-type", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    // The focus tap fired before the cancel, but neither the text nor the
    // submitting Enter may reach the app afterwards.
    expect(calls).toContain("gesture-tap");
    expect(calls).not.toContain("keyboard");
  });

  it("reports an await cancelled mid-poll as a skip with the uniform abort reason", async () => {
    const controller = new AbortController();
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 3) controller.abort();
      return {
        tree: screen([n({ label: "Other", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-await", {
      executionPrerequisite: "",
      steps: [{ kind: "await", condition: "visible", selector: { identifier: "spinner" } }],
    });

    const result = await run("cancelled-await", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["await:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
  });
});

describe("run cancellation mid-launch", () => {
  // Like mockRegistry, but the restart-app call runs a scripted hook first —
  // tripping the abort deterministically inside the launch step.
  function launchRegistry(calls: string[], onRestartApp: () => unknown): Registry {
    return {
      invokeTool: vi.fn(async (id: string) => {
        calls.push(id);
        if (id === "list-devices") return { devices: [] };
        if (id === "restart-app") return onRestartApp();
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
  }

  it("reports a launch cancelled during the post-launch settle as a skip", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    // restart-app succeeds, but the run is cancelled right after — the abort
    // lands in the post-launch settle / tree-source gate.
    const registry = launchRegistry(calls, () => {
      controller.abort();
      return { ok: true };
    });

    await writeFlow("cancelled-launch-settle", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });

    const result = await run("cancelled-launch-settle", registry, controller.signal);

    // A skip with the uniform abort reason — NOT a pass: the settle and the
    // tree-source gate were cut short, so the launch verified nothing.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(result.ok).toBe(false);
    expect(calls).toContain("restart-app");
  });

  it("reports a launch cancelled during restart-app as a skip, not an error", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    // The cancellation makes the restart-app sub-tool itself reject: that
    // rejection is the abort, not an app failure.
    const registry = launchRegistry(calls, () => {
      controller.abort();
      throw new Error("This operation was aborted");
    });

    await writeFlow("cancelled-launch-restart", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });

    const result = await run("cancelled-launch-restart", registry, controller.signal);

    // A skip with the uniform abort reason — NOT an error blaming restart-app.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).toContain("restart-app");
  });
});
