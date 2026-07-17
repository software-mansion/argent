import { describe, expect, it, vi } from "vitest";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Serve the flow tree directly: flows resolve selectors against the platform's
// full-hierarchy source and hard-fail rather than degrade to the AX tree, so
// these unit tests stub the tree fetch itself.
let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "native-devtools",
    })
  ),
}));

import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";
import { createFlowTestHarness, n, screen } from "./harness";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const { writeFlow, runWithCalls: run } = createFlowTestHarness({
  tempDirectoryPrefix: "flow-swipe-",
  reset: () => {
    currentTree = () => screen([]);
  },
});

describe("swipe: parse/serialize", () => {
  it("round-trips every spelling", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        { kind: "swipe" as const, direction: "left" as const },
        {
          kind: "swipe" as const,
          from: { selector: { text: "Card", loose: true } },
          direction: "up" as const,
        },
        { kind: "swipe" as const, from: { x: 0.5, y: 0.8 }, by: { y: -0.4 } },
        { kind: "swipe" as const, by: { x: 0.2, y: -0.3 }, settle: true },
        {
          kind: "swipe" as const,
          from: { selector: { identifier: "card" } },
          to: { selector: { identifier: "archive" } },
        },
        { kind: "swipe" as const, from: { x: 0.9, y: 0.5 }, to: { x: 0.1, y: 0.5 }, duration: 800 },
      ],
    };
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it.each([
    ["no travel", { kind: "swipe" as const }],
    ["from without travel", { kind: "swipe" as const, from: { x: 0.5, y: 0.5 } }],
    ["direction and by", { kind: "swipe" as const, direction: "left" as const, by: { x: -0.2 } }],
    [
      "to and by",
      {
        kind: "swipe" as const,
        to: { x: 0.1, y: 0.5 },
        by: { x: -0.2 },
      },
    ],
  ])("rejects a programmatic swipe with %s", (_description, step) => {
    expect(() => serializeFlow({ executionPrerequisite: "", steps: [step] })).toThrow(
      /cannot serialize flow swipe: needs exactly one of direction, to, or by/i
    );
  });

  it.each([
    ["no axes", {}],
    ["a zero axis", { x: 0 }],
    ["an out-of-range axis", { y: -1.1 }],
    ["a non-finite axis", { x: Number.NaN }],
  ])("rejects programmatic by travel with %s", (_description, by) => {
    expect(() =>
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "swipe", by }] })
    ).toThrow(/cannot serialize flow swipe\.by/i);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("rejects a programmatic swipe duration that is %s", (_description, duration) => {
    expect(() =>
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "swipe", direction: "left", duration }],
      })
    ).toThrow(/cannot serialize flow swipe\.duration: needs a positive number of milliseconds/i);
  });

  it("bare-direction sugar: a direction-only swipe serializes back to the bare string", () => {
    const steps = parseFlow("steps:\n  - swipe: left\n").steps;
    expect(steps).toEqual([{ kind: "swipe", direction: "left" }]);
    expect(serializeFlow({ executionPrerequisite: "", steps })).toContain("- swipe: left");
    // Any other option forces the map form.
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "swipe", direction: "left", settle: true }],
    });
    expect(yaml).toContain("direction: left");
    expect(yaml).toContain("settle: true");
  });

  it("rejects a bare string that is not a direction", () => {
    expect(() => parseFlow("steps:\n  - swipe: Login\n")).toThrow(
      /swipe takes a direction \(up, down, left, right\)/i
    );
  });

  it("requires exactly one of direction, to, by", () => {
    expect(() => parseFlow("steps:\n  - swipe: { from: Card }\n")).toThrow(
      /exactly one of `direction`, `to`, or `by`/i
    );
    expect(() => parseFlow("steps:\n  - swipe: { direction: left, by: { x: -0.3 } }\n")).toThrow(
      /exactly one of `direction`, `to`, or `by`/i
    );
  });

  it("rejects top-level selector fields and points with the nested-target hints", () => {
    expect(() => parseFlow('steps:\n  - swipe: { text: "Card", direction: left }\n')).toThrow(
      /options form takes a nested target/i
    );
    expect(() => parseFlow("steps:\n  - swipe: { id: card, direction: left }\n")).toThrow(
      /options form takes a nested target/i
    );
    expect(() => parseFlow("steps:\n  - swipe: { x: 0.5, y: 0.5, direction: left }\n")).toThrow(
      /options form takes a nested point/i
    );
  });

  it("suggests the closest swipe option for an unknown key", () => {
    expect(() => parseFlow("steps:\n  - swipe: { direction: left, duraton: 800 }\n")).toThrow(
      /swipe has unknown key `duraton` \(did you mean `duration`\?\).*allowed keys/i
    );
    expect(() => parseFlow("steps:\n  - swipe: { direction: left, foo: 1 }\n")).toThrow(
      /swipe has unknown key `foo`.*allowed keys: from, direction, to, by, settle, duration/i
    );
  });

  it("validates by: axes, range, zero, and junk keys", () => {
    expect(() => parseFlow("steps:\n  - swipe: { by: {} }\n")).toThrow(/at least one of x, y/i);
    expect(() => parseFlow("steps:\n  - swipe: { by: { x: 0 } }\n")).toThrow(
      /non-zero fraction .*omit the axis/i
    );
    expect(() => parseFlow("steps:\n  - swipe: { by: { x: 1.5 } }\n")).toThrow(/between -1 and 1/i);
    expect(() => parseFlow('steps:\n  - swipe: { by: { x: "0.3" } }\n')).toThrow(
      /non-zero fraction/i
    );
  });

  it("suggests the closest swipe.by axis for an unknown key", () => {
    expect(() => parseFlow("steps:\n  - swipe: { by: { x: 0.3, yy: 0.2 } }\n")).toThrow(
      /swipe\.by has unknown key `yy` \(did you mean `y`\?\).*allowed keys: x, y/i
    );
    expect(() => parseFlow("steps:\n  - swipe: { by: { x: 0.3, z: 1 } }\n")).toThrow(
      /swipe\.by has unknown key `z`.*allowed keys: x, y/i
    );
  });

  it("validates direction, settle, and duration values", () => {
    expect(() => parseFlow("steps:\n  - swipe: { direction: diagonal }\n")).toThrow(
      /swipe.direction must be one of up, down, left, right/i
    );
    expect(() => parseFlow('steps:\n  - swipe: { direction: left, settle: "yes" }\n')).toThrow(
      /settle must be true or false/i
    );
    expect(() => parseFlow("steps:\n  - swipe: { direction: left, duration: .inf }\n")).toThrow(
      /duration needs a positive number/i
    );
    expect(() => parseFlow("steps:\n  - swipe: { direction: left, duration: 0 }\n")).toThrow(
      /duration needs a positive number/i
    );
  });

  it("normalizes settle: false to absent (round-trip stays inverse)", () => {
    const steps = parseFlow("steps:\n  - swipe: { direction: left, settle: false }\n").steps;
    expect(steps).toEqual([{ kind: "swipe", direction: "left" }]);
  });

  it("from carries the usual target sugar: bare = loose, map = strict, point = point", () => {
    const steps = parseFlow(
      "steps:\n" +
        "  - swipe: { from: Card, direction: left }\n" +
        "  - swipe: { from: { text: Card }, direction: left }\n" +
        "  - swipe: { from: { x: 0.5, y: 0.5 }, direction: left }\n"
    ).steps;
    expect(steps).toEqual([
      { kind: "swipe", from: { selector: { text: "Card", loose: true } }, direction: "left" },
      { kind: "swipe", from: { selector: { text: "Card" } }, direction: "left" },
      { kind: "swipe", from: { x: 0.5, y: 0.5 }, direction: "left" },
    ]);
  });
});

describe("swipe: execution", () => {
  it("whole-screen direction uses the Maestro geometry table", async () => {
    await writeFlow("page", {
      executionPrerequisite: "",
      steps: [
        { kind: "swipe", direction: "left" },
        { kind: "swipe", direction: "right" },
        { kind: "swipe", direction: "down" },
        { kind: "swipe", direction: "up" },
      ],
    });

    const result = await run("page");

    expect(result.ok).toBe(true);
    expect(result.calls.map((c) => c.args)).toEqual([
      { udid: DEVICE, fromX: 0.9, fromY: 0.5, toX: 0.1, toY: 0.5 },
      { udid: DEVICE, fromX: 0.1, fromY: 0.5, toX: 0.9, toY: 0.5 },
      { udid: DEVICE, fromX: 0.5, fromY: 0.2, toX: 0.5, toY: 0.9 },
      { udid: DEVICE, fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.1 },
    ]);
    expect(result.calls.every((c) => c.tool === "gesture-swipe")).toBe(true);
  });

  it("an anchored direction keeps the anchor's cross-axis coordinate", async () => {
    currentTree = () =>
      screen([n({ label: "Card", frame: { x: 0.4, y: 0.25, width: 0.4, height: 0.1 } })]);
    await writeFlow("dismiss", {
      executionPrerequisite: "",
      steps: [
        { kind: "swipe", from: { selector: { text: "Card", loose: true } }, direction: "left" },
      ],
    });

    const result = await run("dismiss");

    expect(result.ok).toBe(true);
    // Card centre is (0.6, 0.3): travel to the end line x=0.1, y stays 0.3.
    expect(result.calls[0]).toMatchObject({
      tool: "gesture-swipe",
      args: { fromX: expect.closeTo(0.6, 10), fromY: 0.3, toX: 0.1, toY: 0.3 },
    });
  });

  it("keeps an on-screen selector anchor verbatim inside an OS gesture zone", async () => {
    currentTree = () =>
      screen([n({ label: "Card", frame: { x: 0.4, y: 0.94, width: 0.4, height: 0.06 } })]);
    await writeFlow("edge-anchor", {
      executionPrerequisite: "",
      steps: [
        { kind: "swipe", from: { selector: { text: "Card", loose: true } }, direction: "left" },
      ],
    });

    const result = await run("edge-anchor");

    expect(result.ok).toBe(true);
    expect(result.calls[0]).toMatchObject({
      tool: "gesture-swipe",
      args: {
        fromX: expect.closeTo(0.6, 10),
        fromY: expect.closeTo(0.97, 10),
        toX: 0.1,
        toY: expect.closeTo(0.97, 10),
      },
    });
  });

  it.each([
    ["left", { x: 0.05, y: 0.5 }, "right", "x=0.05", "x=0.1"],
    ["right", { x: 0.95, y: 0.5 }, "left", "x=0.95", "x=0.9"],
    ["up", { x: 0.5, y: 0.05 }, "down", "y=0.05", "y=0.1"],
    ["down", { x: 0.5, y: 0.95 }, "up", "y=0.95", "y=0.9"],
  ] as const)(
    "fails an anchored %s swipe that would travel in the opposite direction",
    async (direction, from, actualDirection, startCoordinate, endCoordinate) => {
      await writeFlow(`reversed-${direction}`, {
        executionPrerequisite: "",
        steps: [{ kind: "swipe", from, direction }],
      });

      const result = await run(`reversed-${direction}`);

      expect(result.ok).toBe(false);
      expect(result.steps[0]).toMatchObject({ kind: "swipe", status: "fail" });
      expect(result.steps[0].reason).toContain(`cannot swipe ${direction}`);
      expect(result.steps[0].reason).toContain(startCoordinate);
      expect(result.steps[0].reason).toContain(`preset endpoint is ${endCoordinate}`);
      expect(result.steps[0].reason).toContain(`would travel ${actualDirection}`);
      expect(result.calls).toEqual([]);
    }
  );

  it.each([
    ["left", { x: 0.1, y: 0.5 }],
    ["right", { x: 0.9, y: 0.5 }],
    ["up", { x: 0.5, y: 0.1 }],
    ["down", { x: 0.5, y: 0.9 }],
  ] as const)("fails an anchored %s swipe with zero travel", async (direction, from) => {
    await writeFlow(`collapsed-${direction}`, {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", from, direction }],
    });

    const result = await run(`collapsed-${direction}`);

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "swipe",
      status: "fail",
      reason: expect.stringContaining("would have zero travel"),
    });
    expect(result.calls).toEqual([]);
  });

  it("allows short anchored direction travel when it still has the requested sign", async () => {
    await writeFlow("short-direction-travel", {
      executionPrerequisite: "",
      steps: [
        { kind: "swipe", from: { x: 0.100001, y: 0.5 }, direction: "left" },
        { kind: "swipe", from: { x: 0.899999, y: 0.5 }, direction: "right" },
        { kind: "swipe", from: { x: 0.5, y: 0.100001 }, direction: "up" },
        { kind: "swipe", from: { x: 0.5, y: 0.899999 }, direction: "down" },
      ],
    });

    const result = await run("short-direction-travel");

    expect(result.ok).toBe(true);
    expect(result.calls).toHaveLength(4);
  });

  it("rejects a selector-derived start whose direction cross-axis is off-screen", async () => {
    currentTree = () =>
      screen([n({ label: "Card", frame: { x: 0.4, y: 1.0, width: 0.4, height: 0.1 } })]);
    await writeFlow("offscreen-anchor", {
      executionPrerequisite: "",
      steps: [
        { kind: "swipe", from: { selector: { text: "Card", loose: true } }, direction: "left" },
      ],
    });

    const result = await run("offscreen-anchor");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      status: "fail",
      reason: expect.stringMatching(/swipe\.from resolved outside.*between 0 and 1/i),
    });
    expect(result.calls).toEqual([]);
  });

  it("by travels relative to the anchor and saturates supplied axes to screen bounds", async () => {
    await writeFlow("deltas", {
      executionPrerequisite: "",
      steps: [
        { kind: "swipe", from: { x: 0.5, y: 0.8 }, by: { y: -0.4 } },
        { kind: "swipe", from: { x: 0.97, y: 0.03 }, by: { x: 0.2, y: -0.2 } },
      ],
    });

    const result = await run("deltas");

    expect(result.ok).toBe(true);
    expect(result.calls.map((c) => c.args)).toEqual([
      { udid: DEVICE, fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.4 },
      { udid: DEVICE, fromX: 0.97, fromY: 0.03, toX: 1, toY: 0 },
    ]);
  });

  it("fails by travel when saturation leaves no room on a requested axis", async () => {
    await writeFlow("no-room", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", from: { x: 1, y: 0.5 }, by: { x: 0.2, y: 0.2 } }],
    });

    const result = await run("no-room");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "swipe",
      status: "fail",
      reason: expect.stringMatching(
        /swipe\.by\.x requests positive travel from x=1.*\[0, 1\].*no travel.*choose a start point/i
      ),
    });
    expect(result.calls).toEqual([]);
  });

  it("to resolves a target endpoint; settle and duration ride the gesture", async () => {
    currentTree = () =>
      screen([n({ label: "Archive", frame: { x: 0.0, y: 0.9, width: 0.2, height: 0.1 } })]);
    await writeFlow("to-target", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "swipe",
          from: { x: 0.5, y: 0.5 },
          to: { selector: { text: "Archive", loose: true } },
          settle: true,
          duration: 800,
        },
      ],
    });

    const result = await run("to-target");

    expect(result.ok).toBe(true);
    expect(result.calls[0]).toMatchObject({
      tool: "gesture-swipe",
      args: {
        fromX: 0.5,
        fromY: 0.5,
        toX: 0.1,
        toY: expect.closeTo(0.95, 10),
        settle: true,
        durationMs: 800,
      },
    });
  });

  it("maps to a mouse drag on chromium (settle dropped — a drag has no momentum)", async () => {
    await writeFlow("desktop", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", direction: "left", settle: true, duration: 500 }],
    });

    const result = await run("desktop", "chromium-cdp-9222");

    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      {
        tool: "gesture-drag",
        args: {
          udid: "chromium-cdp-9222",
          fromX: 0.9,
          fromY: 0.5,
          toX: 0.1,
          toY: 0.5,
          durationMs: 500,
        },
      },
    ]);
  });
});
