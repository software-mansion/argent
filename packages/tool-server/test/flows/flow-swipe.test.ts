import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
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

import { createRunFlowTool } from "../../src/tools/flows/flow-run";
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
        // 0.03 is the exact tap/swipe floor — must round-trip clean.
        { kind: "swipe" as const, by: { x: 0.03 } },
        // Diagonal whose per-axis components are each sub-floor (0.025) but whose
        // magnitude (0.0354) clears it — serialize and parse must both accept it.
        { kind: "swipe" as const, by: { x: 0.025, y: 0.025 } },
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
    ["a tap-scale delta", 0.02],
    ["a sub-threshold delta", 0.0005],
    ["float dust", 1e-17],
  ])("rejects programmatic by travel with %s as a tap, not a swipe", (_description, x) => {
    // Single-axis sub-floor: the guard is on the combined magnitude now, so the
    // message names `swipe.by` (the vector), not a per-axis `swipe.by.x`.
    expect(() =>
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "swipe", by: { x } }] })
    ).toThrow(/cannot serialize flow swipe\.by: travels only .*below the minimum swipe travel/i);
  });

  it("rejects a programmatic diagonal by whose vector magnitude is sub-floor", () => {
    // Each axis 0.02 is below the 0.03 floor AND the magnitude 0.0283 is too, so
    // serialize rejects it — matching parse, keeping the round-trip exact.
    expect(() =>
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "swipe", by: { x: 0.02, y: 0.02 } }],
      })
    ).toThrow(/cannot serialize flow swipe\.by: travels only .*below the minimum swipe travel/i);
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
    ["a tap-scale delta", "0.02"],
    ["a sub-threshold delta", "0.0005"],
    ["float dust", "0.00000000000000001"],
  ])("rejects a single-axis by of %s as a tap, not a swipe", (_description, value) => {
    // Single-axis sub-floor: the vector magnitude equals |value|, so the
    // combined-magnitude gate rejects it and the message names `swipe.by`.
    expect(() => parseFlow(`steps:\n  - swipe: { by: { x: ${value} } }\n`)).toThrow(
      /swipe\.by travels only .*below the minimum swipe travel.*a tap, not a swipe/i
    );
  });

  it("accepts a diagonal by whose per-axis components are each sub-floor but whose magnitude clears the floor", () => {
    // x=0.025 and y=0.025 are each below the 0.03 floor, yet the vector length is
    // 0.0354 ≥ 0.03 — a real swipe. The OLD per-axis guard rejected this (each
    // |axis| < floor); the magnitude gate accepts it, keeping the boundary
    // monotonic in distance. This is the parse-side anti-regression proof.
    const steps = parseFlow("steps:\n  - swipe: { by: { x: 0.025, y: 0.025 } }\n").steps;
    expect(steps).toEqual([{ kind: "swipe", by: { x: 0.025, y: 0.025 } }]);
  });

  it("rejects a diagonal by whose vector magnitude is below the floor", () => {
    // x=0.02, y=0.01 → magnitude 0.0224 < 0.03: still a tap, rejected with the
    // combined-magnitude message.
    expect(() => parseFlow("steps:\n  - swipe: { by: { x: 0.02, y: 0.01 } }\n")).toThrow(
      /swipe\.by travels only .*below the minimum swipe travel.*a tap, not a swipe/i
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
    // Card centre is (0.6, 0.3): left travels the preset's -0.8 magnitude to
    // x = clamp01(0.6 - 0.8) = 0, and the anchor's y stays 0.3.
    expect(result.calls[0]).toMatchObject({
      tool: "gesture-swipe",
      args: { fromX: expect.closeTo(0.6, 10), fromY: 0.3, toX: 0, toY: 0.3 },
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
    // The anchor is used verbatim (0.6, 0.97) and left travels the preset's
    // -0.8 magnitude on to x = clamp01(0.6 - 0.8) = 0, y kept at 0.97.
    expect(result.calls[0]).toMatchObject({
      tool: "gesture-swipe",
      args: {
        fromX: expect.closeTo(0.6, 10),
        fromY: expect.closeTo(0.97, 10),
        toX: 0,
        toY: expect.closeTo(0.97, 10),
      },
    });
  });

  it.each([
    // Near the far edge — the old model rejected these as travelling the
    // "opposite direction" because it pinned the endpoint to the preset line.
    ["left near the edge", "left", { x: 0.05, y: 0.5 }, { toX: 0, toY: 0.5 }],
    ["right near the edge", "right", { x: 0.95, y: 0.5 }, { toX: 1, toY: 0.5 }],
    ["up near the edge", "up", { x: 0.5, y: 0.05 }, { toX: 0.5, toY: 0 }],
    ["down near the edge", "down", { x: 0.5, y: 0.95 }, { toX: 0.5, toY: 1 }],
    // On the old preset end line — the old model collapsed these to zero travel.
    ["left on the old preset line", "left", { x: 0.1, y: 0.5 }, { toX: 0, toY: 0.5 }],
    ["right on the old preset line", "right", { x: 0.9, y: 0.5 }, { toX: 1, toY: 0.5 }],
    ["up on the old preset line", "up", { x: 0.5, y: 0.1 }, { toX: 0.5, toY: 0 }],
    ["down on the old preset line", "down", { x: 0.5, y: 0.9 }, { toX: 0.5, toY: 1 }],
  ] as const)(
    "travels an anchored direction toward the target edge, clamped on-screen (%s)",
    async (_name, direction, from, expected) => {
      await writeFlow("edge-travel", {
        executionPrerequisite: "",
        steps: [{ kind: "swipe", from, direction }],
      });

      const result = await run("edge-travel");

      expect(result.ok).toBe(true);
      // The preset's signed magnitude carries the anchor on to the screen edge,
      // keeping the requested sign — clamping only shortens travel, never flips
      // it — so a drawer handle in the last band of the axis still swipes.
      expect(result.calls[0]).toMatchObject({
        tool: "gesture-swipe",
        args: { fromX: from.x, fromY: from.y, toX: expected.toX, toY: expected.toY },
      });
    }
  );

  it.each([
    // Anchor tap-close to the TARGET edge: the clamped travel is real but
    // sub-floor, a movement the recognizers read as a tap, not a swipe.
    ["right", "x=0.98", { x: 0.98, y: 0.5 }],
    ["left", "x=0.02", { x: 0.02, y: 0.5 }],
    ["down", "y=0.98", { x: 0.5, y: 0.98 }],
    ["up", "y=0.02", { x: 0.5, y: 0.02 }],
    // Dust from the edge: near-zero travel, still failed on distance-to-edge.
    ["right", "x=0.999", { x: 0.999, y: 0.5 }],
  ] as const)(
    "fails an anchored %s swipe from %s, too near the target edge",
    async (direction, startCoordinate, from) => {
      await writeFlow("no-room-direction", {
        executionPrerequisite: "",
        steps: [{ kind: "swipe", from, direction }],
      });

      const result = await run("no-room-direction");

      expect(result.ok).toBe(false);
      expect(result.steps[0]).toMatchObject({ kind: "swipe", status: "fail" });
      expect(result.steps[0].reason).toContain(`cannot swipe ${direction} from ${startCoordinate}`);
      expect(result.steps[0].reason).toContain("of travel to the screen edge");
      expect(result.steps[0].reason).toContain(
        "less than the minimum swipe travel of 0.03 — a tap, not a swipe"
      );
      expect(result.calls).toEqual([]);
    }
  );

  it("travels short anchored direction gestures on to the edge, above the tap/swipe floor", async () => {
    // ~0.14 to the edge: short, but above the 0.03 floor — the preset's signed
    // magnitude carries each anchor to the screen edge, clamped on-screen.
    await writeFlow("short-direction-travel", {
      executionPrerequisite: "",
      steps: [
        { kind: "swipe", from: { x: 0.14, y: 0.5 }, direction: "left" },
        { kind: "swipe", from: { x: 0.86, y: 0.5 }, direction: "right" },
        { kind: "swipe", from: { x: 0.5, y: 0.14 }, direction: "up" },
        { kind: "swipe", from: { x: 0.5, y: 0.86 }, direction: "down" },
      ],
    });

    const result = await run("short-direction-travel");

    expect(result.ok).toBe(true);
    expect(result.calls.map((c) => c.args)).toEqual([
      { udid: DEVICE, fromX: 0.14, fromY: 0.5, toX: 0, toY: 0.5 },
      { udid: DEVICE, fromX: 0.86, fromY: 0.5, toX: 1, toY: 0.5 },
      { udid: DEVICE, fromX: 0.5, fromY: 0.14, toX: 0.5, toY: 0 },
      { udid: DEVICE, fromX: 0.5, fromY: 0.86, toX: 0.5, toY: 1 },
    ]);
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

  it("delivers an in-bounds anchored by delta exactly", async () => {
    await writeFlow("deltas", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", from: { x: 0.5, y: 0.8 }, by: { y: -0.4 } }],
    });

    const result = await run("deltas");

    expect(result.ok).toBe(true);
    expect(result.calls.map((c) => c.args)).toEqual([
      { udid: DEVICE, fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.4 },
    ]);
  });

  it("fails an anchored by delta whose endpoint overflows the screen", async () => {
    // From a fixed anchor, x=0.97 + 0.2 = 1.17 (and y=0.03 - 0.2 = -0.17) both
    // run off-screen. Clamping would truncate the magnitude and rotate the
    // 45° diagonal, so the step must fail on the first overflowing axis (x)
    // rather than deliver a different gesture.
    await writeFlow("overflow-anchored", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", from: { x: 0.97, y: 0.03 }, by: { x: 0.2, y: -0.2 } }],
    });

    const result = await run("overflow-anchored");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "swipe",
      status: "fail",
      reason: expect.stringMatching(
        /swipe\.by\.x of 0\.2 from x=0\.97 lands at 1\.17.*off the normalized screen.*within \[0, 1\]/i
      ),
    });
    expect(result.calls).toEqual([]);
  });

  it("dispatches a floor-magnitude by delta whose unclamped travel rounds one ulp short", async () => {
    // 0.029 + 0.03 stays inside [0, 1] (clamp is the identity), yet the
    // effective travel computes to 0.029999999999999995 — one ulp under
    // SWIPE_MIN_TRAVEL — so a bare magnitude gate would fail this
    // documented-legal boundary delta blaming clamping that never happened.
    await writeFlow("boundary-by", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", from: { x: 0.029, y: 0.5 }, by: { x: 0.03 } }],
    });

    const result = await run("boundary-by");

    expect(result.ok).toBe(true);
    expect(result.calls).toEqual([
      {
        tool: "gesture-swipe",
        args: { udid: DEVICE, fromX: 0.029, fromY: 0.5, toX: 0.059, toY: 0.5 },
      },
    ]);
  });

  it("fails an anchored by delta that overflows the x axis", async () => {
    // From the fixed anchor x=1, any positive x delta lands off-screen, so the
    // step fails rather than clamp the endpoint back to the edge.
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
        /swipe\.by\.x of 0\.2 from x=1 lands at 1\.2.*off the normalized screen.*within \[0, 1\]/i
      ),
    });
    expect(result.calls).toEqual([]);
  });

  it("fails an anchored by delta whose large travel overflows the x axis", async () => {
    // 0.98 + 0.5 = 1.48 runs off the right edge from a fixed anchor; clamping
    // would truncate the authored half-screen drag, so the step must fail.
    await writeFlow("tap-scale-residue", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", from: { x: 0.98, y: 0.5 }, by: { x: 0.5 } }],
    });

    const result = await run("tap-scale-residue");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "swipe",
      status: "fail",
      reason: expect.stringMatching(
        /swipe\.by\.x of 0\.5 from x=0\.98 lands at 1\.48.*off the normalized screen.*within \[0, 1\]/i
      ),
    });
    expect(result.calls).toEqual([]);
  });

  it("fails an anchored by delta that overflows the y axis", async () => {
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
        /swipe\.by\.y of 0\.3 from y=1 lands at 1\.3.*off the normalized screen.*within \[0, 1\]/i
      ),
    });
    expect(result.calls).toEqual([]);
  });

  it("translates an unanchored by that overflows so it delivers the full x travel", async () => {
    // The reviewer's headline case: by {x:0.8} from the default centre used to
    // clamp the endpoint and silently dispatch 0.5 of travel. With no anchor to
    // honor, the whole segment slides into [0, 1] — from x=0.2 to x=1.0 — so the
    // authored 0.8 is delivered in full.
    await writeFlow("translate-x", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", by: { x: 0.8 } }],
    });

    const result = await run("translate-x");

    expect(result.ok).toBe(true);
    expect(result.calls[0]).toMatchObject({
      tool: "gesture-swipe",
      args: {
        udid: DEVICE,
        fromX: expect.closeTo(0.2, 10),
        fromY: 0.5,
        toX: 1,
        toY: 0.5,
      },
    });
    const x = result.calls[0].args as { fromX: number; toX: number };
    expect(x.toX - x.fromX).toBeCloseTo(0.8, 10);
  });

  it("translates an unanchored by that overflows so it delivers the full y travel", async () => {
    await writeFlow("translate-y", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", by: { y: 0.9 } }],
    });

    const result = await run("translate-y");

    expect(result.ok).toBe(true);
    expect(result.calls[0]).toMatchObject({
      tool: "gesture-swipe",
      args: {
        udid: DEVICE,
        fromX: 0.5,
        fromY: expect.closeTo(0.1, 10),
        toX: 0.5,
        toY: 1,
      },
    });
    const y = result.calls[0].args as { fromY: number; toY: number };
    expect(y.toY - y.fromY).toBeCloseTo(0.9, 10);
  });

  it("translates an unanchored negative by toward the leading edge", async () => {
    await writeFlow("translate-neg", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", by: { x: -0.8 } }],
    });

    const result = await run("translate-neg");

    expect(result.ok).toBe(true);
    expect(result.calls[0].args).toEqual({
      udid: DEVICE,
      fromX: 0.8,
      fromY: 0.5,
      toX: 0,
      toY: 0.5,
    });
  });

  it("translates a saturating unanchored diagonal without rotating the vector", async () => {
    // Under the old per-axis clamp, by {x:0.8, y:0.4} from the centre saturated
    // x to 1.0 while y stayed unclamped, delivering ~(0.5, 0.4) — a 45° intent
    // bent past 76°. Translating preserves the exact vector: dx=0.8, dy=0.4.
    await writeFlow("translate-diagonal", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", by: { x: 0.8, y: 0.4 } }],
    });

    const result = await run("translate-diagonal");

    expect(result.ok).toBe(true);
    expect(result.calls[0]).toMatchObject({
      tool: "gesture-swipe",
      args: {
        udid: DEVICE,
        fromX: expect.closeTo(0.2, 10),
        fromY: 0.5,
        toX: 1,
        toY: 0.9,
      },
    });
    const d = result.calls[0].args as { fromX: number; toX: number; fromY: number; toY: number };
    expect(d.toX - d.fromX).toBeCloseTo(0.8, 10);
    expect(d.toY - d.fromY).toBeCloseTo(0.4, 10);
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
        /swipe\.to \(0\.5, 0\.5\) resolved within the minimum swipe travel of the start point \(0\.5, 0\.5\).*farther from the start/i
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
        /swipe\.to \(0\.4, 0\.4\) resolved within the minimum swipe travel of the start point \(0\.4, 0\.4\).*farther from the start/i
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
        /swipe\.to .*resolved within the minimum swipe travel of the start point.*farther from the start/i
      ),
    });
    expect(result.calls).toEqual([]);
  });

  it("fails a to selector that resolves a tap-scale distance from the start", async () => {
    // Centre (0.52, 0.52) sits 0.02 from the default centre start on both
    // axes — real travel, but under recognizer slop, so the gesture would be
    // read as a tap on the element instead of a drag toward it.
    currentTree = () =>
      screen([n({ label: "Drop", frame: { x: 0.42, y: 0.42, width: 0.2, height: 0.2 } })]);
    await writeFlow("to-tap-scale", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", to: { selector: { text: "Drop", loose: true } } }],
    });

    const result = await run("to-tap-scale");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "swipe",
      status: "fail",
      reason: expect.stringMatching(
        /swipe\.to \(0\.52, 0\.52\) resolved within the minimum swipe travel of the start point \(0\.5, 0\.5\).*farther from the start/i
      ),
    });
    expect(result.calls).toEqual([]);
  });

  it("dispatches a diagonal to whose per-axis deltas are each sub-floor but whose magnitude clears it", async () => {
    // The reviewer's monotonicity case: from (0.5, 0.5) to (0.529, 0.529) — each
    // axis delta is 0.029 (< 0.03), yet the straight-line distance is 0.041 ≥
    // 0.03, a real swipe. The OLD per-axis AND-guard (both |delta| < floor)
    // rejected this longer diagonal while accepting a shorter straight swipe; the
    // magnitude gate dispatches it. Execution-side anti-regression proof.
    await writeFlow("to-diagonal", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", from: { x: 0.5, y: 0.5 }, to: { x: 0.529, y: 0.529 } }],
    });

    const result = await run("to-diagonal");

    expect(result.ok).toBe(true);
    expect(result.calls[0]).toMatchObject({
      tool: "gesture-swipe",
      args: { udid: DEVICE, fromX: 0.5, fromY: 0.5, toX: 0.529, toY: 0.529 },
    });
  });

  it("fails with the scroll-to hint when the from anchor never appears", async () => {
    currentTree = () => screen([]);
    await writeFlow("from-missing", {
      executionPrerequisite: "",
      steps: [
        { kind: "swipe", from: { selector: { text: "Card", loose: true } }, direction: "left" },
      ],
    });

    const result = await run("from-missing");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "swipe", status: "fail" });
    expect(result.steps[0].reason).toMatch(/add a scroll-to step/i);
    expect(result.calls).toEqual([]);
  }, 15000);

  it("fails with the scroll-to hint when the to endpoint never appears", async () => {
    currentTree = () => screen([]);
    await writeFlow("to-missing", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", to: { selector: { text: "Archive", loose: true } } }],
    });

    const result = await run("to-missing");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "swipe", status: "fail" });
    expect(result.steps[0].reason).toMatch(/add a scroll-to step/i);
    expect(result.calls).toEqual([]);
  }, 15000);

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

describe("swipe: abort", () => {
  it("reports a swipe cancelled during the endpoint's auto-wait as a skip, not an offscreen failure", async () => {
    // The shared harness never threads an AbortSignal, so this test runs the
    // flow tool directly from its own temp dir, mirroring flow-abort.test.ts:
    // the endpoint never appears and the third tree read trips the abort,
    // landing it deterministically inside the `to` auto-wait's polling.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-swipe-abort-"));
    try {
      const controller = new AbortController();
      let reads = 0;
      currentTree = () => {
        reads++;
        if (reads >= 3) controller.abort();
        return screen([n({ label: "Other", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]);
      };
      const flowsDir = path.join(dir, ".argent", "flows");
      await fs.mkdir(flowsDir, { recursive: true });
      await fs.writeFile(
        path.join(flowsDir, "cancelled-swipe.yaml"),
        serializeFlow({
          executionPrerequisite: "",
          steps: [{ kind: "swipe", to: { selector: { text: "Archive", loose: true } } }],
        }),
        "utf8"
      );
      const calls: string[] = [];
      const registry = {
        invokeTool: vi.fn(async (id: string) => {
          calls.push(id);
          if (id === "list-devices") return { devices: [] };
          return { ok: true };
        }),
        getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      } as unknown as Registry;

      const result = await createRunFlowTool(registry).execute(
        {},
        { name: "cancelled-swipe", project_root: dir, device: DEVICE },
        { signal: controller.signal } as never
      );

      if (!("steps" in result))
        throw new Error(`expected a run result, got notice: ${result.notice}`);
      // A skip with the uniform abort reason — NOT a fail with the misleading
      // "no visible element matched … add a scroll-to step" hint.
      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["swipe:skip"]);
      expect(result.steps[0].reason).toBe("run aborted");
      expect(result.ok).toBe(false);
      expect(calls).not.toContain("gesture-swipe");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
