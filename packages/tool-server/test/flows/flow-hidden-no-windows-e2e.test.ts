import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { AXServiceApi, AXTreeResponse } from "../../src/blueprints/ax-service";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// A `hidden` assert must not pass against a tree that could not be read. An
// unreadable read adapts to an empty tree, the element was never seen, so the
// poll loop would trust it and find the selector absent: a false green. The
// runner goes through the REAL fetchFlowTree -> queryIosSimulatorFlowTree; the
// ax-service is the only seam.

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const APP = "com.example.app";
let tmpDir: string;

/** The app root and nothing under it: an app that exposes no accessible elements. */
const EMPTY_TREE: AXTreeResponse = {
  alertVisible: false,
  screenFrame: { width: 402, height: 874 },
  nodes: [{ index: 0, label: "App", bundleId: APP }],
  truncated: false,
  foregroundApp: APP,
  treeVersion: 2,
};

// The registry's tool surface is inert: the flow has no launch or tool steps.
function mockRegistry(ax: Pick<AXServiceApi, "degraded" | "tree">): Registry {
  return {
    resolveService: async () => ax,
    invokeTool: async () => ({ ok: true }),
    getTool: () => undefined,
  } as unknown as Registry;
}

async function runHiddenAssert(
  ax: Pick<AXServiceApi, "degraded" | "tree">
): Promise<FlowRunResult> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "hidden.yaml"),
    serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "General" } }],
    }),
    "utf8"
  );
  const r = await createRunFlowTool(mockRegistry(ax)).execute(
    {},
    { name: "hidden", project_root: tmpDir, device: DEVICE }
  );
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-hidden-unread-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("hidden assert against an unreadable tree (end-to-end)", () => {
  it.each([
    {
      name: "an empty tree",
      ax: { degraded: false, tree: async () => EMPTY_TREE },
      reason:
        /accessibility tree of .* is empty: the foreground app \(com\.example\.app\) exposes no accessible elements/,
    },
    {
      name: "an empty tree on a simulator argent did not boot",
      ax: { degraded: true, tree: async () => EMPTY_TREE },
      reason: /accessibility tree of .* is empty: argent did not boot this simulator/,
    },
    {
      name: "a read that fails",
      ax: {
        degraded: false,
        tree: async (): Promise<AXTreeResponse> => {
          throw new Error("socket closed");
        },
      },
      reason: /accessibility tree of .* could not be read: socket closed/,
    },
  ])("fails with the tree-source reason on $name", async ({ ax, reason }) => {
    const result = await runHiddenAssert(ax);

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["assert:fail"]);
    expect(result.steps[0].reason).toMatch(/could not read the UI tree/);
    expect(result.steps[0].reason).toMatch(reason);
  });
});
