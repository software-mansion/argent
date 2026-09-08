import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { NativeAppState, NativeDevtoolsApi } from "../../src/blueprints/native-devtools";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// End-to-end companion to flow-ios-tree-no-windows.test.ts: that file pins the
// guard at the unit level (queryFullHierarchyTree throws on a no-windows read);
// this one proves the guard is what stands between an unreadable target and
// a false green flow. Nothing on the tree path is mocked — the runner goes
// through the REAL fetchFlowTree → queryFullHierarchyTree against a
// native-devtools API whose getFullHierarchy returns `{ windows: [] }` (the
// no-attached-window shape). Without the guard,
// that payload adapts to an empty tree the poll loop treats as TRUSTED — the
// element was never seen, so the blind-read guard's everMatched backstop
// doesn't engage — and a `hidden` assert evaluates true against it: the exact
// false pass the guard exists to prevent. Revert the guard and this test
// fails; the unit file and this one gate the fix from both ends.

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const APP = "com.example.app";
let tmpDir: string;

function appState(bundleId: string): NativeAppState {
  return {
    bundleId,
    applicationState: "active",
    foregroundActiveSceneCount: 1,
    foregroundInactiveSceneCount: 0,
    backgroundSceneCount: 0,
    unattachedSceneCount: 0,
    isFrontmostCandidate: true,
  };
}

/**
 * Minimal NativeDevtoolsApi: one connected, foreground app whose
 * `queryViewHierarchy` always reports no windows — the read the guard refuses.
 */
function nativeApi(): NativeDevtoolsApi {
  return {
    listConnectedBundleIds: () => [APP],
    getAppState: async (id: string) => appState(id),
    queryViewHierarchy: async () => ({ windows: [] }),
  } as unknown as NativeDevtoolsApi;
}

// The native-devtools service resolution is the only seam faked here; the
// registry's tool surface is inert (the flow has no launch or tool steps).
function mockRegistry(api: NativeDevtoolsApi): Registry {
  return {
    resolveService: async () => api,
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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-no-windows-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("hidden assert against a no-windows target (end-to-end)", () => {
  it("fails with the guard's no-windows reason instead of false-passing", async () => {
    await writeFlow("no-windows-hidden", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "General" } }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry(nativeApi())).execute(
        {},
        { name: "no-windows-hidden", project_root: tmpDir, device: DEVICE }
      )
    );

    // Every poll's fetch rejects with the guard's message, so the assert never
    // gets a trusted read and must report the outage, quoting the guard.
    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/could not read the UI tree/);
    expect(result.steps[0].reason).toMatch(/returned no windows for com\.example\.app/);
    expect(result.steps[0].reason).toMatch(/no window attached to read/);
  });
});
