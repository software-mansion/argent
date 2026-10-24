import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";
import type { PixelFrame } from "../../src/tools/flows/flow-pixels";

vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));

const reads: number[] = [];
// When set, every read throws it.
let treeError: string | undefined;
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    reads.push(reads.length);
    if (treeError !== undefined) throw new Error(treeError);
    return {
      tree: stillScreen(),
      source: "native-devtools",
      screen: { width: 390, height: 844 },
    };
  }),
}));

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
import { serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";

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

async function writeFlow(name: string, steps: FlowStep[]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({ executionPrerequisite: "", steps }),
    "utf8"
  );
}

async function writeIdleFlow(name: string): Promise<void> {
  await writeFlow(name, [
    { kind: "idle", timeout: 5000, stableFor: 0 },
    { kind: "echo", message: "after" },
  ]);
}

async function run(name: string, device: string, steps?: FlowStep[]) {
  if (steps) await writeFlow(name, steps);
  else await writeIdleFlow(name);
  const tool = createRunFlowTool(mockRegistry());
  const result = await tool.execute({}, { name, project_root: tmpDir, device });
  if (!("steps" in result)) throw new Error("expected a run result");
  return result;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-idle-unsupported-"));
  reads.length = 0;
  captures.length = 0;
  treeError = undefined;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("await: { idle } on a platform with no flow tree source", () => {
  it("fails fast on harmony instead of polling to the timeout", async () => {
    const startedAt = Date.now();
    const r = await run("idle-harmony", "harmony-127.0.0.1:5555");
    const elapsed = Date.now() - startedAt;

    expect(r.ok).toBe(false);
    expect(r.steps[0]).toMatchObject({ kind: "idle", status: "error" });
    expect(elapsed).toBeLessThan(3_000);
    expect(reads).toHaveLength(0);
    expect(captures).toHaveLength(0);
    expect(r.steps[0].reason).toContain("no UI-tree source");
    expect(r.steps[0].reason).toContain("`wait:`");
    expect(r.steps[0].reason).not.toContain("foreground");
    expect(r.steps[1]).toMatchObject({ kind: "echo", status: "skip" });
  });

  it("dispatches a coordinate tap on harmony without settling on a tree it cannot read", async () => {
    const r = await run("tap-harmony", "harmony-127.0.0.1:5555", [{ kind: "tap", x: 0.5, y: 0.5 }]);

    expect(r.steps[0]).toMatchObject({ kind: "tap", status: "pass" });
    expect(r.steps[0]).not.toHaveProperty("warning");
    expect(reads).toHaveLength(0);
  });

  it("leaves a supported platform's idle alone", async () => {
    const r = await run("idle-ios", "00000000-0000-0000-0000-0000000000ab");

    expect(r.ok).toBe(true);
    expect(r.steps[0]).toMatchObject({ kind: "idle", status: "pass" });
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(captures.length).toBeGreaterThanOrEqual(3);
    expect(r.steps[1]).toMatchObject({ kind: "echo", status: "pass" });
  });
});

// Besides `idle`, only `await`/`assert` report an unreadable tree as
// `indeterminate` instead of throwing, so only they reach the platform arm.
describe("an indeterminate selector check on a platform with no flow tree source", () => {
  const HARMONY = "harmony-127.0.0.1:5555";
  const IOS = "00000000-0000-0000-0000-0000000000ab";
  const STEPS: FlowStep[] = [
    { kind: "await", condition: "visible", selector: { text: "Continue" }, timeout: 300 },
    { kind: "assert", condition: "visible", selector: { text: "Continue" } },
  ];

  for (const step of STEPS) {
    it(`scores \`${step.kind}\` an error on harmony, where the app was never judged`, async () => {
      treeError = "ui-tree matching is not supported on platform harmony";
      const r = await run(`${step.kind}-harmony`, HARMONY, [step]);

      expect(r.ok).toBe(false);
      expect(r.steps[0]).toMatchObject({ kind: step.kind, status: "error" });
      expect(r.steps[0].reason).toContain("could not read the UI tree");
    });

    it(`scores \`${step.kind}\` a fail on a platform with a tree source`, async () => {
      treeError = "native devtools is unavailable";
      const r = await run(`${step.kind}-ios`, IOS, [step]);

      expect(r.ok).toBe(false);
      expect(r.steps[0]).toMatchObject({ kind: step.kind, status: "fail" });
      expect(r.steps[0].reason).toContain("could not read the UI tree");
    });
  }
});
