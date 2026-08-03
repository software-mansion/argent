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
    ["a sub-threshold delta", 0.0005],
    ["float dust", 1e-17],
  ])("rejects programmatic by travel with %s as undeliverable", (_description, x) => {
    expect(() =>
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "swipe", by: { x } }] })
    ).toThrow(/cannot serialize flow swipe\.by\.x: .*below the minimum deliverable travel/i);
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

  it.each([
    ["a sub-threshold delta", "0.0005"],
    ["float dust", "0.00000000000000001"],
  ])("rejects a by axis of %s as undeliverable travel", (_description, value) => {
    expect(() => parseFlow(`steps:\n  - swipe: { by: { x: ${value} } }\n`)).toThrow(
      /swipe\.by\.x .*below the minimum deliverable travel.*too small to move a finger/i
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

  it("fails an anchored direction swipe whose centre lands dust-close to the preset line", async () => {
    // Centre x computes to 0.8999999999999999 — bit-distinct from the right
    // preset's end line x=0.9, so `===` would dispatch a stationary press.
    currentTree = () =>
      screen([n({ label: "Card", frame: { x: 0.84, y: 0.4, width: 0.12, height: 0.2 } })]);
    await writeFlow("dust-direction", {
      executionPrerequisite: "",
      steps: [
        { kind: "swipe", from: { selector: { text: "Card", loose: true } }, direction: "right" },
      ],
    });

    const result = await run("dust-direction");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "swipe",
      status: "fail",
      reason: expect.stringContaining("would have zero travel"),
    });
    expect(result.calls).toEqual([]);
  });

  it("allows short anchored direction travel when it still has the requested sign", async () => {
    // 0.002 of travel: short, but above the deliverable-travel floor.
    await writeFlow("short-direction-travel", {
      executionPrerequisite: "",
      steps: [
        { kind: "swipe", from: { x: 0.102, y: 0.5 }, direction: "left" },
        { kind: "swipe", from: { x: 0.898, y: 0.5 }, direction: "right" },
        { kind: "swipe", from: { x: 0.5, y: 0.102 }, direction: "up" },
        { kind: "swipe", from: { x: 0.5, y: 0.898 }, direction: "down" },
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

  it.each([
    // Schema-conformant frame — describeFrameSchema bounds x/y/width/height to
    // [0, 1] independently, so x=0.85 + width 0.4 parses fine yet centres at
    // x=1.05 — the exact shape an adapter viewport-clipping regression would
    // emit, with only this guard left between it and the touch-down.
    ["off the right edge (x > 1)", { x: 0.85, y: 0.4, width: 0.4, height: 0.2 }, "up"],
    // A negative origin cannot pass the frame schema, but the guard sits
    // behind adapters and mocked trees that bypass it — pin the < 0 arms too.
    ["off the left edge (x < 0)", { x: -0.5, y: 0.4, width: 0.2, height: 0.2 }, "up"],
    ["off the top edge (y < 0)", { x: 0.4, y: -0.5, width: 0.2, height: 0.2 }, "left"],
  ] as const)(
    "rejects a selector-derived start whose centre resolves %s",
    async (_description, frame, direction) => {
      currentTree = () => screen([n({ label: "Card", frame })]);
      await writeFlow("offscreen-centre", {
        executionPrerequisite: "",
        steps: [{ kind: "swipe", from: { selector: { text: "Card", loose: true } }, direction }],
      });

      const result = await run("offscreen-centre");

      expect(result.ok).toBe(false);
      expect(result.steps[0]).toMatchObject({
        status: "fail",
        reason: expect.stringMatching(/swipe\.from resolved outside.*between 0 and 1/i),
      });
      expect(result.calls).toEqual([]);
    }
  );

  it.each([
    ["x", { x: Number.NaN, y: 0.4, width: 0.4, height: 0.2 }, "up"],
    ["y", { x: 0.4, y: Number.NaN, width: 0.4, height: 0.2 }, "left"],
  ] as const)(
    "rejects a selector-derived start whose centre %s is NaN",
    async (_axis, frame, direction) => {
      // NaN fails every < / > comparison, so the range arms alone would let a
      // buggy adapter frame dispatch a NaN touch-down — only the
      // Number.isFinite arms catch it. A NaN ORIGIN is the reachable shape: a
      // NaN width or height already fails isVisible and never resolves.
      currentTree = () => screen([n({ label: "Card", frame })]);
      await writeFlow("nan-centre", {
        executionPrerequisite: "",
        steps: [{ kind: "swipe", from: { selector: { text: "Card", loose: true } }, direction }],
      });

      const result = await run("nan-centre");

      expect(result.ok).toBe(false);
      expect(result.steps[0]).toMatchObject({
        status: "fail",
        reason: expect.stringMatching(/swipe\.from resolved outside.*between 0 and 1/i),
      });
      expect(result.calls).toEqual([]);
    }
  );

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

  it("dispatches a floor-magnitude by delta whose unclamped travel rounds one ulp short", async () => {
    // 0.01 + 0.001 stays inside [0, 1] (clamp is the identity), yet the
    // effective travel computes to 0.0009999999999999992 — one ulp under
    // SWIPE_MIN_TRAVEL — so a bare magnitude gate would fail this
    // documented-legal boundary delta blaming clamping that never happened.
    await writeFlow("boundary-by", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", from: { x: 0.01, y: 0.5 }, by: { x: 0.001 } }],
    });

    const result = await run("boundary-by");

    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      {
        tool: "gesture-swipe",
        args: { udid: DEVICE, fromX: 0.01, fromY: 0.5, toX: 0.011, toY: 0.5 },
      },
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

  it("fails by travel on the y axis when saturation leaves no room", async () => {
    await writeFlow("no-room-y", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", from: { x: 0.5, y: 1 }, by: { y: 0.3 } }],
    });

    const result = await run("no-room-y");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "swipe",
      status: "fail",
      reason: expect.stringMatching(
        /swipe\.by\.y requests positive travel from y=1.*\[0, 1\].*no travel.*choose a start point/i
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

  it("resolves the anchor AFTER the endpoint's auto-wait, so a moved anchor stays fresh", async () => {
    // The endpoint appears only on later polls, and the anchor moves while
    // that auto-wait runs. The finger must go down on the anchor's current
    // centre (0.7, 0.3) — resolving it before the endpoint wait would dispatch
    // from the stale pre-wait centre (0.2, 0.3) onto empty background.
    let fetches = 0;
    currentTree = () => {
      fetches += 1;
      return fetches <= 2
        ? screen([n({ label: "Card", frame: { x: 0.1, y: 0.25, width: 0.2, height: 0.1 } })])
        : screen([
            n({ label: "Card", frame: { x: 0.6, y: 0.25, width: 0.2, height: 0.1 } }),
            n({ label: "Archive", frame: { x: 0.0, y: 0.9, width: 0.2, height: 0.1 } }),
          ]);
    };
    await writeFlow("moved-anchor", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "swipe",
          from: { selector: { text: "Card", loose: true } },
          to: { selector: { text: "Archive", loose: true } },
        },
      ],
    });

    const result = await run("moved-anchor");

    expect(result.ok).toBe(true);
    expect(result.calls[0]).toMatchObject({
      tool: "gesture-swipe",
      args: {
        fromX: expect.closeTo(0.7, 10),
        fromY: expect.closeTo(0.3, 10),
        toX: expect.closeTo(0.1, 10),
        toY: expect.closeTo(0.95, 10),
      },
    });
  });

  it("fails a to point that lands on the default centre start", async () => {
    await writeFlow("to-centre", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", to: { x: 0.5, y: 0.5 } }],
    });

    const result = await run("to-centre");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "swipe",
      status: "fail",
      reason: expect.stringMatching(
        /swipe\.to resolved onto the start point \(0\.5, 0\.5\).*zero travel.*away from the start/i
      ),
    });
    expect(result.calls).toEqual([]);
  });

  it("fails when from and to resolve to the same element centre", async () => {
    currentTree = () =>
      screen([n({ label: "Card", frame: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 } })]);
    await writeFlow("to-same-element", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "swipe",
          from: { selector: { text: "Card", loose: true } },
          to: { selector: { text: "Card", loose: true } },
        },
      ],
    });

    const result = await run("to-same-element");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "swipe",
      status: "fail",
      reason: expect.stringMatching(
        /swipe\.to resolved onto the start point \(0\.4, 0\.4\).*zero travel.*away from the start/i
      ),
    });
    expect(result.calls).toEqual([]);
  });

  it("fails a to selector that resolves a sub-pixel distance from the start", async () => {
    // Centre y computes to 0.49999999999999994 — one ulp below the default
    // centre start, so a bit-equality check would dispatch a stationary press.
    currentTree = () =>
      screen([
        n({
          label: "Card",
          frame: { x: 0.125, y: 0.41999999999999993, width: 0.75, height: 0.16 },
        }),
      ]);
    await writeFlow("to-sub-pixel", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", to: { selector: { text: "Card", loose: true } } }],
    });

    const result = await run("to-sub-pixel");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "swipe",
      status: "fail",
      reason: expect.stringMatching(
        /swipe\.to resolved onto the start point.*zero travel.*away from the start/i
      ),
    });
    expect(result.calls).toEqual([]);
  });

  it("rejects swipe on vega with the touch-directive message shape", async () => {
    await writeFlow("swipe-vega", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", direction: "left" }],
    });

    const result = await run("swipe-vega", "amazon-4a27df03c9777152");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "swipe", status: "fail" });
    expect(result.steps[0].reason).toMatch(
      /swipe is a touch directive and Vega is remote-driven — move focus with `tool: tv-remote`/
    );
    expect(result.calls).toEqual([]);
  });

  it("maps to a mouse drag on chromium with settle forwarded (web fling reads pointer release velocity)", async () => {
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
          settle: true,
        },
      },
    ]);
  });
});
