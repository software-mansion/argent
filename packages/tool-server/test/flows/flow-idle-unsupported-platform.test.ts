import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";
import type { PixelFrame } from "../../src/tools/flows/flow-pixels";

// The status-bar mask asks the iOS runtime whether this UDID is a tvOS
// simulator. These ids are fabricated, so pin the probe to the mobile answer.
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));

// Real flow-tree exports (the guard reads `supportsFlowTree`'s own table), with
// `fetchFlowTree` counted so a test can prove the idle never polled it.
const reads: number[] = [];
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    reads.push(reads.length);
    return {
      tree: stillScreen(),
      source: "native-devtools",
      screen: { width: 390, height: 844 },
    };
  }),
}));

// Same for the pixel half of the idle's poll.
const captures: number[] = [];
vi.mock("../../src/tools/flows/flow-pixels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-pixels")>()),
  capturePixelsWithin: vi.fn(async (): Promise<PixelFrame | undefined> => {
    captures.push(captures.length);
    const data = Buffer.alloc(10 * 10 * 4, 120);
    return { width: 10, height: 10, data };
  }),
}));

import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

function stillScreen(): DescribeNode {
  return {
    role: "AXWindow",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [],
  };
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
    resolveService: vi.fn(async () => ({})),
  } as unknown as Registry;
}

let tmpDir: string;

async function writeIdleFlow(name: string): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "idle", timeout: 5000, stableFor: 0 },
        { kind: "echo", message: "after" },
      ],
    }),
    "utf8"
  );
}

async function run(name: string, device: string) {
  await writeIdleFlow(name);
  const tool = createRunFlowTool(mockRegistry());
  const result = await tool.execute({}, { name, project_root: tmpDir, device });
  if (!("steps" in result)) throw new Error("expected a run result");
  return result;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-idle-unsupported-"));
  reads.length = 0;
  captures.length = 0;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// `await: { idle: true }` judges the screen by two signals and one of them —
// the flow tree — does not exist on every platform. On harmony (and ios-remote)
// every read fails by construction, so the step used to spend its whole budget
// polling — on a real device each round also minted a STARTING → ERROR cycle
// against the SimulatorServer its capture resolves — before being scored
// never-judged with a remedy ("check the app is in the foreground") that no
// amount of foregrounding can satisfy where there is no source at all.
describe("await: { idle } on a platform with no flow tree source", () => {
  it("fails fast on harmony instead of polling to the timeout", async () => {
    const startedAt = Date.now();
    const r = await run("idle-harmony", "harmony-127.0.0.1:5555");
    const elapsed = Date.now() - startedAt;

    expect(r.ok).toBe(false);
    expect(r.steps[0]).toMatchObject({ kind: "idle", status: "error" });
    // A budget of 5000ms was refused in well under it.
    expect(elapsed).toBeLessThan(3_000);
    // It never polled either half.
    expect(reads).toHaveLength(0);
    expect(captures).toHaveLength(0);
    // And the reason is honest about why, with a remedy that can be followed:
    // no tree source exists, so stillness can never be judged — not an app to
    // foreground.
    expect(r.steps[0].reason).toContain("no UI-tree source");
    expect(r.steps[0].reason).toContain("`wait:`");
    expect(r.steps[0].reason).not.toContain("foreground");
    // An indeterminate readiness check stops the run rather than recording a
    // regression the app never had.
    expect(r.steps[1]).toMatchObject({ kind: "echo", status: "skip" });
  });

  it("fails fast on ios-remote too", async () => {
    const r = await run("idle-remote", "remote:00000000-0000-0000-0000-0000000000ab");

    expect(r.steps[0]).toMatchObject({ kind: "idle", status: "error" });
    expect(reads).toHaveLength(0);
    expect(captures).toHaveLength(0);
    expect(r.steps[0].reason).toContain("ios-remote");
  });

  it("leaves a supported platform's idle alone", async () => {
    const r = await run("idle-ios", "00000000-0000-0000-0000-0000000000ab");

    // Still screen, both halves answering: settles and passes, having read.
    expect(r.ok).toBe(true);
    expect(r.steps[0]).toMatchObject({ kind: "idle", status: "pass" });
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(captures.length).toBeGreaterThanOrEqual(3);
    expect(r.steps[1]).toMatchObject({ kind: "echo", status: "pass" });
  });
});
