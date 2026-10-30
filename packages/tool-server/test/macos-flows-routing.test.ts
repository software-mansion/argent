import { describe, expect, it, vi } from "vitest";
import type {
  DescribeNode,
  DescribeSource,
  DescribeTreeData,
} from "../src/tools/describe/contract";
import type { FlowStep } from "../src/tools/flows/flow-utils";

// The directives that pick a gesture by input model, and the type step's focus
// poll, on a Mac app. The flow tree is served directly: the macOS tree source
// has its own tests, and routing only needs a tree with the right source tag.
let currentTree: () => DescribeNode;
let currentSource: DescribeSource;
let treeReads = 0;
vi.mock("../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    treeReads++;
    return { tree: currentTree(), source: currentSource };
  }),
}));

import { useMacosAppsFlag } from "./helpers/macos-apps-flag";
import { createFlowTestHarness, n, screen } from "./flows/harness";

useMacosAppsFlag();

const MAC = "macos-app-com.argent.probe";

const { writeFlow, runWithCalls } = createFlowTestHarness({
  tempDirectoryPrefix: "macos-flows-routing-",
  reset: () => {
    currentTree = () => screen([]);
    currentSource = "macos-devtools";
    treeReads = 0;
  },
});

/** Runs `steps` on the Mac app; `onCall` sees each tool call and may throw to fail it. */
async function runSteps(steps: FlowStep[], onCall?: Parameters<typeof runWithCalls>[2]) {
  await writeFlow("routing", { executionPrerequisite: "", steps });
  return runWithCalls("routing", MAC, onCall);
}

describe("scroll-to on a Mac app", () => {
  it.each([
    // Half the 0.4-high container, from its centre.
    ["down", { x: 0.1, y: 0.2, width: 0.8, height: 0.4 }, { x: 0.5, y: 0.4, deltaY: 0.2 }],
    // The whole window: half of it at most.
    ["up", { x: 0, y: 0, width: 1, height: 1 }, { x: 0.5, y: 0.5, deltaY: -0.5 }],
    ["left", { x: 0, y: 0, width: 1, height: 1 }, { deltaX: -0.5 }],
    ["right", { x: 0, y: 0, width: 1, height: 1 }, { deltaX: 0.5 }],
    // A short container: at least 0.05.
    ["down", { x: 0.1, y: 0.5, width: 0.8, height: 0.06 }, { deltaY: 0.05 }],
  ] as const)(
    "scrolls %s with one gesture-scroll sized to the container %j, never gesture-swipe",
    async (direction, pane, expected) => {
      let scrolled = false;
      // A scroll view whose row appears once the first wheel step lands.
      currentTree = () =>
        screen([
          n({ role: "AXScrollArea", identifier: "appkit.scroll", scrollable: true, frame: pane }),
          ...(scrolled
            ? [
                n({
                  role: "AXStaticText",
                  value: "row 15",
                  frame: { ...pane, y: pane.y + 0.01, height: 0.03 },
                }),
              ]
            : []),
        ]);
      const result = await runSteps(
        [
          {
            kind: "scroll-to",
            target: { text: "row 15" },
            direction,
            within: { identifier: "appkit.scroll" },
          },
        ],
        (call) => {
          if (call.tool === "gesture-scroll") scrolled = true;
        }
      );
      expect(result.ok).toBe(true);
      expect(result.calls.map((c) => c.tool)).toEqual(["gesture-scroll"]);
      const args = result.calls[0]!.args;
      expect(args.udid).toBe(MAC);
      for (const [key, value] of Object.entries(expected)) {
        expect(args[key] as number).toBeCloseTo(value);
      }
    }
  );

  it("ends the scroll over nothing that scrolls, and says to name the container", async () => {
    currentTree = () =>
      screen([
        n({
          role: "AXButton",
          label: "Only button",
          frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 },
        }),
      ]);
    const result = await runSteps(
      [{ kind: "scroll-to", target: { text: "row 15" }, direction: "down" }],
      (call) => {
        if (call.tool === "gesture-scroll") throw new Error("No scrollable view at the point");
      }
    );
    expect(result.steps[0]).toMatchObject({
      status: "fail",
      reason: expect.stringMatching(/nothing scrolls.*within:/),
    });
    expect(result.calls.map((c) => c.tool)).toEqual(["gesture-scroll"]);
  });

  it("still errors on any other gesture-scroll failure", async () => {
    const result = await runSteps(
      [{ kind: "scroll-to", target: { text: "row 15" }, direction: "down" }],
      (call) => {
        if (call.tool === "gesture-scroll") {
          throw new Error("com.argent.probe did not answer Input.scroll");
        }
      }
    );
    expect(result.steps[0]).toMatchObject({
      status: "error",
      reason: expect.stringMatching(/did not answer Input\.scroll/),
    });
  });
});

describe("long-press and swipe on a Mac app", () => {
  it.each<[string, FlowStep, Record<string, unknown>]>([
    [
      "long-press as a mouse press-hold-release, from == to",
      { kind: "long-press", selector: { identifier: "appkit.slider" }, duration: 900 },
      { fromX: 0.4, fromY: 0.72, toX: 0.4, toY: 0.72, durationMs: 900 },
    ],
    [
      "swipe as a mouse drag",
      { kind: "swipe", from: { x: 0.15, y: 0.72 }, to: { x: 0.65, y: 0.72 }, duration: 400 },
      { fromX: 0.15, fromY: 0.72, toX: 0.65, toY: 0.72, durationMs: 400 },
    ],
  ])("sends %s through gesture-drag", async (_label, step, expected) => {
    currentTree = () =>
      screen([
        n({
          role: "AXSlider",
          identifier: "appkit.slider",
          value: "0",
          frame: { x: 0.1, y: 0.7, width: 0.6, height: 0.04 },
        }),
      ]);
    const result = await runSteps([step]);
    expect(result.ok).toBe(true);
    expect(result.calls.map((c) => c.tool)).toEqual(["gesture-drag"]);
    const args = result.calls[0]!.args;
    expect(args.udid).toBe(MAC);
    for (const [key, value] of Object.entries(expected)) {
      expect(args[key] as number).toBeCloseTo(value as number);
    }
  });
});

describe("a right tap on a Mac app", () => {
  it("is gesture-tap with the right button at the element centre, then a plain tap on the menu item", async () => {
    let menuOpen = false;
    currentTree = () =>
      screen([
        n({ identifier: "box.context", frame: { x: 0.2, y: 0.4, width: 0.2, height: 0.1 } }),
        ...(menuOpen
          ? [
              n({
                role: "AXMenuItem",
                label: "Ctx One",
                frame: { x: 0.3, y: 0.5, width: 0.2, height: 0.04 },
              }),
            ]
          : []),
      ]);
    const result = await runSteps(
      [
        { kind: "tap", selector: { identifier: "box.context" }, button: "right" },
        { kind: "tap", selector: { text: "Ctx One" } },
      ],
      (call) => {
        if (call.tool === "gesture-tap" && call.args.button === "right") menuOpen = true;
      }
    );
    expect(result.ok).toBe(true);
    expect(result.calls.map((c) => c.tool)).toEqual(["gesture-tap", "gesture-tap"]);
    const [right, item] = result.calls.map((c) => c.args as Record<string, number | string>);
    expect(right).toMatchObject({ udid: MAC, button: "right" });
    expect(right!.x).toBeCloseTo(0.3);
    expect(right!.y).toBeCloseTo(0.45);
    expect(right).not.toHaveProperty("clickCount");
    expect(item).not.toHaveProperty("button");
    expect(item!.x).toBeCloseTo(0.4);
    expect(item!.y).toBeCloseTo(0.52);
  });

  it("carries times beside the button as clickCount", async () => {
    const result = await runSteps([{ kind: "tap", x: 0.5, y: 0.5, times: 2, button: "right" }]);
    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      {
        tool: "gesture-tap",
        args: { udid: MAC, x: 0.5, y: 0.5, clickCount: 2, button: "right" },
      },
    ]);
  });
});

describe("pinch and rotate on a Mac app", () => {
  it.each<FlowStep>([
    { kind: "pinch", selector: { identifier: "map" }, scale: 2 },
    { kind: "rotate", selector: { identifier: "map" }, by: 90 },
  ])("refuses $kind with the platform in the reason, before any read or input", async (step) => {
    currentTree = () =>
      screen([n({ identifier: "map", frame: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 } })]);
    const result = await runSteps([step]);
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: step.kind,
      status: "fail",
      reason: expect.stringMatching(new RegExp(`^${step.kind} is unsupported on macos — `)),
    });
    expect(result.calls).toHaveLength(0);
    expect(treeReads).toBe(0);
  });
});

describe("type on a Mac app", () => {
  // Reads after the focus tap: the first shows the field unfocused, the next
  // ones focused. A source that reports focus is polled until the second read;
  // one that does not is looked at once.
  async function typeRun(source: DescribeSource) {
    currentSource = source;
    let tapped = false;
    let readsAfterTap = 0;
    let lastReadFocused = false;
    currentTree = () => {
      if (tapped) readsAfterTap++;
      lastReadFocused = readsAfterTap >= 2;
      return screen([
        n({
          role: "AXTextField",
          identifier: "appkit.field",
          frame: { x: 0.1, y: 0.2, width: 0.6, height: 0.05 },
          ...(lastReadFocused ? { focused: true } : {}),
        }),
      ]);
    };
    let focusSeenBeforeKeys = false;
    const result = await runSteps(
      [{ kind: "type", into: { identifier: "appkit.field" }, text: "hello world" }],
      (call) => {
        if (call.tool === "gesture-tap") tapped = true;
        if (call.tool === "keyboard" && call.args.text !== undefined) {
          focusSeenBeforeKeys = lastReadFocused;
        }
      }
    );
    return { result, readsAfterTap, focusSeenBeforeKeys };
  }

  it.each(["macos-devtools", "macos-fallback"] as const)(
    "polls the %s tree until the field reports focus, then types",
    async (source) => {
      const { result, readsAfterTap, focusSeenBeforeKeys } = await typeRun(source);
      expect(result.ok).toBe(true);
      expect(result.calls.map((c) => c.tool)).toEqual(["gesture-tap", "keyboard", "keyboard"]);
      expect(result.calls[1]!.args).toMatchObject({ udid: MAC, text: "hello world" });
      expect(result.calls[2]!.args).toMatchObject({ udid: MAC, key: "enter" });
      expect(readsAfterTap).toBe(2);
      expect(focusSeenBeforeKeys).toBe(true);
    }
  );

  it("looks once and types on a source outside the focus set (the control)", async () => {
    const { result, readsAfterTap, focusSeenBeforeKeys } = await typeRun("ax-service");
    expect(result.ok).toBe(true);
    expect(readsAfterTap).toBe(1);
    expect(focusSeenBeforeKeys).toBe(false);
  });
});
