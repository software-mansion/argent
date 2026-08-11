import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// A launch step must pin every later tree read to the launched app - unpinned
// iOS reads auto-resolve across every connected process, which one poisoned
// background system process sinks. The mock records each read's pin.

let treePins: Array<string | undefined>;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (_r: unknown, _d: unknown, launchedAppId?: string): Promise<DescribeTreeData> => {
      treePins.push(launchedAppId);
      return {
        tree: screen([n({ identifier: "ready", label: "Ready" })]),
        source: "native-devtools",
      };
    }
  ),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const APP = "com.acme.app";
let tmpDir: string;

function n(partial: Partial<DescribeNode>): DescribeNode {
  return {
    role: "AXOther",
    frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
    children: [],
    ...partial,
  };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    // The iOS launch step gates on a native-devtools connection; report
    // connected so the run proceeds past it.
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [APP],
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

async function run(
  name: string,
  registry: Registry,
  args: Record<string, unknown> = {}
): Promise<FlowRunResult> {
  return asRun(
    await createRunFlowTool(registry).execute(
      {},
      { name, project_root: tmpDir, device: DEVICE, ...args },
      { signal: new AbortController().signal } as never
    )
  );
}

beforeEach(async () => {
  treePins = [];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pin-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("launch pins the flow tree target", () => {
  it("every read after a launch step carries the launched app id", async () => {
    await writeFlow("pinned", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "assert", condition: "visible", selector: { identifier: "ready" } },
      ],
    });

    const result = await run("pinned", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "assert:pass",
    ]);
    expect(treePins.length).toBeGreaterThan(0);
    expect(treePins.every((pin) => pin === APP)).toBe(true);
  });

  it("a fragment's steps inherit the pin from the parent run's launch", async () => {
    await writeFlow("frag", {
      executionPrerequisite: "App is running",
      steps: [{ kind: "assert", condition: "visible", selector: { identifier: "ready" } }],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "run", flow: "frag.yaml" },
      ],
    });

    const result = await run("main", mockRegistry());

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "run:pass",
      "assert:pass",
    ]);
    expect(treePins.length).toBeGreaterThan(0);
    expect(treePins.every((pin) => pin === APP)).toBe(true);
  });

  it("a run with no launch step keeps the auto-resolve fallback (no pin)", async () => {
    await writeFlow("unpinned", {
      executionPrerequisite: "App is running",
      steps: [{ kind: "assert", condition: "visible", selector: { identifier: "ready" } }],
    });

    const result = await run("unpinned", mockRegistry(), { prerequisiteAcknowledged: true });

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["assert:pass"]);
    expect(treePins.length).toBeGreaterThan(0);
    expect(treePins.every((pin) => pin === undefined)).toBe(true);
  });
});
