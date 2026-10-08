import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// End-to-end companion to flow-tree-no-fallback.test.ts: that file pins the
// contract at the fetch level (an iOS simulator read throws when the
// accessibility daemon cannot be resolved or cannot answer `tree`); this one
// proves that throw is what stands between an unreadable screen and a false
// green flow. Nothing on the tree path is mocked - the runner goes through the
// REAL fetchFlowTree -> queryAxFlowTree against an ax-service whose `tree`
// rejects, the shape of a daemon gone mid-run or a read that timed out.
//
// A `hidden` assert is the step that matters: its element is never seen, so
// `everMatched` never flips and the blind-read guard's backstop cannot engage.
// If the read degraded to an empty tree instead of throwing, the poll loop
// would treat that tree as TRUSTED and `hidden` would evaluate true against it:
// the exact false pass this file guards.

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

/** The ax-service resolves, but every `tree` read rejects. `reads` counts the attempts. */
function blindAxService(reads: { count: number }) {
  return {
    tree: async () => {
      reads.count += 1;
      throw new Error(`ax-service: tree read timed out for ${DEVICE}`);
    },
  };
}

// The ax-service resolution is the only seam faked here; the registry's tool
// surface is inert (the flow has no launch or tool steps).
function mockRegistry(resolveService: () => Promise<unknown>): Registry {
  return {
    resolveService,
    invokeTool: async () => ({ ok: true }),
    getTool: () => undefined,
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

async function runHiddenAssert(registry: Registry): Promise<FlowRunResult> {
  await writeFlow("never-seen-hidden", {
    executionPrerequisite: "",
    steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "General" } }],
  });
  return asRun(
    await createRunFlowTool(registry).execute(
      {},
      { name: "never-seen-hidden", project_root: tmpDir, device: DEVICE }
    )
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-blind-daemon-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("hidden assert against an unreadable daemon tree (end-to-end)", () => {
  it("fails with the daemon's reason when every tree read rejects", async () => {
    const reads = { count: 0 };

    const result = await runHiddenAssert(mockRegistry(vi.fn(async () => blindAxService(reads))));

    // Every poll's fetch rejects, so the assert never gets a trusted read and
    // must report the outage, quoting the daemon's error.
    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/could not read the UI tree/);
    expect(result.steps[0].reason).toMatch(
      /tree read timed out for 00000000-0000-0000-0000-0000000000ab/
    );
    expect(reads.count).toBeGreaterThan(0);
  });

  it("fails the same way when the daemon cannot be resolved at all", async () => {
    const result = await runHiddenAssert(
      mockRegistry(
        vi.fn(async () => {
          throw new Error("ax-service exited with code 1 before connecting");
        })
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/could not read the UI tree/);
    expect(result.steps[0].reason).toMatch(/exited with code 1 before connecting/);
  });
});
