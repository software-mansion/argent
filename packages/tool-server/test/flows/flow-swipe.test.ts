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
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "native-devtools",
    })
  ),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, parseFlow, type FlowStep } from "../../src/tools/flows/flow-utils";
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
        // 150 is the exact tap/swipe floor on the time axis — must round-trip clean.
        { kind: "swipe" as const, direction: "up" as const, duration: 150 },
        // And 10000 is the exact ceiling on that same axis.
        { kind: "swipe" as const, direction: "up" as const, duration: 10_000 },
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

  it("rejects a programmatic zero axis riding beside a real one", () => {
    // `by` is `{ x?: number; y?: number }`, so { x: 0, y: 0.5 } is type-legal,
    // and its magnitude of 0.5 clears the travel floor — the per-axis zero
    // clause is the only guard that sees it. Without that clause serialize
    // emits `x: 0` and parse then refuses the file serialize just wrote: a
    // saved flow that can never be read back. Asserted on `.by.x` and the
    // non-zero wording so the magnitude message cannot stand in for it.
    expect(() =>
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "swipe", by: { x: 0, y: 0.5 } }],
      })
    ).toThrow(/cannot serialize flow swipe\.by\.x: must be a non-zero fraction/i);
  });

  it("rejects a programmatic by carrying a key that is not x or y", () => {
    // The junk key is type-illegal but reachable — FlowStep is also built
    // programmatically, and appendStep serializes whatever it was handed.
    // Without the junk-key clause `z` is dropped in silence and the run
    // reports success on a flow the author did not ask for.
    expect(() =>
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "swipe", by: { x: 0.5, z: 9 } } as never],
      })
    ).toThrow(/cannot serialize flow swipe\.by: accepts only x and y/i);
  });

  it.each([
    [
      "from",
      { kind: "swipe", from: { x: 0.5, y: 0.5, z: 9 }, by: { x: 0.5 } },
      /cannot serialize flow swipe\.from: a coordinate target takes only \{ x, y \}/i,
    ],
    [
      "to",
      { kind: "swipe", from: { x: 0.9, y: 0.5 }, to: { x: 0.1, y: 0.5, z: 9 } },
      /cannot serialize flow swipe\.to: a coordinate target takes only \{ x, y \}/i,
    ],
  ])(
    "rejects a programmatic swipe %s coordinate target carrying a key that is not x or y",
    (_description, step, message) => {
      // The same junk-key hole as swipe.by, one level down: parseTarget refuses
      // the shape loudly, so dropping `z` in silence writes a flow that can
      // never be read back, and the run reports success on it.
      expect(() => serializeFlow({ executionPrerequisite: "", steps: [step as never] })).toThrow(
        message
      );
    }
  );

  it.each([
    ["from", { kind: "swipe", from: { selector: { text: "Card", junk: 1 } }, direction: "left" }],
    ["to", { kind: "swipe", to: { selector: { text: "Archive", junk: 1 } } }],
  ])(
    "rejects a programmatic swipe %s selector carrying a key the parser refuses",
    (_description, step) => {
      // The selector branch of a gesture target, which the { x, y } key check
      // never sees.
      expect(() => serializeFlow({ executionPrerequisite: "", steps: [step as never] })).toThrow(
        /cannot serialize flow selector: unknown key `junk` - allowed keys: text, textMatches, identifier, role, any, loose, within, after, next/i
      );
    }
  );

  it("serializes a selector from/to untouched by the coordinate key check", () => {
    // A selector target is a different shape and must not be dragged through
    // the { x, y } key set — the check applies to the coordinate branch only.
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [
        {
          kind: "swipe",
          from: { selector: { identifier: "card" } },
          to: { selector: { identifier: "archive" } },
        },
      ],
    });
    expect(parseFlow(yaml).steps).toEqual([
      {
        kind: "swipe",
        from: { selector: { identifier: "card" } },
        to: { selector: { identifier: "archive" } },
      },
    ]);
  });

  it.each([
    ['the string "false"', "false"],
    ['the string "true"', "true"],
    ["zero", 0],
    ["one", 1],
    ["null", null],
  ])("rejects a programmatic swipe settle of %s", (_description, settle) => {
    // Both the bare-direction sugar and the body builder read `settle` for
    // truthiness only, so an unguarded non-boolean is rewritten rather than
    // refused: "false" would emit `settle: true` and 0 would vanish into the
    // bare spelling. parseSwipe takes nothing but a boolean.
    expect(() =>
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "swipe", direction: "left", settle } as never],
      })
    ).toThrow(/cannot serialize flow swipe\.settle: must be true or false/i);
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

  it.each([
    ["a sub-frame duration", 10],
    ["a two-move duration", 33],
    ["one millisecond under the floor", 149],
  ])(
    "rejects a programmatic swipe duration of %s as a flick, not a swipe",
    (_description, duration) => {
      // Positive but too short to interpolate the travel across enough frames:
      // serialize must reject exactly what parse rejects, or the round-trip breaks.
      expect(() =>
        serializeFlow({
          executionPrerequisite: "",
          steps: [{ kind: "swipe", direction: "left", duration }],
        })
      ).toThrow(
        /cannot serialize flow swipe\.duration: only \d+ms — below the minimum swipe duration of 150ms.*too few 16ms frames for the content to track the travel/i
      );
    }
  );

  it.each([
    ["one millisecond over the ceiling", 10_001],
    ["a duration authored in the wrong unit", 20_000],
    ["a value that clears the finite check", 1e21],
  ])(
    "rejects a programmatic swipe duration of %s as an unbounded held touch",
    (_description, duration) => {
      // Finite and positive, but the dispatch would hold the finger down for
      // exactly this long. Serialize must reject exactly what parse rejects.
      expect(() =>
        serializeFlow({
          executionPrerequisite: "",
          steps: [{ kind: "swipe", direction: "left", duration }],
        })
      ).toThrow(
        /cannot serialize flow swipe\.duration: \S+ms - above the maximum swipe duration of 10000ms.*hold a finger on the screen/i
      );
    }
  );

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

  it("bare-direction sugar: a programmatic settle: false still collapses to the bare string", () => {
    // `settle: false` is the default — the options body only ever emits
    // `settle: true` and parse normalizes the explicit false away, so a
    // programmatic step carrying it must not be pushed into the verbose form.
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "swipe", direction: "left", settle: false }],
    });
    expect(yaml).toContain("- swipe: left");
    expect(parseFlow(yaml).steps).toEqual([{ kind: "swipe", direction: "left" }]);
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

  it.each([
    ["a sub-frame flick", "10"],
    ["a fractional millisecond", "0.5"],
    ["a two-move duration", "33"],
    ["one millisecond under the floor", "149"],
  ])("rejects a duration of %s as a flick, not a swipe", (_description, value) => {
    // Under the floor the dispatch leaves the content too few frames to track
    // the travel, so it overshoots what the step asked for and still reports
    // pass — the time-axis twin of the swipe.by floor.
    expect(() => parseFlow(`steps:\n  - swipe: { direction: left, duration: ${value} }\n`)).toThrow(
      /swipe\.duration is only \S+ms — below the minimum swipe duration of 150ms.*too few 16ms frames for the content to track the travel/i
    );
  });

  it("accepts the exact minimum swipe duration", () => {
    const steps = parseFlow("steps:\n  - swipe: { direction: left, duration: 150 }\n").steps;
    expect(steps).toEqual([{ kind: "swipe", direction: "left", duration: 150 }]);
  });

  it.each([
    ["one millisecond over the ceiling", "10001"],
    ["a duration authored in the wrong unit", "20000"],
    ["a literal that clears parsePositiveMs's finite check", "1e21"],
  ])("rejects a duration of %s as an unbounded held touch", (_description, value) => {
    // The floor is about delivery fidelity; this is about cost. The dispatch
    // sleeps 16ms per frame with the finger down, so `duration` is wall clock
    // the run and the device both spend, and 1e21 never returns at all - the
    // loop outlives the CLI and keeps feeding the device.
    expect(() => parseFlow(`steps:\n  - swipe: { direction: left, duration: ${value} }\n`)).toThrow(
      /swipe\.duration is \S+ms - above the maximum swipe duration of 10000ms.*holds a finger on the screen/i
    );
  });

  it("accepts the exact maximum swipe duration", () => {
    const steps = parseFlow("steps:\n  - swipe: { direction: left, duration: 10000 }\n").steps;
    expect(steps).toEqual([{ kind: "swipe", direction: "left", duration: 10000 }]);
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

  it("resolves the anchor from the tree the endpoint appeared in, so a moved anchor stays fresh", async () => {
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

  it("resolves the endpoint from the tree the late anchor appeared in, so it cannot go stale", async () => {
    // The mirror: here the ANCHOR renders late and the ENDPOINT moves during
    // that wait. Resolving `to` first would lift the finger on the endpoint's
    // pre-jump centre (0.2, 0.3) instead of (0.7, 0.3) — half a screen of error
    // on a step that still reports pass.
    let fetches = 0;
    currentTree = () => {
      fetches += 1;
      return fetches <= 2
        ? screen([n({ label: "Mover", frame: { x: 0.1, y: 0.25, width: 0.2, height: 0.1 } })])
        : screen([
            n({ label: "Mover", frame: { x: 0.6, y: 0.25, width: 0.2, height: 0.1 } }),
            n({ label: "Late", frame: { x: 0.0, y: 0.9, width: 0.2, height: 0.1 } }),
          ]);
    };
    await writeFlow("late-anchor", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "swipe",
          from: { selector: { text: "Late", loose: true } },
          to: { selector: { text: "Mover", loose: true } },
        },
      ],
    });

    const result = await run("late-anchor");

    expect(result.ok).toBe(true);
    expect(result.calls[0]).toMatchObject({
      tool: "gesture-swipe",
      args: {
        fromX: expect.closeTo(0.1, 10),
        fromY: expect.closeTo(0.95, 10),
        toX: expect.closeTo(0.7, 10),
        toY: expect.closeTo(0.3, 10),
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

  it.each([
    // Same schema-conformant shape the start guard pins, on the lift instead of
    // the touch-down: describeFrameSchema bounds x/y/width/height to [0, 1]
    // independently, so x=0.85 + width 0.4 parses fine yet centres at x=1.05.
    // `to` is the only travel spelling that can carry a resolved endpoint
    // off-screen, and every one of these clears the travel floor from the
    // default (0.5, 0.5) start — without the bounds check the step would
    // dispatch a swipe whose finger lifts outside the screen.
    ["off the right edge (x > 1)", { x: 0.85, y: 0.4, width: 0.4, height: 0.2 }],
    ["off the bottom edge (y > 1)", { x: 0.4, y: 0.85, width: 0.2, height: 0.4 }],
    // A negative origin cannot pass the frame schema, but the guard sits behind
    // adapters and mocked trees that bypass it — pin the < 0 arms too.
    ["off the left edge (x < 0)", { x: -0.5, y: 0.4, width: 0.2, height: 0.2 }],
    ["off the top edge (y < 0)", { x: 0.4, y: -0.5, width: 0.2, height: 0.2 }],
  ] as const)(
    "rejects a selector-derived to whose centre resolves %s",
    async (_description, frame) => {
      currentTree = () => screen([n({ label: "Card", frame })]);
      await writeFlow("to-offscreen-centre", {
        executionPrerequisite: "",
        steps: [{ kind: "swipe", to: { selector: { text: "Card", loose: true } } }],
      });

      const result = await run("to-offscreen-centre");

      expect(result.ok).toBe(false);
      expect(result.steps[0]).toMatchObject({
        kind: "swipe",
        status: "fail",
        reason: expect.stringMatching(/swipe\.to resolved outside.*between 0 and 1/i),
      });
      expect(result.calls).toEqual([]);
    }
  );

  it.each([
    ["x", { x: Number.NaN, y: 0.4, width: 0.4, height: 0.2 }],
    ["y", { x: 0.4, y: Number.NaN, width: 0.4, height: 0.2 }],
  ] as const)("rejects a selector-derived to whose centre %s is NaN", async (_axis, frame) => {
    // NaN fails every < / > comparison — and makes the travel hypot NaN, so the
    // minimum-travel gate below waves it through as well. Only the
    // Number.isFinite arms stop a buggy adapter frame from dispatching a NaN
    // lift. A NaN ORIGIN is the reachable shape: a NaN width or height already
    // fails isVisible and never resolves.
    currentTree = () => screen([n({ label: "Card", frame })]);
    await writeFlow("to-nan-centre", {
      executionPrerequisite: "",
      steps: [{ kind: "swipe", to: { selector: { text: "Card", loose: true } } }],
    });

    const result = await run("to-nan-centre");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "swipe",
      status: "fail",
      reason: expect.stringMatching(/swipe\.to resolved outside.*between 0 and 1/i),
    });
    expect(result.calls).toEqual([]);
  });

  it("reports an off-screen to that also sits inside the travel floor as off-screen", async () => {
    // Pins the ORDER of the two `to` guards, not either guard alone: the bounds
    // check must run BEFORE the travel gate. Both frames parse — each field is
    // inside [0, 1] and describeFrameSchema never constrains y + height — yet
    // the anchor centres at (0.5, 0.99) and the endpoint at (0.5, 1.01), which
    // is at once off the screen and only 0.02 away, under the 0.03 floor. Run
    // the gates the other way round and the step blames the target's placement
    // — aim it farther from the start — for what is the adapter clipping the
    // endpoint out of the viewport, sending the author to fix the wrong end.
    currentTree = () =>
      screen([
        n({ label: "Anchor", frame: { x: 0.4, y: 0.97, width: 0.2, height: 0.04 } }),
        n({ label: "Drop", frame: { x: 0.4, y: 0.99, width: 0.2, height: 0.04 } }),
      ]);
    await writeFlow("to-offscreen-and-sub-floor", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "swipe",
          from: { selector: { text: "Anchor", loose: true } },
          to: { selector: { text: "Drop", loose: true } },
        },
      ],
    });

    const result = await run("to-offscreen-and-sub-floor");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "swipe",
      status: "fail",
      reason: expect.stringMatching(
        /swipe\.to resolved outside the normalized screen: \(0\.5, 1\.01\).*between 0 and 1/i
      ),
    });
    expect(result.steps[0].reason).not.toMatch(/minimum swipe travel of the start point/i);
    expect(result.calls).toEqual([]);
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
    // The reason names the end that is actually missing, not the other one.
    expect(result.steps[0].reason).toContain('text="Card"');
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
    expect(result.steps[0].reason).toContain('text="Archive"');
    expect(result.calls).toEqual([]);
  }, 15000);

  it("blames the endpoint when the anchor resolves and only the endpoint is missing", async () => {
    // One shared wait for both ends must not blur which end missed: the anchor
    // is on screen the whole time, so the reason may only name the endpoint.
    currentTree = () =>
      screen([n({ label: "Anchor", frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } })]);
    await writeFlow("endpoint-missing", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "swipe",
          from: { selector: { text: "Anchor", loose: true } },
          to: { selector: { text: "Drop", loose: true } },
        },
      ],
    });

    const result = await run("endpoint-missing");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "swipe", status: "fail" });
    expect(result.steps[0].reason).toContain('text="Drop"');
    expect(result.steps[0].reason).not.toContain('text="Anchor"');
    expect(result.calls).toEqual([]);
  }, 15000);

  it("blames the anchor when NEITHER end ever appears", async () => {
    // Deliberate tie-break, pinned so it can't drift: with both ends missing the
    // reason names `from`, the element the finger needs first and the first field
    // the step wrote.
    currentTree = () => screen([]);
    await writeFlow("both-missing", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "swipe",
          from: { selector: { text: "Anchor", loose: true } },
          to: { selector: { text: "Drop", loose: true } },
        },
      ],
    });

    const result = await run("both-missing");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "swipe", status: "fail" });
    expect(result.steps[0].reason).toContain('text="Anchor"');
    expect(result.steps[0].reason).not.toContain('text="Drop"');
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

// The shared harness records tool calls but not tree reads, and never threads an
// AbortSignal, so the two blocks below run the flow tool directly (mirroring
// flow-abort.test.ts) with ONE ordered log interleaving the gesture dispatch and
// every tree read — the ordering is the contract, not merely that a read
// happened.
async function runLoggedSwipe(
  step: FlowStep,
  hooks: {
    tree?: () => DescribeNode;
    onInvoke?: (id: string) => void;
    signal?: AbortSignal;
  } = {}
): Promise<{ result: FlowRunResult; events: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-swipe-logged-"));
  try {
    const events: string[] = [];
    currentTree = () => {
      events.push("tree");
      return hooks.tree ? hooks.tree() : screen([]);
    };
    const flowsDir = path.join(dir, ".argent", "flows");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.writeFile(
      path.join(flowsDir, "logged.yaml"),
      serializeFlow({ executionPrerequisite: "", steps: [step] }),
      "utf8"
    );
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "list-devices") return { devices: [] };
        events.push(id);
        hooks.onInvoke?.(id);
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    const result = await createRunFlowTool(registry).execute(
      {},
      { name: "logged", project_root: dir, device: DEVICE },
      { signal: hooks.signal } as never
    );
    if (!("steps" in result))
      throw new Error(`expected a run result, got notice: ${result.notice}`);
    return { result, events };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("swipe: abort", () => {
  // The selectors never appear and the third tree read trips the abort, landing
  // it deterministically inside the swipe's target resolution.
  async function runCancelledSwipe(step: FlowStep) {
    const controller = new AbortController();
    let reads = 0;
    return runLoggedSwipe(step, {
      signal: controller.signal,
      tree: () => {
        reads++;
        if (reads >= 3) controller.abort();
        return screen([n({ label: "Other", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]);
      },
    });
  }

  it.each<[string, FlowStep]>([
    ["the endpoint alone", { kind: "swipe", to: { selector: { text: "Archive", loose: true } } }],
    [
      "both ends",
      {
        kind: "swipe",
        from: { selector: { text: "Card", loose: true } },
        to: { selector: { text: "Archive", loose: true } },
      },
    ],
  ])(
    "reports a swipe cancelled while resolving %s as a skip, not an offscreen failure",
    async (_description, step) => {
      const { result, events } = await runCancelledSwipe(step);

      // A skip with the uniform abort reason — NOT a fail with the misleading
      // "no visible element matched … add a scroll-to step" hint.
      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["swipe:skip"]);
      expect(result.steps[0].reason).toBe("run aborted");
      expect(result.ok).toBe(false);
      expect(events).not.toContain("gesture-swipe");
    }
  );
});

describe("swipe: post-dispatch settle", () => {
  it("waits out the fling after a swipe between two raw points", async () => {
    const { result, events } = await runLoggedSwipe({
      kind: "swipe",
      from: { x: 0.5, y: 0.85 },
      to: { x: 0.5, y: 0.3 },
    });

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["swipe:pass"]);
    // Neither end is a selector, so every read here is a settle: the pair the
    // gesture waits for, then the pair AFTER it. Without the trailing pair a
    // following point-target step would touch down mid-deceleration and be
    // swallowed while still reporting pass.
    expect(events).toEqual(["tree", "tree", "gesture-swipe", "tree", "tree"]);
  });

  it("waits out the animation after a settle: true swipe too", async () => {
    // `settle` zeroes the finger's release velocity — it says nothing about the
    // app's own animations (a dismissed card, a paging carousel), so the wait is
    // not conditional on it.
    const { result, events } = await runLoggedSwipe({
      kind: "swipe",
      by: { y: -0.5 },
      settle: true,
    });

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["swipe:pass"]);
    expect(events).toEqual(["tree", "tree", "gesture-swipe", "tree", "tree"]);
  });

  it("passes when the tree source dies after the gesture was delivered", async () => {
    // A sustained outage makes settleTree throw. The device already performed
    // the swipe, so that must not fail the step retroactively.
    const { result, events } = await runLoggedSwipe(
      { kind: "swipe", direction: "up" },
      {
        tree: () => {
          throw new Error("native devtools disconnected");
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["swipe:pass"]);
    expect(result.steps[0].reason).toBeUndefined();
    expect(events.filter((e) => e !== "tree")).toEqual(["gesture-swipe"]);
    expect(events.indexOf("gesture-swipe")).toBeLessThan(events.length - 1);
  }, 15000);

  it("reports a swipe cancelled during its post-dispatch settle as the aborted skip", async () => {
    const controller = new AbortController();
    const { result, events } = await runLoggedSwipe(
      { kind: "swipe", direction: "left" },
      {
        signal: controller.signal,
        // Cancel the run as the gesture is dispatched: the settle that follows
        // must surface the uniform aborted skip, not a pass.
        onInvoke: (id) => {
          if (id === "gesture-swipe") controller.abort();
        },
      }
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["swipe:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(result.ok).toBe(false);
    // The settle that follows the gesture bails on the abort before reading
    // anything; the pair ahead of it is the pre-dispatch settle.
    expect(events).toEqual(["tree", "tree", "gesture-swipe"]);
  });
});

describe("swipe: pre-dispatch settle", () => {
  it("settles before a swipe with no selector end touches down", async () => {
    const { result, events } = await runLoggedSwipe({ kind: "swipe", direction: "left" });

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["swipe:pass"]);
    // Nothing waits out motion a `launch:` or a raw `tool: gesture-swipe` left
    // running, so without these two reads the touch-down lands mid-fling, is
    // consumed arresting it, and the step still passes.
    expect(events.slice(0, events.indexOf("gesture-swipe"))).toEqual(["tree", "tree"]);
  });

  it("does not settle again when an end resolved against a settled tree", async () => {
    const { result, events } = await runLoggedSwipe(
      { kind: "swipe", from: { x: 0.5, y: 0.85 }, to: { selector: { text: "Archive" } } },
      {
        tree: () =>
          screen([n({ label: "Archive", frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 } })]),
      }
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["swipe:pass"]);
    // The endpoint's own settle, and only it: a second window here would double
    // the step's cost for a screen already proved still.
    expect(events.slice(0, events.indexOf("gesture-swipe"))).toEqual(["tree", "tree"]);
  });

  it("carries the same unsettled-gesture warning a coordinate tap reports", async () => {
    currentTree = () => {
      throw new Error("native devtools disconnected");
    };
    await writeFlow("blind", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", x: 0.5, y: 0.5 },
        { kind: "swipe", direction: "left" },
      ],
    });

    const result = await run("blind");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:pass", "swipe:pass"]);
    expect(result.steps[1].warning).toContain("dispatched without settling the screen first");
    expect(result.steps[1].warning).toBe(result.steps[0].warning);
  }, 15000);
});
