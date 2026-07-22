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
const CHROMIUM_DEVICE = "chromium-cdp-9222"; // chromium id shape → wheel-scroll path
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

interface ScrollCall {
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
}

function mockRegistry(
  swipes: SwipeCall[],
  onGesture?: () => void,
  scrolls?: ScrollCall[]
): Registry {
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
        onGesture?.();
        return { swiped: true };
      }
      // The chromium wheel path (see scrollIncrement) — recorded separately.
      if (id === "gesture-scroll") {
        scrolls?.push({
          x: args.x as number,
          y: args.y as number,
          deltaX: args.deltaX as number | undefined,
          deltaY: args.deltaY as number | undefined,
        });
        onGesture?.();
        return { scrolled: true };
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

  it("nudges an already-visible target clear of a flush screen-edge landing", async () => {
    // Fully inside the viewport at 0.87..0.97 — accepted by the axis check —
    // but only 0.03 from the screen bottom, i.e. under home-indicator / tab-bar
    // territory. One same-direction nudge sized to 1.5× the 0.07 deficit moves
    // it clear; the second round sees enough clearance and stops.
    const flush = screen([
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.75, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("edge-nudge", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "edge-nudge", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    // Momentum-free, deficit-sized (0.07 × 1.5), anchored at the screen centre.
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromY).toBeCloseTo(0.5, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.105, 5);
  });

  it("scrolls a target into view, then nudges its flush landing off the screen edge", async () => {
    // The end-to-end shape: a half-screen increment reveals the target flush at
    // the bottom (0.88..0.98), then a small nudge lifts it to padding. The two
    // gestures are distinguishable by travel: 0.5 reveal vs 0.12 nudge.
    let phase = 0;
    currentTree = () =>
      phase === 0
        ? screen([n({ label: "Top", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })])
        : phase === 1
          ? screen([
              n({ label: "Order #1234", frame: { x: 0.1, y: 0.88, width: 0.8, height: 0.1 } }),
            ])
          : screen([
              n({ label: "Order #1234", frame: { x: 0.1, y: 0.7, width: 0.8, height: 0.1 } }),
            ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      phase++;
    });

    await writeFlow("reveal-nudge", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "reveal-nudge", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(2);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.5, 5);
    expect(swipes[1].fromY - swipes[1].toY).toBeCloseTo(0.12, 5);
  });

  it("accepts the flush landing when the nudge reveals nothing (end of scroll)", async () => {
    // The target is the last element: it sits 0.02 from the screen bottom and
    // the container can't move. The nudge is attempted once, the settled tree
    // repeats, and the end-of-scroll fingerprint accepts the flush landing —
    // best effort, never a failure.
    currentTree = () =>
      screen([n({ label: "Last row", frame: { x: 0.1, y: 0.88, width: 0.8, height: 0.1 } })]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("stuck-nudge", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Last row" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "stuck-nudge", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
  });

  it("skips the nudge when the scroll container is inset from the screen edge", async () => {
    // The pane's bottom sits at 0.7 — far from the screen edge, so a landing
    // flush against the pane's own border is already clear of screen chrome
    // and the mechanism must not engage at all: one reveal swipe, no nudge.
    const pane = () => n({ identifier: "pane", frame: { x: 0, y: 0.2, width: 1, height: 0.5 } });
    let scrolled = false;
    currentTree = () =>
      screen([
        pane(),
        ...(scrolled
          ? [n({ label: "Row 9", frame: { x: 0.1, y: 0.62, width: 0.8, height: 0.06 } })]
          : []),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      scrolled = true;
    });

    await writeFlow("inset-pane", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "scroll-to",
          target: { text: "Row 9" },
          direction: "down",
          within: { identifier: "pane" },
        },
      ],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "inset-pane", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
  });

  it("caps the nudge at half the target's headroom, then stops when none is left", async () => {
    // A 0.85-tall card 0.03 off the screen bottom has only 0.12 of headroom
    // above it: the 1.5×-deficit ask (0.105) is capped at headroom/2 (0.06).
    // After that move the remaining headroom's half (0.03) is below the tap-vs-
    // scroll floor, so the loop accepts rather than risk a mis-read gesture.
    const before = screen([
      n({ label: "Tall card", frame: { x: 0.1, y: 0.12, width: 0.8, height: 0.85 } }),
    ]);
    const after = screen([
      n({ label: "Tall card", frame: { x: 0.1, y: 0.06, width: 0.8, height: 0.85 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? after : before);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("headroom-cap", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Tall card" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "headroom-cap", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.06, 5);
  });

  it("gives up after MAX_EDGE_NUDGES and accepts the under-padded landing", async () => {
    // A snapping list keeps re-settling short of padding, with a distinct tree
    // each round (so end-of-scroll never fires). The nudge budget (3) bounds
    // the chase, and the step still passes — acceptance is never revoked.
    const at = (y: number) =>
      screen([n({ label: "Snappy row", frame: { x: 0.1, y, width: 0.8, height: 0.08 } })]);
    const positions = [0.9, 0.895, 0.905, 0.9];
    let round = 0;
    currentTree = () => at(positions[Math.min(round, positions.length - 1)]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      round++;
    });

    await writeFlow("nudge-budget", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Snappy row" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "nudge-budget", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(3);
  });

  it("stops at the accepted frame when a nudge round loses the target", async () => {
    // Regression guard for the post-acceptance fallthrough: the target is
    // accepted flush at the bottom, one nudge goes out, and the next settled
    // tree no longer resolves it (a snap list paged in response) — with
    // DIFFERENT content, so end-of-scroll never fires. Never-reverse leaves no
    // recovery gesture: the loop must stop at the accepted frame, not fall
    // back to full-size plain-search increments carrying the viewport further
    // past the target.
    const flush = screen([
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.88, width: 0.8, height: 0.1 } }),
    ]);
    const paged = screen([
      n({ label: "Order #5678", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? paged : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("lost-target", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "lost-target", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    // Exactly the nudge (0.08 deficit × 1.5) — no follow-up full-size scroll.
    expect(swipes).toHaveLength(1);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.12, 5);
  });

  it("stops at the accepted frame when the within container vanishes mid-nudge", async () => {
    // A pane flush against the screen bottom passes the screen-edge gate, so a
    // row landing flush inside it gets nudged. The nudge dismisses the pane (a
    // sheet re-rendered away) — best-effort territory: the step passes on the
    // accepted frame with no further gesture and no container-not-visible
    // failure.
    const withPane = screen([
      n({ identifier: "pane", frame: { x: 0, y: 0.5, width: 1, height: 0.5 } }),
      n({ label: "Row 9", frame: { x: 0.1, y: 0.88, width: 0.8, height: 0.1 } }),
    ]);
    const paneless = screen([
      n({ label: "Toast", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? paneless : withPane);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("vanishing-pane", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "scroll-to",
          target: { text: "Row 9" },
          direction: "down",
          within: { identifier: "pane" },
        },
      ],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "vanishing-pane", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
  });

  it("nudges an up-scrolled target clear of a flush top-edge landing", async () => {
    // Mirror of the down case: scrolling `up`, the entry edge is the TOP of
    // the screen (status bar / notch territory). Target at 0.03..0.13 →
    // clearance 0.03, deficit 0.07, nudge 0.105 — and for an up-scroll the
    // finger travels DOWN (toY > fromY).
    const flush = screen([
      n({ label: "Header row", frame: { x: 0.1, y: 0.03, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      n({ label: "Header row", frame: { x: 0.1, y: 0.15, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("edge-nudge-up", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Header row" }, direction: "up" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "edge-nudge-up", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].toY - swipes[0].fromY).toBeCloseTo(0.105, 5);
  });

  it("nudges a right-scrolled target clear of a flush right-edge landing", async () => {
    // Horizontal mirror of the down case: scrolling `right`, the entry edge is
    // the RIGHT screen edge. Target at 0.87..0.97 → clearance 0.03, deficit
    // 0.07, nudge 0.105 — and to reveal content on the right the finger
    // travels LEFT (toX < fromX), the vertical anchor unmoved.
    const flush = screen([
      n({ label: "Card 9", frame: { x: 0.87, y: 0.45, width: 0.1, height: 0.1 } }),
    ]);
    const padded = screen([
      n({ label: "Card 9", frame: { x: 0.75, y: 0.45, width: 0.1, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("edge-nudge-right", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Card 9" }, direction: "right" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "edge-nudge-right", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromX).toBeCloseTo(0.5, 5);
    expect(swipes[0].fromX - swipes[0].toX).toBeCloseTo(0.105, 5);
    expect(swipes[0].toY).toBeCloseTo(swipes[0].fromY, 5);
  });

  it("nudges a left-scrolled target clear of a flush left-edge landing", async () => {
    // Left mirror: the entry edge is the LEFT screen edge. Target at 0.03..0.13
    // → clearance 0.03, deficit 0.07, nudge 0.105 — and for a left-scroll the
    // finger travels RIGHT (toX > fromX).
    const flush = screen([
      n({ label: "Back chip", frame: { x: 0.03, y: 0.45, width: 0.1, height: 0.1 } }),
    ]);
    const padded = screen([
      n({ label: "Back chip", frame: { x: 0.15, y: 0.45, width: 0.1, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("edge-nudge-left", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Back chip" }, direction: "left" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "edge-nudge-left", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromX).toBeCloseTo(0.5, 5);
    expect(swipes[0].toX - swipes[0].fromX).toBeCloseTo(0.105, 5);
    expect(swipes[0].toY).toBeCloseTo(swipes[0].fromY, 5);
  });

  it("nudges via the chromium wheel path with an explicit deltaY", async () => {
    // The device id shape selects the platform (chromium-cdp-<port> →
    // chromium), so the same flush landing goes out as a gesture-scroll wheel
    // burst whose deltaY is the exact nudge distance (0.08 deficit × 1.5), not
    // the half-viewport default — and no touch swipe is dispatched.
    const flush = screen([
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.88, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.7, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const scrolls: ScrollCall[] = [];
    const registry = mockRegistry(
      swipes,
      () => {
        nudged = true;
      },
      scrolls
    );

    await writeFlow("edge-nudge-wheel", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute(
        {},
        { name: "edge-nudge-wheel", project_root: tmpDir, device: CHROMIUM_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0].deltaY).toBeCloseTo(0.12, 5);
    expect(scrolls[0].x).toBeCloseTo(0.5, 5);
  });

  it("nudges via the chromium wheel path with an explicit deltaX", async () => {
    // Horizontal wheel mirror: a right-scroll landing flush at 0.88..0.98
    // (clearance 0.02, deficit 0.08) goes out as one gesture-scroll whose
    // deltaX is +0.12 — positive reveals content to the right — with no
    // deltaY and no touch swipe.
    const flush = screen([
      n({ label: "Card 9", frame: { x: 0.88, y: 0.45, width: 0.1, height: 0.1 } }),
    ]);
    const padded = screen([
      n({ label: "Card 9", frame: { x: 0.7, y: 0.45, width: 0.1, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const scrolls: ScrollCall[] = [];
    const registry = mockRegistry(
      swipes,
      () => {
        nudged = true;
      },
      scrolls
    );

    await writeFlow("edge-nudge-wheel-x", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Card 9" }, direction: "right" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute(
        {},
        { name: "edge-nudge-wheel-x", project_root: tmpDir, device: CHROMIUM_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0].deltaX).toBeCloseTo(0.12, 5);
    expect(scrolls[0].deltaY).toBeUndefined();
    expect(scrolls[0].y).toBeCloseTo(0.5, 5);
  });
});
