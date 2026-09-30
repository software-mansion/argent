import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type {
  DescribeNode,
  DescribeTreeData,
  UiOrientation,
} from "../../src/tools/describe/contract";

// A flow's directions are the UI's, its frames and touches the screen's fixed
// space; on a landscape UI (a rotated iPhone, an unfolded foldable) the two
// differ by a rotation the tree adapter reports. These tests serve the tree
// with that report and watch what the gestures dispatch.
let currentTree: () => DescribeNode;
let currentOrientation: UiOrientation | undefined;
/** The tree source stops answering: every read throws. */
let treeDown = false;
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    if (treeDown) throw new Error("tree source down");
    return {
      tree: currentTree(),
      source: "native-devtools",
      ...(currentOrientation ? { uiOrientation: currentOrientation } : {}),
    };
  }),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import {
  nativeDirection,
  nativeFrameToUi,
  uiPointToNative,
  uiVectorToNative,
} from "../../src/tools/flows/flow-orientation";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import { n, screen } from "./harness";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";

describe("flow-orientation geometry", () => {
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

  it("turns UI displacements the same way, without the offsets", () => {
    expect(uiVectorToNative({ x: 0, y: 0.7 }, "landscapeLeft")).toEqual({ x: 0.7, y: -0 });
    expect(uiVectorToNative({ x: 0.7, y: 0 }, "landscapeLeft")).toEqual({ x: 0, y: -0.7 });
    expect(uiVectorToNative({ x: 0, y: 0.7 }, "landscapeRight")).toEqual({ x: -0.7, y: 0 });
    expect(uiVectorToNative({ x: 0.7, y: 0 }, "portraitUpsideDown")).toEqual({ x: -0.7, y: -0 });
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

  it("names the native direction a UI direction becomes", () => {
    expect(nativeDirection("down", undefined)).toBe("down");
    expect(nativeDirection("down", "landscapeLeft")).toBe("right");
    expect(nativeDirection("up", "landscapeLeft")).toBe("left");
    expect(nativeDirection("right", "landscapeLeft")).toBe("up");
    expect(nativeDirection("left", "landscapeLeft")).toBe("down");
    expect(nativeDirection("down", "landscapeRight")).toBe("left");
    expect(nativeDirection("right", "landscapeRight")).toBe("down");
    expect(nativeDirection("down", "portraitUpsideDown")).toBe("up");
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
  currentOrientation = undefined;
  treeDown = false;
});

describe("swipe on a landscape UI", () => {
  it("moves the finger along the UI's axis, in the frame space", async () => {
    // Unfolded Duo: UI `down` is the panel's +x. The preset's UI-space start
    // (0.5, 0.2) and end (0.5, 0.9) land where they are on the panel.
    currentOrientation = "landscapeLeft";
    const { result, calls } = await runFlow([
      { kind: "swipe", direction: "down" },
      { kind: "swipe", direction: "left" },
    ]);
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([
      { udid: DEVICE, fromX: 0.2, fromY: 0.5, toX: 0.9, toY: 0.5 },
      { udid: DEVICE, fromX: 0.5, fromY: expect.closeTo(0.1, 10), toX: 0.5, toY: 0.9 },
    ]);
  });

  it("mirrors for the other landscape", async () => {
    currentOrientation = "landscapeRight";
    const { calls } = await runFlow([{ kind: "swipe", direction: "down" }]);
    expect(calls[0]!.args).toEqual({
      udid: DEVICE,
      fromX: 0.8,
      fromY: 0.5,
      toX: expect.closeTo(0.1, 10),
      toY: 0.5,
    });
  });

  it("travels the preset's magnitude from an anchor, along the turned axis", async () => {
    currentOrientation = "landscapeLeft";
    currentTree = () =>
      screen([n({ label: "Card", frame: { x: 0.4, y: 0.1, width: 0.2, height: 0.1 } })]);
    const { calls } = await runFlow([
      { kind: "swipe", from: { selector: { text: "Card", loose: true } }, direction: "left" },
    ]);
    // UI `left` is the panel's +y: the finger goes down from the card's centre
    // (0.5, 0.15) by the preset's 0.8, clamped at the edge.
    expect(calls[0]!.args).toEqual({
      udid: DEVICE,
      fromX: 0.5,
      fromY: expect.closeTo(0.15, 10),
      toX: 0.5,
      toY: expect.closeTo(0.95, 10),
    });
  });

  it("dispatches the portrait geometry unchanged when the adapter reports nothing", async () => {
    const { calls } = await runFlow([{ kind: "swipe", direction: "down" }]);
    expect(calls[0]!.args).toEqual({ udid: DEVICE, fromX: 0.5, fromY: 0.2, toX: 0.5, toY: 0.9 });
  });
});

describe("a direction after the UI may have turned", () => {
  // Unfolded (landscape), then folded closed (portrait), and the tree source
  // goes down with the fold: no read says how the UI lies now.
  it("is not turned by the orientation read before a fold", async () => {
    currentOrientation = "landscapeLeft";
    const { result, calls } = await runFlow(
      [
        { kind: "swipe", direction: "down" },
        { kind: "fold", posture: "closed" },
        { kind: "swipe", direction: "down" },
      ],
      undefined,
      (id) => {
        if (id === "fold") treeDown = true;
      }
    );
    const swipes = calls.filter((c) => c.tool === "gesture-swipe").map((c) => c.args);
    // Landscape before the fold: UI `down` is the panel's +x.
    expect(swipes[0]).toMatchObject({ fromX: 0.2, fromY: 0.5, toX: 0.9, toY: 0.5 });
    // After it, the direction is not turned by the stale landscape.
    expect(swipes[1]).toMatchObject({ fromX: 0.5, fromY: 0.2, toX: 0.5, toY: 0.9 });
    const after = result.steps[2]!;
    expect(after.status).toBe("pass");
    expect(after.warning).toContain("No read reported the UI's orientation");
  }, 30_000);

  it("is not turned by the orientation read before a raw rotate step either", async () => {
    currentOrientation = "landscapeRight";
    const { calls } = await runFlow(
      [
        { kind: "swipe", direction: "down" },
        { kind: "tool", name: "rotate", args: { orientation: "Portrait" } },
        { kind: "swipe", direction: "down" },
      ],
      undefined,
      (id) => {
        if (id === "rotate") treeDown = true;
      }
    );
    const swipes = calls.filter((c) => c.tool === "gesture-swipe").map((c) => c.args);
    expect(swipes[1]).toMatchObject({ fromX: 0.5, fromY: 0.2, toX: 0.5, toY: 0.9 });
  }, 30_000);

  it("names the older orientation it turned by when the tree cannot be read", async () => {
    currentOrientation = "landscapeLeft";
    let swiped = 0;
    const { result, calls } = await runFlow(
      [
        { kind: "swipe", direction: "down" },
        { kind: "swipe", direction: "down" },
      ],
      () => {
        swiped += 1;
        if (swiped === 1) treeDown = true;
      }
    );
    const swipes = calls.filter((c) => c.tool === "gesture-swipe").map((c) => c.args);
    // Nothing turned the UI in between, so the earlier read still stands...
    expect(swipes[1]).toMatchObject({ fromX: 0.2, toX: 0.9 });
    // ...and the step says it had nothing newer.
    expect(result.steps[1]!.warning).toContain("an earlier read reported (landscapeLeft)");
  }, 30_000);
});

describe("relational selectors on a landscape UI", () => {
  // Two rows of two buttons, as the user sees them: Ask and Fetch on the
  // first row, Echo and Reset on the second. `next: { id: ask }` is Fetch —
  // the same row, to the right — whichever way the UI lies on the panel.
  const uiButtons = {
    ask: { x: 0.05, y: 0.2, width: 0.4, height: 0.05 },
    fetch: { x: 0.55, y: 0.2, width: 0.4, height: 0.05 },
    echo: { x: 0.05, y: 0.3, width: 0.4, height: 0.05 },
    reset: { x: 0.55, y: 0.3, width: 0.4, height: 0.05 },
  };
  /** Where the frame space has a UI-space frame: the inverse of `nativeFrameToUi`. */
  const toNative = (
    f: { x: number; y: number; width: number; height: number },
    o: "landscapeLeft" | "landscapeRight"
  ) =>
    o === "landscapeRight"
      ? { x: 1 - f.y - f.height, y: f.x, width: f.height, height: f.width }
      : { x: f.y, y: 1 - f.x - f.width, width: f.height, height: f.width };
  const turned = (o: "landscapeLeft" | "landscapeRight") =>
    screen(
      Object.entries(uiButtons).map(([id, f]) =>
        n({ role: "AXButton", identifier: `probe.${id}`, frame: toNative(f, o) })
      )
    );

  it.each(["landscapeLeft", "landscapeRight"] as const)(
    "resolve in the user's reading order in %s, and tap where the panel has the element",
    async (o) => {
      currentOrientation = o;
      currentTree = () => turned(o);
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
      const fetch = toNative(uiButtons.fetch, o);
      expect(calls.at(-1)).toEqual({
        tool: "gesture-tap",
        args: {
          udid: DEVICE,
          x: expect.closeTo(fetch.x + fetch.width / 2, 10),
          y: expect.closeTo(fetch.y + fetch.height / 2, 10),
        },
      });
    }
  );

  it("would follow the panel's order — another row — without the reported orientation", async () => {
    // The tree of an unfolded Duo served by a framework that reports no
    // orientation: what the fix is for. Echo, not Fetch, follows Ask on the
    // panel, and the assert says so.
    currentOrientation = undefined;
    currentTree = () => turned("landscapeLeft");
    const { result } = await runFlow([
      {
        kind: "assert",
        condition: "visible",
        selector: { identifier: "probe.fetch", next: { identifier: "probe.ask" } },
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.steps[0]!.reason).toContain("no element matched");
  });
});

describe("scroll-to on a landscape UI", () => {
  it("scrolls along the UI's axis and checks the target against the turned axis", async () => {
    currentOrientation = "landscapeLeft";
    // Off-screen at first; the first increment reveals it, flush against the
    // frame-space edge that UI `down` reveals from (+x, the right edge).
    let revealed = false;
    currentTree = () =>
      revealed
        ? screen([n({ label: "Order", frame: { x: 0.5, y: 0.4, width: 0.3, height: 0.1 } })])
        : screen([n({ label: "Top", frame: { x: 0.1, y: 0.4, width: 0.2, height: 0.1 } })]);
    const { result, calls } = await runFlow(
      [{ kind: "scroll-to", target: { text: "Order" }, direction: "down" }],
      () => {
        revealed = true;
      }
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const swipe = calls[0]!.args;
    // Revealing what is below in the UI moves the finger towards the panel's
    // -x: a horizontal, momentum-free travel in the frame space.
    expect(swipe.momentum).toBe(false);
    expect(swipe.fromY).toBe(swipe.toY);
    expect(swipe.fromX as number).toBeGreaterThan(swipe.toX as number);
  });

  it("accepts a target already inside the clip along the turned axis without scrolling", async () => {
    currentOrientation = "landscapeLeft";
    currentTree = () =>
      screen([n({ label: "Order", frame: { x: 0.3, y: 0.4, width: 0.3, height: 0.1 } })]);
    const { result, calls } = await runFlow([
      { kind: "scroll-to", target: { text: "Order" }, direction: "down" },
    ]);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
