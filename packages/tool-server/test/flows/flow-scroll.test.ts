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

// The nudge gate probes the runtime kind of an iOS-shaped UDID (a tvOS sim
// classifies as plain "ios") via `xcrun simctl list` - stubbed so no test
// shells out. Default not-tv keeps every existing iOS geometry on its touch
// nudge path; the tvOS case overrides per-test.
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));

// The Android half of the same gate: a leanback device is tagged `android` by
// serial shape like a phone, so it asks adb which one this serial is - stubbed
// so no test shells out. Default not-tv keeps every existing Android geometry
// on its touch nudge path; the TV case overrides per-test.
vi.mock("../../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/adb")>()),
  isAndroidTv: vi.fn(async () => false),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import { adaptFullAndroidHierarchyToDescribeResult } from "../../src/tools/flows/flow-android-tree";
import { isTvOsSimulator } from "../../src/utils/ios-devices";
import { isAndroidTv } from "../../src/utils/adb";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const ANDROID_DEVICE = "emulator-5554"; // Android serial shape → touch path, non-iOS
const CHROMIUM_DEVICE = "chromium-cdp-9222"; // chromium id shape → wheel-scroll path
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

// A full-bleed scroll-container LEAF, emitted as a SIBLING of the rows it
// scrolls — the flat-leaves-under-one-root shape the flow tree adapters
// actually produce (see flow-tree-flatten): the edge-avoid nudge matches a
// target to its scroller by geometric containment over these leaves, since
// the flat shape has no ancestry to consult (see targetScrollerFrame) — a
// target no emitted scroller contains never gets nudged. Full-bleed (0..1)
// keeps each nudge test's pinned arithmetic identical to measuring against
// the screen: clip end 1.0, gesture anchor (0.5, 0.5).
function fullScreenScroller(): DescribeNode {
  return n({ role: "AXScrollArea", frame: { x: 0, y: 0, width: 1, height: 1 } });
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

// The cancellation signal rides the tool context, so the abort cases run the
// flow through here instead of the plain two-argument execute() every other
// test uses.
async function runCancellable(
  name: string,
  registry: Registry,
  signal: AbortSignal
): Promise<FlowRunResult> {
  return asRun(
    await createRunFlowTool(registry).execute({}, { name, project_root: tmpDir, device: DEVICE }, {
      signal,
    } as never)
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-scroll-"));
  vi.mocked(isTvOsSimulator).mockReset().mockResolvedValue(false);
  vi.mocked(isAndroidTv).mockReset().mockResolvedValue(false);
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

  it("finds a flush last item in an id-less Android scroller despite a header spinner", async () => {
    // The Android counterpart of the clock test above, and the plain-search
    // consequence of the scrollable keep-gate (flow-android-tree): an RN
    // ScrollView / Compose LazyColumn with no testID dumps as a scrollable
    // android.view.ViewGroup, whose class-fallback role fails the /scroll/i
    // test, so only the `scrollable` flag keeps it as a leaf. Without that
    // leaf the tree surfaces no scroll container under the anchor, the
    // fingerprint scope falls back to the whole screen, and the header spinner
    // above the list masks the end of the scroll - a plain search round, no
    // nudge involved. Built through the real adapter so this stays tied to
    // that gate.
    let reads = 0;
    // The last row sits flush against the screen bottom on every read, so the
    // axis check can never clear its entry edge and only end-of-scroll
    // detection can accept it. The spinner sits ABOVE the scroller's bounds,
    // so it is out of the scoped fingerprint but in a whole-screen one.
    const dump = (spinner: string): string =>
      `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.TextView" text="${spinner}" package="com.acme.app" bounds="[380,20][700,100]" />
    <node index="1" class="android.view.ViewGroup" scrollable="true" package="com.acme.app" bounds="[0,200][1080,1920]">
      <node index="0" class="android.widget.TextView" text="Row 9" package="com.acme.app" bounds="[100,1400][980,1520]" />
      <node index="1" class="android.widget.TextView" text="Bottom row" package="com.acme.app" bounds="[100,1728][980,1920]" />
    </node>
  </node>
</hierarchy>`;
    currentTree = () => {
      reads++;
      // Ticks every other read: each settle sees a stable pair, but no two
      // settled trees share the spinner's label (a ~1Hz spinner, effectively).
      return adaptFullAndroidHierarchyToDescribeResult(
        dump(`Syncing ${Math.floor(reads / 2)}s`),
        1080,
        1920
      );
    };

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("android-spinner-last-item", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Bottom row" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute(
        {},
        { name: "android-spinner-last-item", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    // One increment attempted, then the scoped no-progress check accepted it.
    // With the scope back at the whole screen this burns all
    // MAX_SCROLL_ITERATIONS and fails "not found" on a visible element.
    expect(swipes).toHaveLength(1);
    // The pass takes under a second; the budget covers that regression path
    // (25 rounds x the settle poll) so it fails on these assertions rather
    // than on a test timeout, which would read as a flake.
  }, 15000);

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
    // Fully inside its full-bleed scroller at 0.87..0.97 — accepted by the
    // axis check — but only 0.03 from the scroller's bottom, which IS the
    // screen bottom: home-indicator / tab-bar territory. One same-direction
    // nudge sized to 1.5× the 0.07 deficit moves it clear; the second round
    // sees enough clearance and stops.
    const flush = screen([
      fullScreenScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      fullScreenScroller(),
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
    // A nudge that completed swallowed nothing - only the bail-outs warn.
    expect(result.steps[0].warning).toBeUndefined();
  });

  it("floors a tiny nudge at the minimum scroll increment so it cannot read as a tap", async () => {
    // A near-padding landing at 0.82..0.92 in a full-bleed scroller leaves
    // 0.08 of clearance: the 0.02 deficit's 1.5× ask is only 0.03, below the
    // 0.05 tap-vs-scroll floor, so the dispatched nudge must be raised to
    // exactly MIN_SCROLL_INCREMENT — a 0.03 swipe could register as a tap on
    // the target. Headroom above the row (0.82) is ample, so its half-cap
    // (0.41) does not mask the floor.
    const nearPadding = screen([
      fullScreenScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.82, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      fullScreenScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.75, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : nearPadding);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("floored-nudge", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "floored-nudge", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    // Momentum-free, floored to the minimum increment — not deficit × 1.5 (0.03).
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromY).toBeCloseTo(0.5, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.05, 5);
  });

  it("leaves a landing a hair short of the padding alone", async () => {
    // A row at 0.80..0.903 in a full-bleed scroller is 0.097 clear — 0.003
    // short of EDGE_AVOID_PADDING, and already past every piece of chrome the
    // padding models. Because the floor rounds any deficit at all up to a
    // full 0.05 of travel, a bare `deficit <= 0` would spend a whole gesture
    // (and its settle) scrolling 0.05 to recover 0.003. EDGE_EPS on the gate
    // is what keeps such a landing a no-op: zero gestures.
    currentTree = () =>
      screen([
        fullScreenScroller(),
        n({ label: "Order #1234", frame: { x: 0.1, y: 0.8, width: 0.8, height: 0.103 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("near-enough", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "near-enough", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
  });

  it("scrolls a target into view, then nudges its flush landing off the screen edge", async () => {
    // The end-to-end shape: a half-screen increment reveals the target flush at
    // the bottom (0.88..0.98), then a small nudge lifts it to padding. The two
    // gestures are distinguishable by travel: 0.5 reveal vs 0.12 nudge.
    let phase = 0;
    currentTree = () =>
      phase === 0
        ? screen([
            fullScreenScroller(),
            n({ label: "Top", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
          ])
        : phase === 1
          ? screen([
              fullScreenScroller(),
              n({ label: "Order #1234", frame: { x: 0.1, y: 0.88, width: 0.8, height: 0.1 } }),
            ])
          : screen([
              fullScreenScroller(),
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
    // the container can't move. The nudge is attempted once and the tree
    // doesn't budge — the progress check (the target's own frame is
    // the direct signal a nudge worked) accepts the flush landing before the
    // end-of-scroll fingerprint even gets to repeat — best effort, never a
    // failure.
    currentTree = () =>
      screen([
        fullScreenScroller(),
        n({ label: "Last row", frame: { x: 0.1, y: 0.88, width: 0.8, height: 0.1 } }),
      ]);

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
    // The one gesture is nudge-sized (0.08 deficit x 1.5 = 0.12) at the
    // scroller centre - not the 0.5 half-region search increment.
    expect(swipes[0].fromY).toBeCloseTo(0.5, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.12, 5);
  });

  it("skips the nudge when the scroll container is inset from the screen edge", async () => {
    // The pane's bottom sits at 0.7 — far from the screen edge, so a landing
    // flush against the pane's own border is already clear of screen chrome
    // and the mechanism must not engage at all: one reveal swipe, no nudge.
    const pane = () =>
      n({
        role: "AXScrollArea",
        identifier: "pane",
        frame: { x: 0, y: 0.2, width: 1, height: 0.5 },
      });
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

  it("nudges within a pane whose entry edge is near — not on — the screen edge", async () => {
    // The near-edge band only EDGE_AVOID_SCREEN_EPS covers: the pane's bottom
    // sits at 0.96 — 0.04 shy of the screen edge (inside the 0.05 tolerance,
    // so screen chrome can still overlap it) but not exactly on it, e.g. a
    // scroller inset a few pixels under a tab bar. The row lands flush at
    // 0.84..0.94 → clearance 0.02, deficit 0.08 → one nudge of 0.08 × 1.5 =
    // 0.12 (headroom 0.64; the 0.32 half-cap doesn't bite), anchored at the
    // pane centre (y 0.58). Zeroing the epsilon would read 0.96 as "not a
    // screen edge" and silently skip the nudge — this geometry also pins
    // EDGE_AVOID_SCREEN_EPS ≥ 0.04.
    const pane = () =>
      n({
        role: "AXScrollArea",
        identifier: "pane",
        frame: { x: 0, y: 0.2, width: 1, height: 0.76 },
      });
    const flush = screen([
      pane(),
      n({ label: "Row 9", frame: { x: 0.1, y: 0.84, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      pane(),
      n({ label: "Row 9", frame: { x: 0.1, y: 0.72, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("near-edge-pane", {
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
      await tool.execute({}, { name: "near-edge-pane", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    // Momentum-free, deficit-sized (0.08 × 1.5), anchored at the pane centre.
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromX).toBeCloseTo(0.5, 5);
    expect(swipes[0].fromY).toBeCloseTo(0.58, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.12, 5);
  });

  it("caps the nudge at half the target's headroom, then stops when none is left", async () => {
    // A 0.85-tall card 0.03 off its full-bleed scroller's bottom has only
    // 0.12 of headroom above it: the 1.5×-deficit ask (0.105) is capped at
    // headroom/2 (0.06). After that move the remaining headroom's half (0.03)
    // is below the tap-vs-scroll floor, so the loop accepts rather than risk
    // a mis-read gesture.
    const before = screen([
      fullScreenScroller(),
      n({ label: "Tall card", frame: { x: 0.1, y: 0.12, width: 0.8, height: 0.85 } }),
    ]);
    const after = screen([
      fullScreenScroller(),
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
    // A snapping list absorbs most of each nudge but does creep: every round
    // shows genuine progress (the entry edge moves 0.02 ≥ EDGE_EPS: 0.98 →
    // 0.96 → 0.94, so the progress check keeps allowing retries) yet stays
    // short of padding, with a distinct tree each round (so end-of-scroll
    // never fires either). The nudge budget (3) is then the bound that stops
    // the chase, and the step still passes — acceptance is never revoked.
    const at = (y: number) =>
      screen([
        fullScreenScroller(),
        n({ label: "Snappy row", frame: { x: 0.1, y, width: 0.8, height: 0.08 } }),
      ]);
    const positions = [0.9, 0.88, 0.86, 0.85];
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
    // Each round re-measures the deficit from that round's tree: entry edges
    // 0.98 / 0.96 / 0.94 give deficits 0.08 / 0.06 / 0.04, so the travels
    // shrink round by round (deficit x 1.5; the 0.45+ headroom half-caps never
    // bite) - a loop reusing the first round's travel would send 0.12 thrice.
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.12, 5);
    expect(swipes[1].fromY - swipes[1].toY).toBeCloseTo(0.09, 5);
    expect(swipes[2].fromY - swipes[2].toY).toBeCloseTo(0.06, 5);
    // Every round anchors at the full-bleed scroller's centre.
    expect(swipes[0].fromX).toBeCloseTo(0.5, 5);
    expect(swipes[0].fromY).toBeCloseTo(0.5, 5);
    expect(swipes[1].fromX).toBeCloseTo(0.5, 5);
    expect(swipes[1].fromY).toBeCloseTo(0.5, 5);
    expect(swipes[2].fromX).toBeCloseTo(0.5, 5);
    expect(swipes[2].fromY).toBeCloseTo(0.5, 5);
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
      fullScreenScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.88, width: 0.8, height: 0.1 } }),
    ]);
    const paged = screen([
      fullScreenScroller(),
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
      n({
        role: "AXScrollArea",
        identifier: "pane",
        frame: { x: 0, y: 0.5, width: 1, height: 0.5 },
      }),
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
    // The one gesture is nudge-sized (0.08 deficit x 1.5 = 0.12) anchored at
    // the pane centre - not the pane's 0.25 half-extent search increment.
    expect(swipes[0].fromY).toBeCloseTo(0.75, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.12, 5);
    // Swallowing the nudge is right; saying nothing about it is not - the pass
    // names the vanished container and what the landing may still sit under.
    expect(result.steps[0].warning).toContain('id="pane" was gone from the tree that came back');
    expect(result.steps[0].warning).toContain("screen-edge chrome");
  });

  it("passes on the accepted frame when the nudge's gesture backend throws", async () => {
    // Reviewer repro: the target is fully visible (accepted at 0.87..0.97,
    // 0.07 deficit, one nudge) but the gesture backend is down - the swipe
    // rejects with a service dependency error. Before acceptance returned
    // without touching the device a defensive scroll-to over an on-screen
    // target could not fail; the nudge must keep that guarantee, so the throw
    // ends the loop at the accepted frame instead of failing the step.
    currentTree = () =>
      screen([
        fullScreenScroller(),
        n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      throw new Error(
        "[Tool:gesture-swipe] Service dependency failed: [SimulatorServer:emulator-5554] simulator-server exited with code before becoming ready"
      );
    });

    await writeFlow("throwing-nudge", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "throwing-nudge", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    // Exactly the one failed dispatch was attempted (recorded before the throw).
    expect(swipes).toHaveLength(1);
    // A dead gesture backend behind a live describe source would otherwise
    // report fully green: the pass carries the backend's own error.
    expect(result.steps[0].warning).toContain("could not be dispatched");
    expect(result.steps[0].warning).toContain("simulator-server exited");
    expect(result.steps[0].warning).toContain("screen-edge chrome");
  });

  it("reports a skip when the nudge's gesture rejects because the run was cancelled", async () => {
    // The same rejecting dispatch as the control directly above, plus a
    // cancellation: the swipe rejects because the run was cancelled, not
    // because the device is broken. Only the signal separates the two, so the
    // catch must read it before swallowing the throw - "backend died" keeps the
    // accepted frame's pass, "run cancelled" reports the uniform skip.
    const controller = new AbortController();
    currentTree = () =>
      screen([
        fullScreenScroller(),
        n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      controller.abort();
      throw new Error("This operation was aborted");
    });

    await writeFlow("cancelled-nudge-gesture", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const result = await runCancellable("cancelled-nudge-gesture", registry, controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["scroll-to:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(result.ok).toBe(false);
    // The swallow-and-pass would have reported a pass carrying the rejection.
    expect(result.steps[0].warning).toBeUndefined();
    expect(swipes).toHaveLength(1);
  });

  it("reports a skip when the run is cancelled between nudge rounds", async () => {
    // The nudge goes out and the run is cancelled while it settles, so the
    // round that would have read the landing sees the abort at the top of the
    // loop. Without the cancellation this shape passes (see the flush-landing
    // nudge above): acceptance never turns an aborted run into a pass.
    const controller = new AbortController();
    const flush = screen([
      fullScreenScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      fullScreenScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.75, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
      controller.abort();
    });

    await writeFlow("cancelled-between-nudges", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const result = await runCancellable("cancelled-between-nudges", registry, controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["scroll-to:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(result.ok).toBe(false);
    expect(swipes).toHaveLength(1);
  });

  it("reports a skip when the run is cancelled during the nudge round's settle read", async () => {
    // Same shape as the case above, one step later: the abort lands inside the
    // first tree read of the round that would have measured the landing, so
    // settleTree bails and hands back no tree at all. That exit is
    // post-acceptance too and must report the skip, not the accepted pass.
    const controller = new AbortController();
    const flush = screen([
      fullScreenScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      fullScreenScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.75, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => {
      if (!nudged) return flush;
      controller.abort();
      return padded;
    };

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("cancelled-nudge-settle", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const result = await runCancellable("cancelled-nudge-settle", registry, controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["scroll-to:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(result.ok).toBe(false);
    expect(swipes).toHaveLength(1);
  });

  it(
    "passes on the accepted frame when the tree source dies after the nudge",
    { timeout: 10_000 },
    async () => {
      // The other device interaction a nudge round adds: the next round's
      // settle read. The nudge dispatches fine, then every tree fetch fails -
      // settleTree exhausts its window and throws the outage. Post-acceptance
      // that throw must also end the loop at the accepted frame; a search
      // round's outage keeps failing the step (settleTree's own contract).
      let nudged = false;
      currentTree = () => {
        if (nudged) throw new Error("native devtools disconnected");
        return screen([
          fullScreenScroller(),
          n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
        ]);
      };

      const swipes: SwipeCall[] = [];
      const registry = mockRegistry(swipes, () => {
        nudged = true;
      });

      await writeFlow("outage-after-nudge", {
        executionPrerequisite: "",
        steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
      });

      const tool = createRunFlowTool(registry);
      const result = asRun(
        await tool.execute({}, { name: "outage-after-nudge", project_root: tmpDir, device: DEVICE })
      );

      expect(result.ok).toBe(true);
      expect(result.steps[0].status).toBe("pass");
      expect(swipes).toHaveLength(1);
      // The nudge went out and its result was never read back - the pass says
      // so, and carries the outage that stopped the read.
      expect(result.steps[0].warning).toContain("the UI tree could not be read afterwards");
      expect(result.steps[0].warning).toContain("native devtools disconnected");
      expect(result.steps[0].warning).toContain("screen-edge chrome");
    }
  );

  it(
    "passes with a warning when the iterations run out on the first acceptance's nudge",
    { timeout: 30_000 },
    async () => {
      // Reachability pin for the post-loop `if (accepted)` exit, the last of
      // the four post-acceptance bail-outs: a long search finds the target on
      // the 25th and final iteration, that round's nudge goes out, and the
      // budget ends before any round can read where it landed. This scenario
      // spends a single nudge; the cap could not bind anyway, since it is only
      // consulted on a round after the nudge and no round is left.
      // Acceptance is never revoked, so this passes, but the nudge's result is
      // as unknown as it is in the outage and vanished-container cases, and the
      // pass says so. Each search round emits a distinct tree so end-of-scroll
      // never fires.
      let gestures = 0;
      currentTree = () =>
        gestures >= 24
          ? screen([
              fullScreenScroller(),
              n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
            ])
          : screen([
              fullScreenScroller(),
              n({ label: `Row ${gestures}`, frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } }),
            ]);

      const swipes: SwipeCall[] = [];
      const registry = mockRegistry(swipes, () => {
        gestures++;
      });

      await writeFlow("iterations-out", {
        executionPrerequisite: "",
        steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
      });

      const tool = createRunFlowTool(registry);
      const result = asRun(
        await tool.execute({}, { name: "iterations-out", project_root: tmpDir, device: DEVICE })
      );

      expect(result.ok).toBe(true);
      expect(result.steps[0].status).toBe("pass");
      // 24 search increments plus the one nudge that ended the budget.
      expect(swipes).toHaveLength(25);
      expect(swipes[24].fromY - swipes[24].toY).toBeCloseTo(0.105, 5);
      expect(result.steps[0].warning).toContain("ran out of its 25 attempts");
      expect(result.steps[0].warning).toContain("screen-edge chrome");
    }
  );

  it("still fails a search scroll when the gesture backend throws", async () => {
    // The guard must not over-catch: pre-acceptance the target still needs
    // scrolling, so a throwing backend means the step genuinely cannot
    // complete - the throw propagates and the step errors (the pre-existing
    // behavior, pinned so the nudge guard stays scoped to accepted frames).
    currentTree = () =>
      screen([n({ label: "Top", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      throw new Error(
        "[Tool:gesture-swipe] Service dependency failed: [SimulatorServer:emulator-5554] simulator-server exited with code before becoming ready"
      );
    });

    await writeFlow("throwing-search", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "throwing-search", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toContain("simulator-server");
    expect(swipes).toHaveLength(1);
  });

  it("still fails a search scroll when the tree source dies", { timeout: 10_000 }, async () => {
    // The settle guard's negative control, mirroring the gesture one above:
    // the search increment goes out and every tree fetch then fails. Nobody has
    // seen the target pre-acceptance, so there is no accepted frame to fall
    // back on - settleTree's outage must propagate and error the step.
    let scrolled = false;
    currentTree = () => {
      if (scrolled) throw new Error("native devtools disconnected");
      return screen([n({ label: "Top", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]);
    };

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      scrolled = true;
    });

    await writeFlow("outage-during-search", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "outage-during-search", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toContain("native devtools disconnected");
    expect(swipes).toHaveLength(1);
  });

  it("bounds a nudge at a pinned bottom-bar target to a single gesture", async () => {
    // The residual the entry-edge slack accepts, in the flat-leaves shape the
    // adapters emit: a list leaf (ending at 0.96) and, below it, a pinned
    // bottom bar holding the checkout button - all SIBLINGS. The button
    // (0.9..0.98) overhangs the list's entry edge by 0.02, and with leaf
    // frames clamped to the screen that is indistinguishable in the tree from
    // a row mid-reveal, so the list resolves as the clip and one nudge goes
    // out (deficit 0.12, travel 0.18, anchored at the list's centre) even
    // though no scroll can ever move the button. The progress check
    // is the bound: the button did not budge, so the second round accepts the
    // flush landing - exactly ONE wasted gesture, never a failure.
    currentTree = () =>
      screen([
        n({ role: "AXScrollArea", frame: { x: 0, y: 0, width: 1, height: 0.96 } }),
        n({ label: "Row 1", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
        n({ identifier: "bottom-bar", frame: { x: 0, y: 0.9, width: 1, height: 0.1 } }),
        n({
          identifier: "checkout-button",
          label: "Checkout",
          frame: { x: 0.1, y: 0.9, width: 0.8, height: 0.08 },
        }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("pinned-bar", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { identifier: "checkout-button" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "pinned-bar", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].fromY).toBeCloseTo(0.48, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.18, 5);
  });

  it("never nudges a bar sitting mostly below its scroller's entry edge", async () => {
    // A bar overhanging the entry edge by more than the slack (list 0..0.9,
    // button 0.86..0.98, overhang 0.08) dispatches nothing. Two independent
    // guards decline it - containment (overhang > EDGE_AVOID_SCREEN_EPS) and
    // the screen-edge gate (clip end 0.9 < 0.95) - and the slack's derivation
    // ties them: a gate-passing clip can never see overhang above 0.045, so
    // the deep-overhang shape is unreachable for the nudge by construction.
    currentTree = () =>
      screen([
        n({ role: "AXScrollArea", frame: { x: 0, y: 0, width: 1, height: 0.9 } }),
        n({ label: "Row 1", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
        n({
          identifier: "checkout-button",
          label: "Checkout",
          frame: { x: 0.1, y: 0.86, width: 0.8, height: 0.12 },
        }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("deep-overhang-bar", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { identifier: "checkout-button" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "deep-overhang-bar", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
  });

  it("never nudges on a screen with no scroll container at all", async () => {
    // Reviewer repro 2: nothing scrollable anywhere; a large pressable card
    // centred on screen and the cta inset near the bottom (0.92..0.98 — the
    // raw screen-edge arithmetic reads a 0.04 deficit). gesture-swipe emits a
    // genuine Down/Moves/Up train, and with no scroller to claim the touch
    // responder the card under the (0.5, 0.5) anchor keeps it — a nudge-sized
    // travel stays inside a large control's press-retention rect, so each
    // "nudge" COMMITS a press. With no scroll container in the tree at all
    // the gate finds no containing candidate and skips the phase entirely: a
    // defensive scroll-to on a static screen dispatches nothing and passes
    // as it did before the nudge existed.
    currentTree = () =>
      screen([
        n({
          label: "Promo card",
          clickable: true,
          frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.55 },
        }),
        n({
          identifier: "cta",
          label: "Continue",
          frame: { x: 0.1, y: 0.92, width: 0.8, height: 0.06 },
        }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("static-screen", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { identifier: "cta" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "static-screen", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
  });

  it("never nudges when a named within container has nothing scrollable in it", async () => {
    // The same static screen, but the step names a `within` — a plain text
    // pane, the shape an author reaches for to disambiguate a duplicate
    // label. The `within` region picks the clip and the anchor, but it does
    // not stand in for the container gate: a region nothing can scroll shows
    // the same permanent deficit as the raw screen, and the gesture would go
    // to whatever sits under its centre. So the gate still asks the tree
    // whether the target lives in a scroller, and a screen with none
    // dispatches nothing — `within` cannot buy a nudge the no-within path
    // would refuse.
    currentTree = () =>
      screen([
        n({
          identifier: "empty-view",
          label: "No locations selected",
          frame: { x: 0, y: 0.45, width: 1, height: 0.55 },
        }),
        // Flush against the pane's bottom, which IS the screen bottom:
        // clearance 0.013, deficit 0.087, headroom 0.45 — every geometric
        // condition for a 0.13 nudge is met, and only the container gate
        // declines.
        n({
          identifier: "fab",
          label: "Add city",
          clickable: true,
          frame: { x: 0.77, y: 0.9, width: 0.19, height: 0.087 },
        }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("static-within", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "scroll-to",
          target: { identifier: "fab" },
          direction: "down",
          within: { identifier: "empty-view" },
        },
      ],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "static-within", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
  });

  it("never nudges when a named within container is static inside a real scroller", async () => {
    // Reviewer repro: the `within` names a NON-scrolling card that lives
    // inside a scrollable page — so "does the target sit in some scroller"
    // answers yes (the page) while the clip is still the card. Measuring the
    // target's scroller instead of the named region is what makes this shape
    // slip through: the nudge would anchor at the card's centre and scroll the
    // page, a container the step never named, and it could never succeed —
    // the clip travels WITH the target under its own gesture, so the deficit
    // (0.073 here) is identical afterwards - a chase only the nudge budget
    // would end. The clip must therefore be scrollable itself, not merely sit
    // in something scrollable.
    currentTree = () =>
      screen([
        n({
          role: "AXScrollArea",
          identifier: "page-scroller",
          frame: { x: 0, y: 0.2993, width: 1, height: 0.7007 },
        }),
        // Flush against the screen bottom, so every other gate passes:
        // clip end 1.0 is a screen edge, deficit 0.073, headroom 0.2734 —
        // geometry for a 0.1095 nudge anchored at (0.5, 0.8357).
        n({ identifier: "bottom-card", frame: { x: 0, y: 0.6714, width: 1, height: 0.3286 } }),
        n({ identifier: "card-item", frame: { x: 0, y: 0.9448, width: 1, height: 0.0282 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("within-static-card", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "scroll-to",
          target: { identifier: "card-item" },
          direction: "down",
          within: { identifier: "bottom-card" },
        },
      ],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "within-static-card", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
  });

  it("measures the nudge clip against the target's scroller, not the screen", async () => {
    // The scroller leaf's bottom sits at 0.93 — outside EDGE_AVOID_SCREEN_EPS
    // (0.05) of the screen edge, so its own border already clears screen
    // chrome. The row (a flat sibling the scroller's rect contains) lands at
    // 0.84..0.92: measured against the SCREEN it is within EDGE_AVOID_PADDING
    // of the bottom (0.02 deficit — the old FULL_SCREEN clip would have
    // dispatched a floored 0.05 nudge); measured against its scroller the
    // entry edge isn't a screen edge at all, so nothing may fire. Pins that
    // the clip is the target's container, not the screen, even when no
    // `within` is named.
    currentTree = () =>
      screen([
        n({ role: "AXScrollArea", frame: { x: 0, y: 0.1, width: 1, height: 0.83 } }),
        n({ label: "Row 9", frame: { x: 0.1, y: 0.84, width: 0.8, height: 0.08 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("inset-scroller", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Row 9" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "inset-scroller", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
  });

  it("nudges a row overhanging its inset scroller's entry edge (screen-clamped frame)", async () => {
    // The iOS shape the entry-edge slack exists for: a list inset under an
    // overlaying tab bar (y 0..0.96) with a row mid-reveal at 0.86..0.99.
    // Leaf frames are clamped to the SCREEN, not the scroller, so the row
    // overhangs the list's bottom by 0.03 - far past float rounding, within
    // the 0.05 entry-edge slack. The axis check accepts it against the full
    // screen (0.99 <= 1 - 0.005), the list passes the screen-edge gate (0.96
    // >= 0.95), and the nudge fires: deficit 0.1 - (0.96 - 0.99) = 0.13,
    // headroom 0.86, travel min(0.13 x 1.5, 0.43) = 0.195, anchored at the
    // list's centre (y 0.48). With symmetric EDGE_EPS slack no candidate
    // resolved here and the step passed with the row visually half-cut.
    const insetScroller = () =>
      n({ role: "AXScrollArea", frame: { x: 0, y: 0, width: 1, height: 0.96 } });
    const flush = screen([
      insetScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.86, width: 0.8, height: 0.13 } }),
    ]);
    // Post-nudge the row sits at 0.73..0.86: clearance 0.1, deficit 0 - done.
    const padded = screen([
      insetScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.73, width: 0.8, height: 0.13 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("inset-overhang", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "inset-overhang", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromY).toBeCloseTo(0.48, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.195, 5);
  });

  it("keeps the strict EDGE_EPS slack on the non-entry sides", async () => {
    // Same direction, but the overhang is on the LEFT - not the entry edge.
    // A scroller inset from the left (x 0.1..1.0) and a chip sticking 0.05
    // past its left border (x 0.05..0.85, y 0.87..0.97): exactly the amount
    // the entry edge would admit. Every other condition for a nudge holds -
    // the scroller's bottom (1.0) is a screen edge, deficit 0.07, headroom
    // 0.87 - so a symmetric EDGE_AVOID_SCREEN_EPS slack would resolve the
    // candidate and dispatch a 0.105 swipe. But only the entry edge is
    // screen-clamp territory; a left overhang means the chip does not live
    // in this scroller, and no candidate may resolve: zero gestures.
    currentTree = () =>
      screen([
        n({ role: "AXScrollArea", frame: { x: 0.1, y: 0, width: 0.9, height: 1 } }),
        n({ label: "Wide chip", frame: { x: 0.05, y: 0.87, width: 0.8, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("left-overhang", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Wide chip" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "left-overhang", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
  });

  it("anchors the nudge at the target's scroller centre, not the screen centre", async () => {
    // A full-bleed-ish scroller offset under a header: y 0.04..1.0, so its
    // centre is 0.52 — not the screen's 0.5. The row (its flat sibling)
    // lands flush at 0.87..0.97 (clip end 1.0 → clearance 0.03, deficit 0.07
    // → travel 0.105). The nudge must anchor at the SCROLLER's centre — the
    // screen-centre anchor belonged to the FULL_SCREEN clip the container
    // gate replaced — latching the gesture to the container that actually
    // owns the target.
    const offsetScroller = () =>
      n({ role: "AXScrollArea", frame: { x: 0, y: 0.04, width: 1, height: 0.96 } });
    const flush = screen([
      offsetScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      offsetScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.75, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("offset-scroller", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "offset-scroller", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromY).toBeCloseTo(0.52, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.105, 5);
  });

  it("nudges in the smallest containing scroller when several contain the target", async () => {
    // Nested scrollers in the flat shape: a full-bleed page scroller (area
    // 1.0, centre 0.5) and an inner list at y 0.3..1.0 (area 0.7, centre
    // 0.65) both contain the row flush at 0.87..0.97. The smallest-area
    // candidate — the innermost, whose viewport actually clips the row —
    // must win: its end sits on the screen edge too, so a 0.07-deficit nudge
    // (travel 0.105, headroom 0.57 — the 0.285 half-cap doesn't bite) goes
    // out anchored at the INNER list's centre (fromY 0.65), not the page
    // scroller's 0.5.
    const scrollers = () => [
      fullScreenScroller(),
      n({
        role: "AXScrollArea",
        identifier: "inner-list",
        frame: { x: 0, y: 0.3, width: 1, height: 0.7 },
      }),
    ];
    const flush = screen([
      ...scrollers(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      ...scrollers(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.75, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("innermost-scroller", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "innermost-scroller", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromY).toBeCloseTo(0.65, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.105, 5);
  });

  it("skips the nudge when a nested scroller covers the anchor without owning the target", async () => {
    // Reviewer repro: a page scroller owns the row, but an embedded pane (an
    // inner list, a web view, a map) covers the page's centre - where the
    // nudge would touch down. The OS hit-tests that point and hands the drag
    // to the INNERMOST scroller there, so the pane swallows it: the row (flush
    // at 0.87..0.97, every geometric condition for a 0.105 nudge met) does not
    // move and the pane is left scrolled for the next step to read. The pane
    // does not contain the row, so the nudge must not go out at all - the
    // pre-nudge behavior for a target that was already fully visible.
    const scrollers = () => [
      fullScreenScroller(),
      n({
        role: "AXScrollArea",
        identifier: "inner-pane",
        frame: { x: 0, y: 0.3, width: 1, height: 0.4 },
      }),
    ];
    let innerRow = 1;
    currentTree = () =>
      screen([
        ...scrollers(),
        n({ label: `INNER 0${innerRow}`, frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } }),
        n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    // A swipe reaching the pane scrolls the PANE - the side effect that
    // outlives the step, and the proof the gesture missed the target.
    const registry = mockRegistry(swipes, () => {
      innerRow++;
    });

    await writeFlow("nested-pane-anchor", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "nested-pane-anchor", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
    expect(innerRow).toBe(1); // the pane was never scrolled
  });

  it("still nudges the same shape once the nested scroller is gone", async () => {
    // Control for the reach gate: the tree above minus the inner pane, so the
    // page scroller is the innermost container at the anchor as well as the
    // row's owner. Nothing else changes, and the nudge fires as before (0.07
    // deficit x 1.5 = 0.105 at the screen centre) - the gate declines a
    // specific shape, it does not disable the phase. The row cannot move here
    // (a static tree), so the progress check ends the loop after that one
    // gesture.
    let innerRow = 1;
    currentTree = () =>
      screen([
        fullScreenScroller(),
        n({ label: `INNER 0${innerRow}`, frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.1 } }),
        n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      innerRow++;
    });

    await writeFlow("no-nested-pane", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "no-nested-pane", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromY).toBeCloseTo(0.5, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.105, 5);
  });

  it("still nudges when the scroller under the anchor also contains the target", async () => {
    // The reach gate asks whether the scroller hit-tested at the anchor owns
    // the target, not whether it is the clip. Only the `within` path can show
    // that difference: with no `within`, a smaller scroller containing the
    // target would have BEEN the clip (smallest-area wins). Here `within`
    // names the outer pane (0.2..1.0, clip and anchor at its centre 0.6) while
    // an inner list (0.4..1.0) covers that centre AND contains the row flush
    // at 0.87..0.97 - the drag reaches a scroller that moves the row, so the
    // 0.07-deficit nudge (travel 0.105, headroom 0.67) goes out.
    const panes = () => [
      n({
        role: "AXScrollArea",
        identifier: "pane",
        frame: { x: 0, y: 0.2, width: 1, height: 0.8 },
      }),
      n({
        role: "AXScrollArea",
        identifier: "inner-list",
        frame: { x: 0, y: 0.4, width: 1, height: 0.6 },
      }),
    ];
    const flush = screen([
      ...panes(),
      n({ label: "Row 9", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      ...panes(),
      n({ label: "Row 9", frame: { x: 0.1, y: 0.75, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("nested-owns-target", {
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
      await tool.execute({}, { name: "nested-owns-target", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromY).toBeCloseTo(0.6, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.105, 5);
  });

  it("skips the within nudge when a nested pane covers the named region's centre", async () => {
    // The same hole on the `within` path: naming the pane certifies that a
    // scroller occupies that rect, never that the rect's centre is free of a
    // smaller one. A map pane at 0.45..0.70 sits over the anchor (0.5, 0.6)
    // and does not contain the row flush at 0.87..0.97, so the drag would
    // scroll the map and leave the row where it is. No gesture, step passes.
    currentTree = () =>
      screen([
        n({
          role: "AXScrollArea",
          identifier: "pane",
          frame: { x: 0, y: 0.2, width: 1, height: 0.8 },
        }),
        n({
          role: "AXScrollArea",
          identifier: "map-pane",
          frame: { x: 0, y: 0.45, width: 1, height: 0.25 },
        }),
        n({ label: "Row 9", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("within-nested-pane", {
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
      await tool.execute({}, { name: "within-nested-pane", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
  });

  it("still nudges within a narrow pane whose row overhangs it sideways", async () => {
    // The reach gate's clip arm: nothing is nested over the anchor, so the
    // drag lands on the clip itself - the container whose deficit was
    // measured - and must go out even though the clip does not contain the
    // row. Leaf frames are clamped to the SCREEN, not to the scroller, so a
    // row in a side panel (x 0..0.6) can report the full width; the axis check
    // constrains the scroll axis only. Reading the gate as plain containment
    // would silently drop the nudge here. Pane bottom 1.0, row flush at
    // 0.87..0.97: deficit 0.07, travel 0.105, anchored at the pane centre
    // (0.3, 0.6).
    const pane = () =>
      n({
        role: "AXScrollArea",
        identifier: "side-panel",
        frame: { x: 0, y: 0.2, width: 0.6, height: 0.8 },
      });
    const flush = screen([
      pane(),
      n({ label: "Row 9", frame: { x: 0, y: 0.87, width: 1, height: 0.1 } }),
    ]);
    const padded = screen([
      pane(),
      n({ label: "Row 9", frame: { x: 0, y: 0.75, width: 1, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("narrow-pane", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "scroll-to",
          target: { text: "Row 9" },
          direction: "down",
          within: { identifier: "side-panel" },
        },
      ],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "narrow-pane", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromX).toBeCloseTo(0.3, 5);
    expect(swipes[0].fromY).toBeCloseTo(0.6, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.105, 5);
  });

  it("resolves the list, not its row cell, as the nudge clip on the iOS table shape", async () => {
    // The tree the fixed full-hierarchy adapter emits for a UIKit table
    // reached through a text selector: a full-bleed AXScrollArea list, the
    // row's cell as a plain (non-scroll) AXGroup leaf, and the label the text
    // resolves to inside it - all flat siblings. The adapter used to flag
    // every cell AXScrollArea too (class names contain TableView), and the
    // smallest-containing-scroller resolution then picked the CELL as the
    // clip: its end edge (0.942) fails the screen-edge gate, so no nudge was
    // dispatched and the label stayed 0.06 off the screen bottom - the
    // landing this phase exists to avoid. With the cell a plain group the
    // clip is the LIST (end edge 1.0, gate passes): label at 0.89..0.94 gives
    // clearance 0.06, deficit 0.04, travel 0.04 x 1.5 = 0.06 (above the 0.05
    // floor; headroom 0.89, so its 0.445 half-cap does not bite), anchored at
    // the list's centre.
    const cellAt = (y: number, children: DescribeNode[]) => [
      fullScreenScroller(),
      n({
        role: "AXGroup",
        identifier: "row-14-cell",
        frame: { x: 0, y, width: 1, height: 0.063 },
      }),
      ...children,
    ];
    const flush = screen(
      cellAt(0.879, [n({ label: "Row 14", frame: { x: 0.1, y: 0.89, width: 0.8, height: 0.05 } })])
    );
    const padded = screen(
      cellAt(0.739, [n({ label: "Row 14", frame: { x: 0.1, y: 0.75, width: 0.8, height: 0.05 } })])
    );
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("ios-table-cell", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Row 14" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "ios-table-cell", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromY).toBeCloseTo(0.5, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.06, 5);
  });

  it("nudges against an Android scroller kept only for its scrollable flag", async () => {
    // The Android adapter shape after the scrollable keep-gate fix
    // (flow-android-tree): an id-less RN ScrollView dumps as a scrollable
    // android.view.ViewGroup - no identifier, no label, class-fallback role -
    // and used to be pruned as layout scaffolding, so the container gate found
    // no candidate and the nudge silently skipped on Android while the same
    // app nudged on iOS. Kept as a `scrollable: true` leaf it satisfies the
    // gate via the flag alone ("ViewGroup" fails the role's /scroll/i test):
    // the row flush at 0.87..0.97 (clearance 0.03, deficit 0.07) gets one
    // nudge of 0.07 x 1.5 = 0.105 (above the 0.05 floor; headroom 0.87, so
    // its 0.435 half-cap does not bite), anchored at the scroller's centre.
    const androidScroller = () =>
      n({ role: "ViewGroup", scrollable: true, frame: { x: 0, y: 0, width: 1, height: 1 } });
    const flush = screen([
      androidScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      androidScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.75, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("android-anon-scroller", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute(
        {},
        { name: "android-anon-scroller", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    // Momentum-free, deficit-sized (0.07 x 1.5), anchored at the scroller centre.
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromY).toBeCloseTo(0.5, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.105, 5);
  });

  it("stops after one nudge when the target does not move, despite tree churn", async () => {
    // The reviewer's three-press repro distilled: the target sits in a
    // scroller flush at the screen bottom and CANNOT move (deficit 0.08 every
    // round), while the gesture's own side effects — a press counter the
    // swipe committed as a press — keep OTHER text in the region churning, so
    // the end-of-scroll fingerprint never repeats and cannot stop the loop.
    // The progress check must: after one dispatched nudge the target's entry
    // edge has not moved by EDGE_EPS, so the flush landing is accepted with
    // exactly ONE gesture. (Before the check, this shape burned the whole
    // MAX_EDGE_NUDGES budget — three real presses on the app.)
    let presses = 0;
    currentTree = () =>
      screen([
        fullScreenScroller(),
        n({
          label: `IN:${presses} OUT:${presses} PRESS:${presses}`,
          frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.3 },
        }),
        n({ label: "Last row", frame: { x: 0.1, y: 0.88, width: 0.8, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      presses++;
    });

    await writeFlow("churning-stuck-nudge", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Last row" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "churning-stuck-nudge", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    // The one gesture is nudge-sized (0.08 deficit x 1.5 = 0.12) at the
    // scroller centre - not the 0.5 half-region search increment.
    expect(swipes[0].fromY).toBeCloseTo(0.5, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.12, 5);
  });

  it("does not read a clip that moved between rounds as nudge progress", async () => {
    // Reviewer repro (Android, collapsing app bar): the clip is re-derived
    // every round, and here the scroller grows between rounds - its end edge
    // moves 0.955 -> 0.97, toward the screen edge - while the target's frame
    // is byte-identical (bottom 0.95). A clip-relative deficit would read
    // 0.095 -> 0.08: 0.015 >= EDGE_EPS of "progress" the target never made,
    // buying a second gesture. The target's own entry edge is the signal: it
    // did not move, so the first nudge is also the last.
    const scrollerOfHeight = (height: number) =>
      n({ role: "AXScrollArea", frame: { x: 0, y: 0, width: 1, height } });
    const row = () =>
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.85, width: 0.8, height: 0.1 } });
    let nudged = false;
    currentTree = () =>
      nudged ? screen([scrollerOfHeight(0.97), row()]) : screen([scrollerOfHeight(0.955), row()]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("moving-clip", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "moving-clip", project_root: tmpDir, device: ANDROID_DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    // Exactly the one nudge (0.095 deficit x 1.5), anchored at the round-1
    // scroller's centre - no follow-up bought by the clip's own movement.
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromY).toBeCloseTo(0.4775, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.1425, 5);
  });

  it("skips the start-edge nudge — at the limit the drag is pull-to-refresh", async () => {
    // An up-scroll typically lands AT the container's start limit: a FlatList
    // scrolled back to row 0 rests at contentOffset 0, and a thin list header
    // (the ordinary section-separator shape) leaves that row at 0.03..0.13 —
    // flush enough that the geometry alone demands a nudge (clearance 0.03,
    // deficit 0.07). But at-limit is invisible in the tree (adapters clamp
    // frames to the viewport, so at-rest and mid-scroll look identical), and
    // a `direction: up` nudge drags the finger DOWN — on a list with a
    // RefreshControl that IS pull-to-refresh: a read-only scroll-to would
    // refetch the list's data, on every replay, since the deficit can never
    // resolve. So a start-edge landing is accepted flush: the step passes with
    // no gesture at all. Runs on the Android device id (the on-device repro's
    // platform) while the left mirror uses the iOS one, so together they pin
    // the veto to every touch platform — not one id shape.
    currentTree = () =>
      screen([
        fullScreenScroller(),
        n({ label: "Row 0", frame: { x: 0.1, y: 0.03, width: 0.8, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("edge-nudge-up", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Row 0" }, direction: "up" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute(
        {},
        { name: "edge-nudge-up", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
  });

  it("nudges a right-scrolled target clear of a flush right-edge landing", async () => {
    // Horizontal mirror of the down case: scrolling `right`, the entry edge is
    // the RIGHT screen edge. Target at 0.87..0.97 → clearance 0.03, deficit
    // 0.07, nudge 0.105 — and to reveal content on the right the finger
    // travels LEFT (toX < fromX), the vertical anchor unmoved.
    const flush = screen([
      fullScreenScroller(),
      n({ label: "Card 9", frame: { x: 0.87, y: 0.45, width: 0.1, height: 0.1 } }),
    ]);
    const padded = screen([
      fullScreenScroller(),
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

  it("skips the left start-edge nudge — the same at-limit drag hazard", async () => {
    // Horizontal mirror of the skipped up-nudge: a `direction: left` nudge
    // drags the finger RIGHT, and a left-scroll typically lands with the
    // carousel at its start limit — undetectably, since adapters clamp
    // frames — where that drag is the horizontal refresh / edge-swipe
    // gesture. Target flush at 0.03..0.13 (clearance 0.03, deficit 0.07)
    // would demand a nudge on geometry alone; it is accepted flush with no
    // gesture.
    currentTree = () =>
      screen([
        fullScreenScroller(),
        n({ label: "Back chip", frame: { x: 0.03, y: 0.45, width: 0.1, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

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
    expect(swipes).toHaveLength(0);
  });

  it("searches on chromium with wheel events, not touch swipes", async () => {
    // The plain search phase on a browser target: the device id shape
    // (chromium-cdp-<port>) routes the increment through gesture-scroll
    // instead of gesture-swipe, one half-viewport wheel burst per round
    // (region is the full screen → deltaY 0.5), anchored at the screen
    // centre. Chromium dispatches no nudges at all, so this is the only
    // scroll a flow can make there.
    const domScroller = () => n({ scrollable: true, frame: { x: 0, y: 0, width: 1, height: 1 } });
    const offscreen = screen([
      domScroller(),
      n({ label: "Top", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
    ]);
    const withTarget = screen([
      domScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.1 } }),
    ]);
    let revealed = false;
    currentTree = () => (revealed ? withTarget : offscreen);

    const swipes: SwipeCall[] = [];
    const scrolls: ScrollCall[] = [];
    const registry = mockRegistry(
      swipes,
      () => {
        revealed = true;
      },
      scrolls
    );

    await writeFlow("chromium-search", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute(
        {},
        { name: "chromium-search", project_root: tmpDir, device: CHROMIUM_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0].deltaY).toBeCloseTo(0.5, 5);
    expect(scrolls[0].deltaX).toBeUndefined();
    expect(scrolls[0].x).toBeCloseTo(0.5, 5);
    expect(scrolls[0].y).toBeCloseTo(0.5, 5);
  });

  it("never nudges on chromium — nothing overlays a browser viewport", async () => {
    // The device id shape selects the platform (chromium-cdp-<port> →
    // chromium). The exact end-edge geometry a touch device nudges (target
    // 0.88..0.98 inside a full-bleed scroller, clearance 0.02, deficit 0.08)
    // must dispatch NOTHING here: a page has no home indicator, gesture-nav
    // bar or floating tab bar over it, so there is no chrome to clear — and a
    // wheel at the scroller's limit is not the no-op it looks like, Chrome
    // chains it to the nearest scrollable ancestor and scrolls the page. The
    // scroller leaf carries the `scrollable` flag (the CDP DOM walker's
    // shape, no AX role), so the target does pass the container gate — the
    // platform is what declines.
    const domScroller = () => n({ scrollable: true, frame: { x: 0, y: 0, width: 1, height: 1 } });
    currentTree = () =>
      screen([
        domScroller(),
        n({ label: "Order #1234", frame: { x: 0.1, y: 0.88, width: 0.8, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const scrolls: ScrollCall[] = [];
    const registry = mockRegistry(swipes, undefined, scrolls);

    await writeFlow("chromium-no-nudge", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute(
        {},
        { name: "chromium-no-nudge", project_root: tmpDir, device: CHROMIUM_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
    expect(scrolls).toHaveLength(0);
  });

  it("never nudges on a tvOS simulator - touch input is rejected there", async () => {
    // A tvOS sim's UDID has the same GUID shape as an iOS one, so it
    // classifies as platform "ios", and this is the exact geometry the first
    // edge-nudge test dispatches for on a phone sim (flush at 0.87..0.97 in a
    // full-bleed scroller - that test, running on the default not-tv mock, is
    // this one's mobile control). But the simulator-server rejects touch for
    // tvOS: before the nudge existed, an already-visible target was the only
    // scroll-to shape that could succeed on Apple TV, and it must stay a
    // zero-gesture pass - the runtime-kind probe vetoes the phase.
    vi.mocked(isTvOsSimulator).mockResolvedValue(true);
    currentTree = () =>
      screen([
        fullScreenScroller(),
        n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("tvos-no-nudge", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "tvos-no-nudge", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
    expect(isTvOsSimulator).toHaveBeenCalledWith(DEVICE);
  });

  it("never nudges on an Android TV - a leanback UI is D-pad driven", async () => {
    // A leanback device shares the `emulator-NNNN` serial shape with a phone
    // AVD, so it classifies as platform "android" and reaches the same nudge
    // gate - only the runtime probe tells them apart. The geometry is the one
    // the Android phone control below dispatches for (flush at 0.87..0.97 in a
    // full-bleed scroller), but a focus-driven UI has no touch, so the swipe
    // would move nothing: an already-visible target must stay the zero-gesture
    // pass it was before the nudge existed, not spend a swipe and a settle.
    vi.mocked(isAndroidTv).mockResolvedValue(true);
    currentTree = () =>
      screen([
        fullScreenScroller(),
        n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("android-tv-no-nudge", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute(
        {},
        { name: "android-tv-no-nudge", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
    expect(isAndroidTv).toHaveBeenCalledWith(ANDROID_DEVICE);
  });

  it("still nudges on an Android phone - the TV veto is not blanket-Android", async () => {
    // The negative control for the case above: same serial shape, same
    // geometry, probe answering "mobile". The veto must key on the runtime
    // probe and not on the `android` platform tag, so a phone keeps its one
    // deficit-sized nudge (0.07 x 1.5).
    const flush = screen([
      fullScreenScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.87, width: 0.8, height: 0.1 } }),
    ]);
    const padded = screen([
      fullScreenScroller(),
      n({ label: "Order #1234", frame: { x: 0.1, y: 0.75, width: 0.8, height: 0.1 } }),
    ]);
    let nudged = false;
    currentTree = () => (nudged ? padded : flush);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      nudged = true;
    });

    await writeFlow("android-phone-nudge", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute(
        {},
        { name: "android-phone-nudge", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(1);
    expect(swipes[0].settle).toBe(true);
    expect(swipes[0].fromY).toBeCloseTo(0.5, 5);
    expect(swipes[0].fromY - swipes[0].toY).toBeCloseTo(0.105, 5);
  });

  it("still nudges when the Android TV probe rejects - a dead probe cannot fail the step", async () => {
    // The android probe shells out to `adb devices`, which rejects outright on
    // a missing adb or a client/server version mismatch - an everyday condition
    // with two platform-tools installs on the PATH. Nothing between the gate
    // and the step runner catches, so an unguarded rejection would report the
    // step `error` and stop the run for a target that was already fully
    // visible. A probe that cannot answer must resolve as not-tv: the run then
    // costs a TV the bounded nudges below instead of a failed step. The
    // geometry is the snapping list from "gives up after MAX_EDGE_NUDGES", so
    // the rounds also pin that the fallback verdict is memoized - one probe
    // call for three nudges, not one per round.
    vi.mocked(isAndroidTv).mockRejectedValue(new Error("adb devices failed: adb: not found"));
    const at = (y: number) =>
      screen([
        fullScreenScroller(),
        n({ label: "Snappy row", frame: { x: 0.1, y, width: 0.8, height: 0.08 } }),
      ]);
    const positions = [0.9, 0.88, 0.86, 0.85];
    let round = 0;
    currentTree = () => at(positions[Math.min(round, positions.length - 1)]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes, () => {
      round++;
    });

    await writeFlow("android-probe-dead", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Snappy row" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute(
        {},
        { name: "android-probe-dead", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["scroll-to:pass"]);
    expect(swipes).toHaveLength(3);
    expect(isAndroidTv).toHaveBeenCalledTimes(1);
    expect(isAndroidTv).toHaveBeenCalledWith(ANDROID_DEVICE);
  });

  it("does not probe the runtime kind when the geometry asks for no nudge", async () => {
    // The tv veto only matters when a gesture is about to go out, and the probe
    // shells out to `xcrun simctl` (seconds on a cold list, no cache for a UDID
    // the list doesn't resolve). Most accepted iOS targets need no nudge at
    // all - here the row at 0.80..0.903 is already within EDGE_EPS of the
    // padding, the same landing that "leaves a landing a hair short of the
    // padding alone" pins - so the pure geometry must decide first and this must
    // stay the zero-I/O return it was before the nudge existed.
    currentTree = () =>
      screen([
        fullScreenScroller(),
        n({ label: "Order #1234", frame: { x: 0.1, y: 0.8, width: 0.8, height: 0.103 } }),
      ]);

    const swipes: SwipeCall[] = [];
    const registry = mockRegistry(swipes);

    await writeFlow("no-nudge-no-probe", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const tool = createRunFlowTool(registry);
    const result = asRun(
      await tool.execute({}, { name: "no-nudge-no-probe", project_root: tmpDir, device: DEVICE })
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(swipes).toHaveLength(0);
    expect(isTvOsSimulator).not.toHaveBeenCalled();
  });
});
