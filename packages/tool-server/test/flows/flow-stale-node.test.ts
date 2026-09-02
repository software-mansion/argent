import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// R15. A node that no longer belonged to the current screen was still in the
// tree and satisfied a readiness check — "caused a false-positive save
// completion". A silent green is worse than a flake: the test has stopped
// testing, and nothing downstream will ever flag it.
//
// The guard is that a POSITIVE verdict has to survive a second read of a
// settled tree. These tests serve scripted trees to `fetchFlowTree` and count
// reads, so what the runner accepts (and when) is observable.

let trees: Array<() => DescribeNode>;
let reads: number;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    const make = trees[Math.min(reads, trees.length - 1)]!;
    reads += 1;
    return { tree: make(), source: "native-devtools", screen: { width: 390, height: 844 } };
  }),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

const FULL: DescribeNode["frame"] = { x: 0, y: 0, width: 1, height: 1 };

function screen(labels: string[]): DescribeNode {
  return {
    role: "AXWindow",
    frame: FULL,
    children: labels.map((label, i) => ({
      role: "AXStaticText",
      label,
      frame: { x: 0, y: 0.1 * i, width: 1, height: 0.08 },
      children: [],
    })),
  };
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
    resolveService: vi.fn(async () => ({ isConnected: () => true })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: string): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), yaml, "utf8");
}

async function run(name: string): Promise<FlowRunResult> {
  const tool = createRunFlowTool(mockRegistry());
  const result = await tool.execute(
    {},
    { name, project_root: tmpDir, device: DEVICE, prerequisiteAcknowledged: true },
    undefined
  );
  if (!("steps" in result)) throw new Error("expected a run result");
  return result;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-stale-"));
  reads = 0;
  trees = [];
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("a positive check must survive a second read", () => {
  const FLOW = `executionPrerequisite: "on the save screen"
steps:
  - await: { visible: "Saved", timeout: 3000 }
`;

  it("refuses a match the tree had not finished evicting", async () => {
    // Read 1 still carries "Saved" from the screen the app just left; from
    // read 2 on it is gone and the destination is what is really there.
    trees = [() => screen(["Saved", "Old screen"]), () => screen(["Compose"])];
    await writeFlow("save", FLOW);

    const r = await run("save");
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toMatchObject({ status: "fail" });
    // The single stale read was not enough to pass the step.
    expect(reads).toBeGreaterThan(1);
  });

  it("passes once the same match holds on a settled tree", async () => {
    trees = [() => screen(["Saved"])];
    await writeFlow("save", FLOW);

    const r = await run("save");
    expect(r.ok).toBe(true);
    expect(r.steps.at(-1)).toMatchObject({ status: "pass" });
    // Confirmation costs exactly one extra read, not a whole poll budget.
    expect(reads).toBe(2);
  });

  it("accepts a stable match on a screen that never stops moving", async () => {
    // The asserted label never changes; a spinner elsewhere keeps the tree
    // fingerprint churning, so the two reads are never identical as trees.
    let spin = 0;
    trees = [
      () => {
        spin += 1;
        return screen(["Saved", `spinner-${spin}`]);
      },
    ];
    await writeFlow("save", FLOW);

    const r = await run("save");
    // Motion somewhere else on the screen must not fail a stably-matched
    // element — it is accepted once the step's budget is spent.
    expect(r.ok).toBe(true);
    expect(r.steps.at(-1)).toMatchObject({ status: "pass" });
  }, 20_000);

  it("still accepts an element that is sliding into place", async () => {
    // The matched element reports a NEW FRAME on every read, so it can never
    // produce two identical match fingerprints. Requiring that would have
    // failed a check the single-read version passed — a regression, since a
    // moving element is genuinely present.
    let y = 0;
    trees = [
      () => {
        y += 0.01;
        return {
          role: "AXWindow",
          frame: FULL,
          children: [
            {
              role: "AXStaticText",
              label: "Saved",
              frame: { x: 0, y, width: 1, height: 0.08 },
              children: [],
            },
          ],
        };
      },
    ];
    await writeFlow("save", FLOW);

    const r = await run("save");
    expect(r.ok).toBe(true);
    expect(r.steps.at(-1)).toMatchObject({ status: "pass" });
  }, 20_000);

  // Two skills tell the agent to key on `errored > 0` to tell an environment
  // problem apart from a regression. That only works if an indeterminate
  // outcome — one where the check could not run at all — is reported as
  // `error` rather than `fail`.
  it("reports a check that could not run as errored, not failed", async () => {
    trees = [
      () => {
        throw new Error("native devtools is unavailable");
      },
    ];
    await writeFlow("dark", FLOW);

    const r = await run("dark");
    const step = r.steps.at(-1)!;
    expect(step.status).toBe("error");
    expect(r.errored).toBe(1);
    expect(r.failed).toBe(0);
    // Still not a pass: the run is not ok, it is just not a verdict either.
    expect(r.ok).toBe(false);
  }, 20_000);

  // Compatibility variants are deliberately NOT folded (a blackletter display
  // name must not match the account it imitates), but the everyday case is
  // innocent: the app renders one `…` and the author types three dots. A bare
  // "no element matched" points at nothing, so the miss has to explain itself.
  it("explains a miss caused only by a typographic variant", async () => {
    trees = [() => screen(["Add more languages…"])];
    await writeFlow(
      "ellipsis",
      `executionPrerequisite: "on the languages screen"
steps:
  - await: { visible: "Add more languages...", timeout: 2000 }
`
    );

    const r = await run("ellipsis");
    const step = r.steps.at(-1)!;
    expect(step.status).toBe("fail");
    expect(step.reason).toContain('the element\'s text is "Add more languages…"');
    expect(step.reason).toContain("typographic variant");
  }, 20_000);

  it("does not delay a negative check, which has no stale-into-existence mode", async () => {
    trees = [() => screen(["Compose"])];
    await writeFlow(
      "gone",
      `executionPrerequisite: "after dismissing"
steps:
  - await: { visible: "Compose", timeout: 3000 }
  - await: { hidden: "Sheet", timeout: 3000 }
`
    );
    const r = await run("gone");
    expect(r.ok).toBe(true);
    // 2 reads to confirm the positive check, 1 for the `hidden` one.
    expect(reads).toBe(3);
  });
});
