import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { AXServiceApi, AXTreeResponse } from "../../src/blueprints/ax-service";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// The step outcomes of the launch pin across `tool:` steps, through the REAL
// fetchFlowTree -> queryIosSimulatorFlowTree and the real launch gate. The only
// seam is the ax-service: its tree names whichever app the dispatched tools
// last brought to the foreground. flow-launch-pins-tree-target.test.ts asserts
// the internal target each read carries; this file asserts what a step reports.
//
// Every app serves the `ready` marker, so a read fails only on the pin.

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const APP = "com.example.app";
const OTHER = "com.example.other";
const THIRD = "com.example.third";
const SPRINGBOARD = "com.apple.springboard";
let tmpDir: string;

function axTree(app: string): AXTreeResponse {
  return {
    alertVisible: false,
    screenFrame: { width: 402, height: 874 },
    nodes: [
      { index: 0, label: app, bundleId: app },
      {
        index: 1,
        parentIndex: 0,
        label: "Ready",
        identifier: "ready",
        traits: ["staticText"],
        frame: { x: 0, y: 0.5, width: 1, height: 0.1 },
      },
    ],
    truncated: false,
    foregroundApp: app,
    treeVersion: 2,
  };
}

/**
 * A simulator whose foreground app follows the tools the run dispatches:
 * `restart-app` (the launch step) and `launch-app` bring their app forward,
 * `button` goes home, and a `gesture-tap` opens `tapOpens` (a link into
 * another app).
 */
function simulator(tapOpens: string): Registry {
  let foreground = SPRINGBOARD;
  const ax = { degraded: false, tree: async () => axTree(foreground) };
  return {
    resolveService: async () => ax as unknown as AXServiceApi,
    invokeTool: async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "restart-app" || id === "launch-app") foreground = args.bundleId as string;
      else if (id === "button") foreground = SPRINGBOARD;
      else if (id === "gesture-tap") foreground = tapOpens;
      return { ok: true };
    },
    getTool: () => ({ inputSchema: { properties: { udid: {} } } }),
  } as unknown as Registry;
}

async function runFlow(
  steps: Parameters<typeof serializeFlow>[0]["steps"],
  tapOpens = OTHER
): Promise<FlowRunResult> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "flow.yaml"),
    serializeFlow({ executionPrerequisite: "", steps }),
    "utf8"
  );
  const r = await createRunFlowTool(simulator(tapOpens)).execute(
    {},
    { name: "flow", project_root: tmpDir, device: DEVICE }
  );
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

function statuses(result: FlowRunResult): string[] {
  return result.steps.map((s) => `${s.kind}:${s.status}`);
}

const ASSERT_READY = {
  kind: "assert",
  condition: "visible",
  selector: { identifier: "ready" },
} as const;
const TAP = { kind: "tap", x: 0.5, y: 0.5 } as const;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-tool-target-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("the launch pin across tool steps (end-to-end)", () => {
  it("fails a pinned read once another app is in the foreground", async () => {
    const result = await runFlow([{ kind: "launch", app: APP }, ASSERT_READY, TAP, ASSERT_READY]);

    expect(statuses(result)).toEqual(["launch:pass", "assert:pass", "tap:pass", "assert:fail"]);
    expect(result.steps[2].warning).toBeUndefined();
    expect(result.steps[3].reason).toMatch(/could not read the UI tree/);
    expect(result.steps[3].reason).toContain(
      `${APP} is not the foreground app on ${DEVICE} (${OTHER} is)`
    );
  });

  it("a tool step demotes the pin: the read passes, and the outage proved while pinned is retired", async () => {
    // The second tap's settle fails every pinned read, so it dispatches warned
    // and the run remembers the outage. The tool step must spend that memo, or
    // the tap after it would skip its settle and warn again.
    const result = await runFlow([
      { kind: "launch", app: APP },
      TAP,
      TAP,
      { kind: "tool", name: "screenshot", args: {} },
      TAP,
      ASSERT_READY,
    ]);

    expect(statuses(result)).toEqual([
      "launch:pass",
      "tap:pass",
      "tap:pass",
      "tool:pass",
      "tap:pass",
      "assert:pass",
    ]);
    expect(result.steps[2].warning).toMatch(/is not the foreground app/);
    expect(result.steps[4].warning).toBeUndefined();
  }, 20_000);

  it("drops the pin across a foreground-changing tool step", async () => {
    const result = await runFlow([
      { kind: "launch", app: APP },
      { kind: "tool", name: "button", args: { name: "home" } },
      ASSERT_READY,
    ]);

    expect(statuses(result)).toEqual(["launch:pass", "tool:pass", "assert:pass"]);
  });

  it("leaves the app a launch-app tool step started as an unpinned hint", async () => {
    // The first assert fails if the APP pin survived the tool step, the second
    // if launch-app re-pinned to OTHER: the tap brings a third app forward.
    const result = await runFlow(
      [
        { kind: "launch", app: APP },
        { kind: "tool", name: "launch-app", args: { bundleId: OTHER } },
        ASSERT_READY,
        TAP,
        ASSERT_READY,
      ],
      THIRD
    );

    expect(statuses(result)).toEqual([
      "launch:pass",
      "tool:pass",
      "assert:pass",
      "tap:pass",
      "assert:pass",
    ]);
  });
});
