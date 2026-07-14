import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// The scroll/settle loop reads the flow tree, so it is driven by stubbing the
// tree fetch itself (flows hard-fail rather than degrade to the AX tree). The
// mock returns a scripted tree per call; `revealTarget()` flips it to a screen
// where the target is visible (simulating a scroll bringing it on-screen).
let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "native-devtools",
    })
  ),
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

interface SwipeCall {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  settle: unknown;
}

function mockRegistry(swipes: SwipeCall[], onSwipe?: () => void): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "gesture-swipe") {
        swipes.push({
          fromX: args.fromX as number,
          fromY: args.fromY as number,
          toX: args.toX as number,
          toY: args.toY as number,
          settle: args.settle,
        });
        onSwipe?.();
        return { swiped: true };
      }
      return { ok: true };
    }),
    // Declare a udid input on gesture-swipe so bindDeviceArgs injects the device.
    getTool: vi.fn((id: string) =>
      id === "gesture-swipe" ? { inputSchema: { properties: { udid: {} } } } : undefined
    ),
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-scroll-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("scroll-to directive", () => {
  it("scrolls momentum-free until the target is visible, then passes", async () => {
    const offscreen = screen([
      n({ label: "Top", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
    ]);
    const withTarget = screen([
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.1 } }),
    ]);
    let revealed = false;
    currentTree = () => (revealed ? withTarget : offscreen);

    const swipes: SwipeCall[] = [];
    // After the first scroll increment, the target comes into view.
    const registry = mockRegistry(swipes, () => {
      revealed = true;
    });

    await writeFlow("scroller", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "scroller", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["scroll-to:pass"]);
    // Exactly one increment, momentum-free, finger travelling UP (reveal below).
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromY).toBeGreaterThan(swipes[0].toY);
  });

  it("returns immediately without scrolling when the target is already visible", async () => {
    currentTree = () =>
      screen([n({ label: "Account", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } })]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("present", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Account" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "present", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(swipes).toHaveLength(0);
  });

  it("accepts a full-screen target immediately, despite a ticking in-region label", async () => {
    // A target as tall as the screen can never fit both edges strictly inside
    // the clip — its extent equals the clip's — so full containment is
    // arithmetically unsatisfiable and only the spanning shape can accept it.
    // The ticking label defeats the end-of-scroll fingerprint fallback (no two
    // settled trees match), proving the zero-swipe acceptance comes from the
    // axis check itself; without the spanning shape this conjunction would
    // burn all MAX_SCROLL_ITERATIONS on a target visible the whole time.
    let reads = 0;
    currentTree = () => {
      reads++;
      return screen([
        n({ label: "Order form", frame: { x: 0, y: 0, width: 1, height: 1 } }),
        // Ticks every other read: each settle sees a stable pair, but no two
        // settled trees share the ticker's label (a ~1Hz clock, effectively).
        n({
          label: `elapsed ${Math.floor(reads / 2)}s`,
          frame: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 },
        }),
      ]);
    };

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("fullscreen", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order form" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "fullscreen", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
  });

  it("scrolls a target taller than its `within` clip until it spans the clip, then accepts", async () => {
    // A 0.4-tall card inside a 0.3-tall pane can never fit both edges inside
    // the clip. It must still be scrolled TOWARD: absent → partially entered
    // (covering neither clip edge — not accepted yet) → spanning the whole
    // pane, at which point no further scroll can reveal more of it.
    const pane = () => n({ identifier: "pane", frame: { x: 0, y: 0.3, width: 1, height: 0.3 } });
    let scrolled = 0;
    currentTree = () => {
      const card =
        scrolled >= 2
          ? [n({ label: "Tall card", frame: { x: 0.1, y: 0.25, width: 0.8, height: 0.4 } })] // spans 0.3..0.6
          : scrolled === 1
            ? [n({ label: "Tall card", frame: { x: 0.1, y: 0.55, width: 0.8, height: 0.4 } })] // entered, not spanning
            : []; // still off-screen
      return screen([pane(), ...card]);
    };

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      scrolled++;
    });

    await writeFlow("tall-card", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "scroll-to",
          target: { text: "Tall card" },
          direction: "down",
          within: { identifier: "pane" },
        },
      ],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "tall-card", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    // Two increments: one to bring it on, one more until it spans the pane.
    expect(swipes).toHaveLength(2);
  });

  it("still scrolls a smaller-than-clip target that is only half inside the clip", async () => {
    // Regression guard for the spanning acceptance: a small row hanging out of
    // the pane's bottom covers neither clip edge and isn't fully contained
    // either — it must still be scrolled until fully inside, so a following
    // tap doesn't land on a clipped sliver.
    const pane = () => n({ identifier: "pane", frame: { x: 0, y: 0.3, width: 1, height: 0.3 } });
    let scrolled = false;
    currentTree = () =>
      screen([
        pane(),
        scrolled
          ? n({ label: "Row 5", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } })
          : // bottom half outside the pane (0.55..0.65 vs clip bottom 0.6)
            n({ label: "Row 5", frame: { x: 0.1, y: 0.55, width: 0.8, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      scrolled = true;
    });

    await writeFlow("half-visible", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "scroll-to",
          target: { text: "Row 5" },
          direction: "down",
          within: { identifier: "pane" },
        },
      ],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "half-visible", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
  });

  it("keeps scrolling a target flush at the viewport edge until it clears the fold", async () => {
    // Every adapter clips a partly-scrolled element's frame to the viewport, so a
    // half-revealed row sits flush against the entry edge (bottom, here) — its
    // frame is in-bounds and indistinguishable from fully-visible by area. The
    // axis check treats "flush at the bottom" as clipped and keeps scrolling
    // until the frame clears the edge, so a following tap doesn't hit a sliver.
    const flush = screen([
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.9, width: 0.8, height: 0.1 } }), // y+h = 1.0
    ]);
    const cleared = screen([
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.1 } }),
    ]);
    let scrolled = false;
    currentTree = () => (scrolled ? cleared : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      scrolled = true;
    });

    await writeFlow("flush", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "flush", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    // One increment: the flush first read didn't satisfy the axis check.
    expect(swipes).toHaveLength(1);
  });

  it("accepts a last item flush at the far edge once the scroll hits its end", async () => {
    // The LAST item sits flush against the container's far edge at max scroll —
    // the axis check can never clear its entry edge. Since the tree stops
    // changing (no progress), it's genuinely fully revealed, so it's accepted
    // wherever it landed rather than looping/failing forever.
    currentTree = () =>
      screen([n({ label: "Bottom row 8", frame: { x: 0.1, y: 0.9, width: 0.8, height: 0.1 } })]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("last-item", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Bottom row 8" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "last-item", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    // One increment attempted, then the no-progress check accepted it.
    expect(swipes).toHaveLength(1);
  });

  it("sizes the increment to the within container, not the screen", async () => {
    // A carousel 0.3 of the screen wide: a half-SCREEN increment would move
    // ~1.7 container-widths per step, so consecutive container-viewports
    // wouldn't overlap and a narrow card could be scrolled fully past between
    // settle checkpoints. The increment must be half the CONTAINER's extent
    // along the scroll axis (0.15 here) so the views always overlap.
    const carousel = (children: DescribeNode[]) =>
      n({
        identifier: "carousel",
        frame: { x: 0.1, y: 0.4, width: 0.3, height: 0.2 },
        children,
      });
    const before = screen([
      carousel([n({ label: "Card 1", frame: { x: 0.12, y: 0.45, width: 0.1, height: 0.1 } })]),
    ]);
    const after = screen([
      carousel([n({ label: "Card 7", frame: { x: 0.15, y: 0.45, width: 0.1, height: 0.1 } })]),
    ]);
    let scrolled = false;
    currentTree = () => (scrolled ? after : before);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      scrolled = true;
    });

    await writeFlow("carousel", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "scroll-to",
          target: { text: "Card 7" },
          direction: "right",
          within: { identifier: "carousel" },
        },
      ],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "carousel", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(swipes).toHaveLength(1);
    // Anchored at the container's center, travelling left to reveal content on
    // the right, by half the container's width — not half the screen.
    expect(swipes[0].fromX).toBeCloseTo(0.25, 5);
    expect(swipes[0].fromX - swipes[0].toX).toBeCloseTo(0.15, 5);
  });

  it("floors the increment so a sliver container still registers a scroll", async () => {
    // Half of a 0.04-tall container would be a 0.02 travel — tap-slop
    // territory. The floor (0.05) keeps the gesture recognizable as a scroll.
    const strip = (children: DescribeNode[]) =>
      n({
        identifier: "strip",
        frame: { x: 0, y: 0.5, width: 1, height: 0.04 },
        children,
      });
    const before = screen([
      strip([n({ label: "Row 1", frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.04 } })]),
    ]);
    const after = screen([
      strip([n({ label: "Row 9", frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.03 } })]),
    ]);
    let scrolled = false;
    currentTree = () => (scrolled ? after : before);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      scrolled = true;
    });

    await writeFlow("sliver", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "scroll-to",
          target: { text: "Row 9" },
          direction: "down",
          within: { identifier: "strip" },
        },
      ],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "sliver", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(swipes).toHaveLength(1);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.05, 5);
  });

  it("detects the end of the scroll despite an animating node outside the container", async () => {
    // A live ticker outside the `within` container mutates its label between
    // settles. The end-of-scroll check fingerprints only the container's
    // region, so the stuck scroller is still detected; a whole-tree fingerprint
    // would never repeat and the loop would burn all MAX_SCROLL_ITERATIONS
    // before failing with a misleading "not found after N attempts".
    let reads = 0;
    currentTree = () => {
      reads++;
      return screen([
        // Ticks every other read: each settle sees a stable pair, but no two
        // settled trees share the ticker's label (a ~1Hz clock, effectively).
        n({
          label: `elapsed ${Math.floor(reads / 2)}s`,
          frame: { x: 0.1, y: 0.05, width: 0.3, height: 0.05 },
        }),
        n({
          identifier: "list",
          frame: { x: 0, y: 0.2, width: 1, height: 0.6 },
          children: [n({ label: "Only row", frame: { x: 0.1, y: 0.25, width: 0.8, height: 0.1 } })],
        }),
      ]);
    };

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("ticker", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "scroll-to",
          target: { text: "Never There" },
          direction: "down",
          within: { identifier: "list" },
        },
      ],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "ticker", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toContain("reached the end of the scroll");
    // One increment was attempted before the no-progress check stopped it.
    expect(swipes).toHaveLength(1);
  });

  it("finds a flush last item without `within` despite a screen-level ticking clock", async () => {
    // The no-`within` counterpart of the ticker test above: the fingerprint
    // must not scope to the whole screen just because no container was named.
    // The gesture anchors at the screen centre, so the scope is the scroll
    // container hit-tested there — the clock above it can tick freely without
    // masking end-of-scroll. The target sits flush against the screen bottom on
    // every read (the last item at max scroll), so the axis check can never
    // clear its entry edge and only end-of-scroll detection can accept it; a
    // whole-screen fingerprint would never repeat and the loop would burn all
    // MAX_SCROLL_ITERATIONS before failing "not found" on a visible element.
    let reads = 0;
    currentTree = () => {
      reads++;
      return screen([
        // Ticks every other read: each settle sees a stable pair, but no two
        // settled trees share the clock's label (a ~1Hz clock, effectively).
        n({
          label: `12:0${Math.floor(reads / 2)}`,
          frame: { x: 0.4, y: 0.02, width: 0.2, height: 0.05 },
        }),
        // The scroll container under the anchor (0.5, 0.5) — flat-leaf shape,
        // like the flow tree adapters emit (rows are siblings, not children).
        n({ role: "AXScrollArea", frame: { x: 0, y: 0.1, width: 1, height: 0.9 } }),
        n({ label: "Bottom row", frame: { x: 0.1, y: 0.9, width: 0.8, height: 0.1 } }),
      ]);
    };

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("clocked-last-item", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Bottom row" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "clocked-last-item", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    // One increment attempted, then the scoped no-progress check accepted it.
    expect(swipes).toHaveLength(1);
  });

  it("keeps scrolling when only an outer scroller progresses past a static inner scrollable at the anchor", async () => {
    // A horizontal carousel sits exactly under the swipe anchor but doesn't
    // move for a vertical scroll — the gesture lands in the outer scroller. The
    // no-`within` fingerprint scopes to ALL scroll containers under the anchor,
    // so the outer scroller's real progress is seen; scoping to the innermost
    // alone would fingerprint only the static carousel and misread round two as
    // end-of-scroll, failing on a reachable target.
    let scrolled = 0;
    currentTree = () => {
      const rows =
        scrolled >= 2
          ? [n({ label: "Order #99", frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.1 } })]
          : [
              n({
                label: `Row ${scrolled + 3}`,
                frame: { x: 0.1, y: 0.7, width: 0.8, height: 0.1 },
              }),
            ];
      return screen([
        n({ role: "AXScrollArea", frame: { x: 0, y: 0.1, width: 1, height: 0.9 } }),
        n({
          role: "AXScrollArea",
          identifier: "carousel",
          frame: { x: 0.2, y: 0.45, width: 0.6, height: 0.1 },
        }),
        n({ label: "Card A", frame: { x: 0.25, y: 0.47, width: 0.1, height: 0.06 } }),
        ...rows,
      ]);
    };

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      scrolled++;
    });

    await writeFlow("nested-scrollers", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #99" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "nested-scrollers", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    // Two increments of real progress — neither misread as end-of-scroll.
    expect(swipes).toHaveLength(2);
  });

  it("fails with a no-progress reason when scrolling reveals nothing new", async () => {
    // The tree never changes, so the second settled read equals the first.
    currentTree = () =>
      screen([n({ label: "Only row", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } })]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("stuck", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Never There" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "stuck", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toContain("reached the end of the scroll");
    // One increment was attempted before the no-progress check stopped it.
    expect(swipes).toHaveLength(1);
  });
});
