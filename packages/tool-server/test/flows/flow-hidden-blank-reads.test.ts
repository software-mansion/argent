import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Serve the flow tree directly (flows hard-fail rather than degrade to the AX
// tree). The mock scripts the reads: the element is visible on the first read,
// then the tree blanks — the shape of a mid-navigation transition, where the
// blind-read guard refuses to let an empty tree confirm `hidden`.
let currentFetch: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentFetch()),
}));

// Status-bar pinning shells out to `xcrun simctl` per run — irrelevant to what
// these tests pin, and a source of contention under the parallel test load.
vi.mock("../../src/utils/status-bar", () => ({
  pinStatusBar: vi.fn(async () => false),
  restoreStatusBar: vi.fn(async () => {}),
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

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
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

async function run(name: string): Promise<FlowRunResult> {
  return asRun(
    await createRunFlowTool(mockRegistry()).execute(
      {},
      { name, project_root: tmpDir, device: DEVICE }
    )
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-hidden-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("hidden timeout diagnostics", () => {
  it("does not claim the element was still visible when the final reads were blank", async () => {
    // Read 1: the spinner is visible (a trusted read — everMatched flips on).
    // Every later read is an empty tree, which the blind-read guard refuses to
    // trust for `hidden` once the selector has matched. The timeout reason must
    // say the check could not be confirmed — not that an element the last reads
    // never saw was "still visible".
    let reads = 0;
    currentFetch = () => {
      reads++;
      return {
        tree:
          reads === 1
            ? screen([
                n({ identifier: "spinner", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
              ])
            : screen([]),
        source: "native-devtools",
      };
    };

    await writeFlow("blank-hidden", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "spinner" } }],
    });

    const result = await run("blank-hidden");

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/could not confirm/);
    expect(result.steps[0].reason).not.toMatch(/still visible/);
  });

  it("still reports a genuinely visible element as still visible", async () => {
    currentFetch = () => ({
      tree: screen([
        n({ identifier: "spinner", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("stuck-spinner", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "spinner" } }],
    });

    const result = await run("stuck-spinner");

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/still visible/);
  });
});
