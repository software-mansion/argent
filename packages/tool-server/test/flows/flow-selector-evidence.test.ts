import { describe, expect, it } from "vitest";
import {
  establishedTerms,
  selectorEstablishedInSteps,
} from "../../src/tools/flows/flow-selector-evidence";
import type { FlowStep } from "../../src/tools/flows/flow-utils";

/**
 * The evidence model that makes a later `hidden` check falsifiable: which steps
 * positively prove a selector present. A gap here reads as a false "proves
 * nothing" warning (runner) or refusal (recorder) on the correct authoring
 * order; an over-credit would let a permanently-green gate slip through.
 */
describe("establishedTerms", () => {
  it("credits a pinch / rotate that resolved a selector — a passing one proves it visible", () => {
    expect(establishedTerms({ kind: "pinch", selector: { text: "Photo" }, scale: 2 })).toEqual([
      "text:photo",
    ]);
    expect(
      establishedTerms({ kind: "rotate", selector: { identifier: "canvas" }, by: 90 })
    ).toEqual(["id:canvas"]);
  });

  it("credits a cropOn snapshot — it hard-fails when the crop element is absent", () => {
    expect(
      establishedTerms({ kind: "snapshot", name: "detail", cropOn: { text: "Card" } })
    ).toEqual(["text:card"]);
    // A full-screen snapshot names no element.
    expect(establishedTerms({ kind: "snapshot", name: "whole" })).toEqual([]);
  });

  it("never credits a coordinate pinch or a `hidden` check", () => {
    expect(establishedTerms({ kind: "pinch", scale: 2 })).toEqual([]);
    expect(
      establishedTerms({ kind: "assert", condition: "hidden", selector: { text: "Toast" } })
    ).toEqual([]);
  });

  it("credits a run-sequence's nested non-hidden await selectors flow-wide", () => {
    // A sequence that proves X present must license a LATER step's `hidden X`,
    // exactly as a top-level `visible X` would. Its nested `hidden` proves
    // absence (never credited) and its coordinate gestures carry no selector.
    const step: FlowStep = {
      kind: "tool",
      name: "run-sequence",
      args: {
        steps: [
          {
            tool: "await-ui-element",
            args: { condition: "visible", selector: { identifier: "Sheet" } },
          },
          {
            tool: "await-ui-element",
            args: { condition: "hidden", selector: { identifier: "Gone" } },
          },
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
        ],
      },
    };
    expect(establishedTerms(step)).toEqual(["id:sheet"]);
  });

  it("credits nothing for a run-sequence with no nesting or malformed args", () => {
    expect(establishedTerms({ kind: "tool", name: "run-sequence", args: {} })).toEqual([]);
    expect(
      establishedTerms({ kind: "tool", name: "run-sequence", args: { steps: "nope" } })
    ).toEqual([]);
  });
});

describe("selectorEstablishedInSteps", () => {
  it("counts an entered `when: { visible }` guard as proof of its selector", () => {
    const steps: FlowStep[] = [
      {
        kind: "when",
        condition: { kind: "ui", condition: "visible", selector: { text: "Sheet" } },
        steps: [{ kind: "echo", message: "guarded" }],
      },
    ];
    expect(selectorEstablishedInSteps(steps, { text: "Sheet" })).toBe(true);
  });

  it("does not count a `when: { hidden }` guard — that proves absence, not presence", () => {
    const steps: FlowStep[] = [
      {
        kind: "when",
        condition: { kind: "ui", condition: "hidden", selector: { text: "Spinner" } },
        steps: [{ kind: "echo", message: "guarded" }],
      },
    ];
    expect(selectorEstablishedInSteps(steps, { text: "Spinner" })).toBe(false);
  });
});
