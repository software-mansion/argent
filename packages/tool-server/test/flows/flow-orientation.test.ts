import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// A flow on a landscape UI (a rotated iPhone, an unfolded foldable) reads a
// tree the adapter has already turned into the UI's upright space
// (`flow-ios-tree.ts`), and hands its gestures to the tools in that space,
// which `sendCommand` turns into the native one. So the flow itself turns
// nothing: these tests serve an upright landscape tree and watch what the
// gestures dispatch.
let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => ({
    tree: currentTree(),
    source: "native-devtools",
  })),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { nativeFrameToUi, uiPointToNative } from "../../src/utils/ui-orientation";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import { n, screen } from "./harness";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";

describe("ui-orientation geometry", () => {
  it("turns UI points into the native space as measured on the simulator", () => {
    // Unfolded Duo (landscapeLeft): the UI's top-centre is the panel's left
    // edge, mid-height; its bottom-right corner is the panel's top-right one.
    expect(uiPointToNative({ x: 0.5, y: 0 }, "landscapeLeft")).toEqual({ x: 0, y: 0.5 });
    expect(uiPointToNative({ x: 1, y: 1 }, "landscapeLeft")).toEqual({ x: 1, y: 0 });
    // An iPhone in landscapeRight (home side on the right): the mirror image.
    expect(uiPointToNative({ x: 0.5, y: 0 }, "landscapeRight")).toEqual({ x: 1, y: 0.5 });
    expect(uiPointToNative({ x: 1, y: 1 }, "landscapeRight")).toEqual({ x: 0, y: 1 });
    expect(uiPointToNative({ x: 0.25, y: 0.75 }, "portraitUpsideDown")).toEqual({
      x: 0.75,
      y: 0.25,
    });
    expect(uiPointToNative({ x: 0.2, y: 0.9 }, "portrait")).toEqual({ x: 0.2, y: 0.9 });
    expect(uiPointToNative({ x: 0.2, y: 0.9 }, undefined)).toEqual({ x: 0.2, y: 0.9 });
  });

  it("turns a native-space frame back into the UI's space, corner for corner", () => {
    const frame = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    const corners = (f: typeof frame) => [
      { x: f.x, y: f.y },
      { x: f.x + f.width, y: f.y },
      { x: f.x, y: f.y + f.height },
      { x: f.x + f.width, y: f.y + f.height },
    ];
    const key = (p: { x: number; y: number }) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    for (const orientation of [
      "landscapeLeft",
      "landscapeRight",
      "portraitUpsideDown",
      "portrait",
      undefined,
    ] as const) {
      const ui = nativeFrameToUi(frame, orientation);
      expect(ui.width).toBeGreaterThan(0);
      expect(ui.height).toBeGreaterThan(0);
      // The UI frame's corners, sent where touches go, are the native frame's.
      const back = corners(ui).map((c) => key(uiPointToNative(c, orientation)));
      expect(back.sort()).toEqual(corners(frame).map(key).sort());
    }
    // Unfolded Duo: a strip down the panel's left edge is the top row of the UI.
    expect(nativeFrameToUi({ x: 0, y: 0.1, width: 0.05, height: 0.8 }, "landscapeLeft")).toEqual({
      x: expect.closeTo(0.1, 10),
      y: 0,
      width: 0.8,
      height: 0.05,
    });
    expect(nativeFrameToUi(frame, undefined)).toBe(frame);
  });

  it("turns two frames that share an edge onto the same edge, free of float noise", () => {
    // 1 - 0.1 - 0.3 and 1 - 0.3 - 0.1 differ in the last place in floating
    // point; reading order compares exactly, so a tie between a container and
    // its flush label must stay a tie for the area rule to decide.
    // The label sits flush in the container's bottom-right corner.
    const container = { x: 0.2, y: 0.1, width: 0.5, height: 0.3 };
    const label = { x: 0.6, y: 0.3, width: 0.1, height: 0.1 };
    expect(1 - container.y - container.height).not.toBe(1 - label.y - label.height);
    for (const orientation of ["landscapeLeft", "landscapeRight", "portraitUpsideDown"] as const) {
      const a = nativeFrameToUi(container, orientation);
      const b = nativeFrameToUi(label, orientation);
      const edge = orientation === "landscapeLeft" ? "x" : "y";
      expect(a[edge]).toBe(b[edge]);
      if (orientation === "portraitUpsideDown") expect(a.x).toBe(b.x);
    }
  });
});

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

function mockRegistry(
  calls: ToolCall[],
  onSwipe?: () => void,
  onTool?: (id: string) => void
): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      calls.push({ tool: id, args });
      if (id === "gesture-swipe") onSwipe?.();
      onTool?.(id);
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

let tmpDir: string;

async function runFlow(
  steps: Parameters<typeof serializeFlow>[0]["steps"],
  onSwipe?: () => void,
  onTool?: (id: string) => void
): Promise<{ result: FlowRunResult; calls: ToolCall[] }> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "turned.yaml"),
    serializeFlow({ executionPrerequisite: "", steps }),
    "utf8"
  );
  const calls: ToolCall[] = [];
  const tool = createRunFlowTool(mockRegistry(calls, onSwipe, onTool));
  const result = await tool.execute({}, { name: "turned", project_root: tmpDir, device: DEVICE });
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return { result, calls };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-orientation-"));
  currentTree = () => screen([]);
});

describe("a flow on a landscape UI", () => {
  it("sends a direction's preset as the user sees it", async () => {
    const { result, calls } = await runFlow([
      { kind: "swipe", direction: "down" },
      { kind: "swipe", direction: "left" },
    ]);
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([
      { udid: DEVICE, fromX: 0.5, fromY: 0.2, toX: 0.5, toY: 0.9 },
      { udid: DEVICE, fromX: 0.9, fromY: 0.5, toX: expect.closeTo(0.1, 10), toY: 0.5 },
    ]);
  });

  // Two rows of two buttons, as the user sees them on a landscape UI: Ask and
  // Fetch on the first row, Echo and Reset on the second.
  const buttons = {
    ask: { x: 0.05, y: 0.2, width: 0.4, height: 0.05 },
    fetch: { x: 0.55, y: 0.2, width: 0.4, height: 0.05 },
    echo: { x: 0.05, y: 0.3, width: 0.4, height: 0.05 },
    reset: { x: 0.55, y: 0.3, width: 0.4, height: 0.05 },
  };

  it("resolves the user's reading order and taps the upright centre", async () => {
    currentTree = () =>
      screen(
        Object.entries(buttons).map(([id, frame]) =>
          n({ role: "AXButton", identifier: `probe.${id}`, frame })
        )
      );
    const { result, calls } = await runFlow([
      {
        kind: "assert",
        condition: "visible",
        selector: { identifier: "probe.fetch", next: { identifier: "probe.ask" } },
      },
      {
        kind: "assert",
        condition: "visible",
        selector: { identifier: "probe.reset", after: { identifier: "probe.ask" } },
      },
      { kind: "tap", selector: { any: true, next: { identifier: "probe.ask" } } },
    ]);
    expect(result.steps.map((s) => s.status)).toEqual(["pass", "pass", "pass"]);
    expect(calls.at(-1)).toEqual({
      tool: "gesture-tap",
      args: {
        udid: DEVICE,
        x: expect.closeTo(buttons.fetch.x + buttons.fetch.width / 2, 10),
        y: expect.closeTo(buttons.fetch.y + buttons.fetch.height / 2, 10),
      },
    });
  });
});
