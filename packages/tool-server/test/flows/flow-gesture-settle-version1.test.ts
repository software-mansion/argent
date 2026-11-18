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
/** A source that never answers, for the tests that need a read still in flight. */
let hangReads: boolean;
/** How long a read takes to answer, for the tests that need one slower than a settle window. */
let readDelayMs: number;
/** Pixel dimensions the source serves, for the tests whose dispatched geometry reads them. */
let currentScreen: { width: number; height: number } | undefined;

vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    events.push({ kind: "read" });
    if (hangReads) return new Promise<never>(() => {});
    if (readDelayMs > 0) await new Promise((r) => setTimeout(r, readDelayMs));
    return {
      tree: currentTree(),
      source: "native-devtools",
      ...(currentScreen ? { screen: currentScreen } : {}),
    };
  }),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

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
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({ ...yaml, version: 1 }),
    "utf8"
  );
}

async function run(
  name: string,
  signal?: AbortSignal,
  device: string = DEVICE
): Promise<FlowRunResult> {
  const tool = createRunFlowTool(mockRegistry());
  const ctx = signal ? ({ signal } as never) : undefined;
  const r = await tool.execute({}, { name, project_root: tmpDir, device }, ctx);
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

/** Tree reads between two positions in the log, `to` exclusive. */
function readsBetween(from: number, to: number): number {
  return events.slice(from, to).filter((e) => e.kind === "read").length;
}

/** Index of the nth dispatched gesture in the event log. */
function gestureAt(n: number): number {
  return events.reduce<number[]>((acc, e, i) => (e.kind === "invoke" ? [...acc, i] : acc), [])[n]!;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-gesture-settle-"));
  events = [];
  currentTree = screen;
  hangReads = false;
  readDelayMs = 0;
  currentScreen = undefined;
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
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
