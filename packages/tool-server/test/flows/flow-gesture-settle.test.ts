import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// One ordered log of tree reads and tool invocations, so a test can assert not
// just THAT the screen was settled but that it was settled before the gesture
// went out. `currentTree` throwing stands in for a tree-source outage.
type Event = { kind: "read" } | { kind: "invoke"; tool: string; args: Record<string, unknown> };
let events: Event[];
let currentTree: () => DescribeNode;

vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    events.push({ kind: "read" });
    return { tree: currentTree(), source: "native-devtools" };
  }),
}));

import { settleTree, type ActionEnv } from "../../src/tools/flows/flow-actions";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

const BUTTON = { x: 0.2, y: 0.4, width: 0.6, height: 0.1 };

function screen(children: DescribeNode[] = []): DescribeNode {
  return { role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children };
}

const outage = (): DescribeNode => {
  throw new Error("native devtools is unavailable");
};

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      events.push({ kind: "invoke", tool: id, args });
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    // A `launch` gates on the native-devtools connection before it can pass.
    resolveService: vi.fn(async () => ({ isConnected: () => true })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

async function run(name: string, signal?: AbortSignal): Promise<FlowRunResult> {
  const tool = createRunFlowTool(mockRegistry());
  const ctx = signal ? ({ signal } as never) : undefined;
  const r = await tool.execute({}, { name, project_root: tmpDir, device: DEVICE }, ctx);
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

/** Tree reads that landed before the first dispatched gesture. */
function readsBeforeFirstGesture(): number {
  const at = events.findIndex((e) => e.kind === "invoke");
  return (at === -1 ? events : events.slice(0, at)).filter((e) => e.kind === "read").length;
}

/** Tree reads between two positions in the log, `to` exclusive. */
function readsBetween(from: number, to: number): number {
  return events.slice(from, to).filter((e) => e.kind === "read").length;
}

/** Index of the nth dispatched gesture in the event log. */
function gestureAt(n: number): number {
  return events.reduce<number[]>((acc, e, i) => (e.kind === "invoke" ? [...acc, i] : acc), [])[n]!;
}

function gestures(): Array<{ tool: string; args: Record<string, unknown> }> {
  return events.flatMap((e) => (e.kind === "invoke" ? [{ tool: e.tool, args: e.args }] : []));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-gesture-settle-"));
  events = [];
  currentTree = screen;
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// A selector target settles inside `waitForFrame`; a target that resolves
// nothing used to skip the settle entirely and dispatch into whatever motion
// was in flight. Every input directive settles first, however it is addressed.
describe("gestures without a selector settle before dispatching", () => {
  it("settles a coordinate tap", async () => {
    await writeFlow("tap-xy", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.4, y: 0.6 }],
    });

    const result = await run("tap-xy");

    expect(result.ok).toBe(true);
    // Two identical reads are what "settled" means — the gesture waits for both.
    expect(readsBeforeFirstGesture()).toBeGreaterThanOrEqual(2);
    expect(gestures()[0]).toMatchObject({ tool: "gesture-tap", args: { x: 0.4, y: 0.6 } });
  });

  it("settles a coordinate long-press", async () => {
    await writeFlow("press-xy", {
      executionPrerequisite: "",
      steps: [{ kind: "long-press", x: 0.2, y: 0.3 }],
    });

    const result = await run("press-xy");

    expect(result.ok).toBe(true);
    expect(readsBeforeFirstGesture()).toBeGreaterThanOrEqual(2);
    expect(gestures()[0]?.tool).toBe("gesture-custom");
  });

  it("settles a centre-anchored pinch", async () => {
    await writeFlow("pinch-center", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", scale: 0.5 }],
    });

    const result = await run("pinch-center");

    expect(result.ok).toBe(true);
    expect(readsBeforeFirstGesture()).toBeGreaterThanOrEqual(2);
    expect(gestures()[0]?.tool).toBe("gesture-pinch");
  });

  it("settles a centre-anchored rotate", async () => {
    await writeFlow("rotate-center", {
      executionPrerequisite: "",
      steps: [{ kind: "rotate", by: 90 }],
    });

    const result = await run("rotate-center");

    expect(result.ok).toBe(true);
    expect(readsBeforeFirstGesture()).toBeGreaterThanOrEqual(2);
    expect(gestures()[0]?.tool).toBe("gesture-rotate");
  });

  it("waits for the screen to stop before a coordinate tap, not just for one read", async () => {
    // Three distinct trees, then a repeat: the settle cannot converge until the
    // fourth read matches the third.
    let reads = 0;
    currentTree = () => {
      reads += 1;
      const frame = { x: 0, y: Math.min(reads, 3) / 100, width: 1, height: 1 };
      return { role: "AXWindow", frame, children: [] };
    };
    await writeFlow("tap-moving", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.5, y: 0.5 }],
    });

    const result = await run("tap-moving");

    expect(result.ok).toBe(true);
    expect(readsBeforeFirstGesture()).toBe(4);
  });
});

// Best-effort, unlike the selector path: these gestures read no frame out of
// the tree, so an outage must not turn a working coordinate gesture — the
// escape hatch for elements the tree cannot see — into a failed step.
describe("a tree-source outage never fails a selector-less gesture", () => {
  it("still dispatches a coordinate tap", async () => {
    currentTree = outage;
    await writeFlow("tap-blind", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.4, y: 0.6 }],
    });

    const result = await run("tap-blind");

    expect(result.ok).toBe(true);
    expect(gestures()[0]).toMatchObject({ tool: "gesture-tap", args: { x: 0.4, y: 0.6 } });
  }, 15_000);

  it("still dispatches a centre-anchored pinch", async () => {
    currentTree = outage;
    await writeFlow("pinch-blind", {
      executionPrerequisite: "",
      steps: [{ kind: "pinch", scale: 2 }],
    });

    const result = await run("pinch-blind");

    expect(result.ok).toBe(true);
    expect(gestures()[0]?.tool).toBe("gesture-pinch");
  }, 15_000);

  it("charges the outage window once per run, not once per gesture", async () => {
    // The shape this matters for: a source that serves no tree at all
    // (`ios-remote`, an app the instrumentation cannot load) against a flow
    // made of coordinate gestures, which is the only kind such a run can have.
    currentTree = outage;
    await writeFlow("taps-blind", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "tap", x: 0.2, y: 0.2 },
        { kind: "tap", x: 0.3, y: 0.3 },
      ],
    });

    const result = await run("taps-blind");

    expect(result.ok).toBe(true);
    expect(gestures()).toHaveLength(3);
    // Every read belongs to the first tap's window; taps 2 and 3 rethrow what
    // it proved. Without the memo each fills a window of its own, which is ~12
    // reads and 3s per gesture on a source that fails instantly.
    expect(readsBetween(gestureAt(0), events.length)).toBe(0);
    expect(readsBeforeFirstGesture()).toBeGreaterThan(2);
  }, 20_000);

  it("proves no outage from a window that read the tree but never settled", async () => {
    // A screen in perpetual motion (a spinner, a video) that also blips once:
    // the window expires having both read the tree and seen an error. It holds
    // still from the first tap onwards, so the second tap's reads are exact.
    let reads = 0;
    currentTree = () => {
      if (events.some((e) => e.kind === "invoke")) return screen();
      reads += 1;
      if (reads === 2) throw new Error("transient describe failure");
      const frame = { x: 0, y: reads / 100, width: 1, height: 1 };
      return { role: "AXWindow", frame, children: [] };
    };
    await writeFlow("tap-restless-tap", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "tap", x: 0.2, y: 0.2 },
      ],
    });

    const result = await run("tap-restless-tap");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass", "tap:pass"]);
    // A window that read the tree proves no outage, however restless the screen
    // it described: the second tap settles on its own two identical reads. A
    // verdict minted off the first window would leave it rethrowing with zero.
    expect(readsBetween(gestureAt(0), gestureAt(1))).toBe(2);
  }, 20_000);

  it("rides out a transient read failure rather than treating it as the outage", async () => {
    // Fails once, then serves a still screen: the settle must still converge on
    // the two identical reads that follow instead of quitting on the blip.
    let reads = 0;
    currentTree = () => {
      reads += 1;
      if (reads === 1) throw new Error("transient describe failure");
      return screen();
    };
    await writeFlow("tap-blip", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.4, y: 0.6 }],
    });

    const result = await run("tap-blip");

    expect(result.ok).toBe(true);
    expect(readsBeforeFirstGesture()).toBe(3);
    expect(gestures()[0]).toMatchObject({ tool: "gesture-tap", args: { x: 0.4, y: 0.6 } });
  });

  // The source is dead until the run's first gesture goes out, which is exactly
  // when the memo has been written — so phase two starts on a known event
  // rather than on a clock, and every read count below is exact.
  const deadUntilFirstGesture = (): DescribeNode => {
    if (!events.some((e) => e.kind === "invoke")) {
      throw new Error("native devtools is unavailable");
    }
    return screen([{ role: "AXButton", label: "Continue", frame: BUTTON, children: [] }]);
  };

  it("stops skipping as soon as any read comes back, settle or not", async () => {
    // The `await` is the point: it never settles, it just reads. A memo only a
    // settle could clear would survive it and leave the tap after it unsettled.
    currentTree = deadUntilFirstGesture;
    await writeFlow("tap-await-tap", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "await", condition: "exists", selector: { text: "Continue", loose: true } },
        { kind: "tap", x: 0.2, y: 0.2 },
      ],
    });

    const result = await run("tap-await-tap");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tap:pass",
      "await:pass",
      "tap:pass",
    ]);
    // One read for the await, then two for the second tap's own settle. A memo
    // that outlived the await would leave the tap with none of its own.
    expect(readsBetween(gestureAt(0), gestureAt(1))).toBe(3);
  }, 20_000);

  it("never lets a selector step inherit the skip", async () => {
    // Only the best-effort caller may consume the memo. `waitForFrame` must
    // still auto-wait the source back, or a proven outage would turn every
    // later selector step into an instant failure it could have polled through.
    currentTree = deadUntilFirstGesture;
    await writeFlow("tap-then-selector", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "tap", selector: { text: "Continue", loose: true } },
        { kind: "tap", x: 0.2, y: 0.2 },
      ],
    });

    const result = await run("tap-then-selector");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tap:pass",
      "tap:pass",
      "tap:pass",
    ]);
    expect(gestures()).toHaveLength(3);
    // And the selector step's reads cleared the memo for the tap behind it.
    expect(readsBetween(gestureAt(1), gestureAt(2))).toBe(2);
  }, 20_000);
});

// A relaunch is the repair the tree source names when it refuses an app that
// loaded no instrumentation, so a `launch` spends the verdict proven before it
// - no read falls between it and the next gesture to clear it instead.
describe("a launch clears a proven outage", () => {
  it("makes the gesture after it pay for a settle of its own", async () => {
    currentTree = outage;
    await writeFlow("tap-launch-tap", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.1, y: 0.1 },
        { kind: "launch", app: "com.acme.app" },
        { kind: "tap", x: 0.2, y: 0.2 },
      ],
    });

    const result = await run("tap-launch-tap");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tap:pass",
      "launch:pass",
      "tap:pass",
    ]);
    // Invocation 1 is the launch's own `restart-app`; the tap behind it settles
    // from scratch. A memo that outlived the launch would leave it zero reads.
    expect(readsBetween(gestureAt(1), gestureAt(2))).toBeGreaterThan(2);
  }, 20_000);
});

// The same device operation written as a raw `tool:` step. It is the shape a
// recorded flow actually carries - `launch-app` is never rewritten into a
// `launch:` directive, and the docs tell authors to start an app that cannot
// load the instrumentation with a bare `tool: restart-app` - so it must spend
// the verdict too, or the gesture behind the most animation-heavy moment a flow
// has would be the one dispatched with no settle at all.
describe("a raw `tool:` relaunch clears a proven outage", () => {
  /** Dead until the named relaunch tool runs, healthy after: the repair works. */
  const deadUntilTool = (tool: string) => (): DescribeNode => {
    if (!events.some((e) => e.kind === "invoke" && e.tool === tool)) {
      throw new Error("native devtools is unavailable");
    }
    return screen();
  };

  it.each(["restart-app", "launch-app"])(
    "makes the gesture after `tool: %s` pay for a settle of its own",
    async (tool) => {
      currentTree = deadUntilTool(tool);
      await writeFlow(`tap-${tool}-tap`, {
        executionPrerequisite: "",
        steps: [
          { kind: "tap", x: 0.1, y: 0.1 },
          { kind: "tool", name: tool, args: { bundleId: "com.acme.app" } },
          { kind: "tap", x: 0.2, y: 0.2 },
        ],
      });

      const result = await run(`tap-${tool}-tap`);

      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
        "tap:pass",
        "tool:pass",
        "tap:pass",
      ]);
      // Exactly the two identical reads a settle converges on. A verdict only
      // `launch:` spent would leave the second tap with zero.
      expect(readsBetween(gestureAt(1), gestureAt(2))).toBe(2);
    },
    20_000
  );
});

// The memo is keyed to the device it was proven against: a run can move onto
// another one mid-flight (a chromium `launch` boots its own), and a dead source
// on the device the run has left says nothing about the one it is on.
describe("a proven outage is spent only on the device that proved it", () => {
  const proven = (deviceId: string): ActionEnv["treeOutage"] => ({
    proven: { deviceId, error: new Error("native devtools is unavailable") },
  });

  function envFor(treeOutage: ActionEnv["treeOutage"]): ActionEnv {
    return {
      registry: mockRegistry(),
      device: { id: DEVICE, platform: "ios" } as ActionEnv["device"],
      treeOutage,
    };
  }

  it("rethrows without reading when the same device proved it", async () => {
    await expect(settleTree(envFor(proven(DEVICE)), { skipProvenOutage: true })).rejects.toThrow(
      "native devtools is unavailable"
    );
    expect(events).toEqual([]);
  });

  it("reads anyway when another device proved it", async () => {
    const tree = await settleTree(envFor(proven("some-other-device")), {
      skipProvenOutage: true,
    });

    expect(tree).toBeDefined();
    expect(events.filter((e) => e.kind === "read").length).toBeGreaterThanOrEqual(2);
  });
});

// The settle is the only abort checkpoint a coordinate gesture has: nothing
// between it and the dispatch looks at the signal again, unlike `pinch`/`rotate`,
// which re-check before their own dispatch. flow-abort.test.ts pins this same
// moment on the selector path.
describe("a run cancelled inside the settle dispatches no coordinate gesture", () => {
  /** Trip the abort inside read 2, the read that would complete the settle. */
  function abortOnSettlingRead(controller: AbortController): void {
    let reads = 0;
    currentTree = () => {
      reads += 1;
      if (reads >= 2) controller.abort();
      return screen();
    };
  }

  it("skips a coordinate tap", async () => {
    const controller = new AbortController();
    abortOnSettlingRead(controller);
    await writeFlow("tap-cancelled", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", x: 0.4, y: 0.6 }],
    });

    const result = await run("tap-cancelled", controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(gestures()).toEqual([]);
  });

  it("skips a coordinate long-press", async () => {
    const controller = new AbortController();
    abortOnSettlingRead(controller);
    await writeFlow("press-cancelled", {
      executionPrerequisite: "",
      steps: [{ kind: "long-press", x: 0.2, y: 0.3 }],
    });

    const result = await run("press-cancelled", controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["long-press:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(gestures()).toEqual([]);
  });
});
