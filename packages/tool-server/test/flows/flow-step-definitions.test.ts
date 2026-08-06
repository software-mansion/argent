import { describe, it, expect } from "vitest";
import {
  summarizeSteps,
  stepTarget,
  describeWhenCondition,
} from "../../src/tools/flows/flow-step-definitions";
import type { FlowStep } from "../../src/tools/flows/flow-utils";

interface Case {
  /** What the step reads as in a finished recording's summary, first line of its flow. */
  summary: string;
  /** What a run report names as the step's target, or undefined for a step that addresses nothing. */
  target: string | undefined;
  step: FlowStep;
}

/**
 * One case per step kind, keyed by kind so a kind added to {@link FlowStep}
 * without wording here fails to compile — the same gate the definitions
 * themselves carry, asserted against the strings both surfaces actually print.
 */
const CASES = {
  "tool": [
    {
      step: { kind: "tool", name: "keyboard", args: { text: "hi" } },
      summary: '1. tool: keyboard {"text":"hi"}',
      target: undefined,
    },
  ],
  "echo": [
    {
      step: { kind: "echo", message: "checkout starts here" },
      summary: "1. echo: checkout starts here",
      target: undefined,
    },
  ],
  "launch": [
    {
      step: { kind: "launch", app: "com.example.app" },
      summary: "1. launch: com.example.app",
      target: undefined,
    },
    {
      step: { kind: "launch", app: { ios: "com.example.ios", android: "com.example.android" } },
      summary: '1. launch: {"ios":"com.example.ios","android":"com.example.android"}',
      target: undefined,
    },
  ],
  "run": [
    {
      step: { kind: "run", flow: "../shared/login.yaml" },
      summary: "1. run: ../shared/login.yaml",
      target: "../shared/login.yaml",
    },
  ],
  "when": [
    {
      step: {
        kind: "when",
        condition: { kind: "platform", platform: "ios" },
        steps: [{ kind: "echo", message: "ios only" }],
      },
      summary: "1. when: platform ios (1 step)",
      target: "platform ios",
    },
    {
      step: {
        kind: "when",
        condition: {
          kind: "ui",
          condition: "text",
          selector: { identifier: "status" },
          expectedText: "Ready",
          textMatch: "equals",
        },
        steps: [],
      },
      summary: '1. when: text {"id":"status"} == "Ready" (0 steps)',
      target: 'id=status equals "Ready"',
    },
  ],
  "tap": [
    {
      step: { kind: "tap", selector: { text: "Submit" } },
      summary: '1. tap: {"text":"Submit"}',
      target: '"Submit"',
    },
    {
      step: { kind: "tap", x: 0.5, y: 0.25 },
      summary: "1. tap: (0.5, 0.25)",
      target: "(0.5, 0.25)",
    },
  ],
  "long-press": [
    {
      // A loose selector spells as the bare string the YAML carries.
      step: { kind: "long-press", selector: { text: "row-1", loose: true }, duration: 900 },
      summary: '1. long-press: "row-1"',
      target: '"row-1"',
    },
  ],
  "type": [
    {
      step: { kind: "type", into: { identifier: "email" }, text: "a@b.c" },
      summary: '1. type: {"id":"email"} ← "a@b.c"',
      target: "into id=email",
    },
  ],
  "await": [
    {
      step: {
        kind: "await",
        condition: "visible",
        selector: { text: "Home", within: { identifier: "nav" } },
      },
      summary: '1. await: visible {"text":"Home","within":{"id":"nav"}}',
      target: 'visible "Home" within (id=nav)',
    },
  ],
  "assert": [
    {
      step: {
        kind: "assert",
        condition: "text",
        selector: { identifier: "status" },
        expectedText: "Done",
        textMatch: "matches",
      },
      summary: '1. assert: text {"id":"status"} matches /Done/',
      target: "id=status matches /Done/",
    },
  ],
  "wait": [{ step: { kind: "wait", ms: 250 }, summary: "1. wait: 250ms", target: undefined }],
  "scroll-to": [
    {
      step: { kind: "scroll-to", target: { text: "Footer" }, direction: "up" },
      summary: '1. scroll-to: {"text":"Footer"} (up)',
      target: '"Footer" (up)',
    },
    {
      // The report omits the default direction; the summary spells it, because
      // it is the line read against the YAML, which always carries one.
      step: { kind: "scroll-to", target: { text: "Footer" }, direction: "down" },
      summary: '1. scroll-to: {"text":"Footer"} (down)',
      target: '"Footer"',
    },
  ],
  "pinch": [
    {
      step: { kind: "pinch", selector: { identifier: "map" }, scale: 2 },
      summary: '1. pinch: scale 2 on {"id":"map"}',
      target: "id=map (scale 2)",
    },
    { step: { kind: "pinch", scale: 0.5 }, summary: "1. pinch: scale 0.5", target: "scale 0.5" },
  ],
  "rotate": [
    {
      step: { kind: "rotate", selector: { identifier: "photo" }, by: 90 },
      summary: '1. rotate: by 90° on {"id":"photo"}',
      target: "id=photo (by 90°)",
    },
    { step: { kind: "rotate", by: -45 }, summary: "1. rotate: by -45°", target: "by -45°" },
  ],
  "snapshot": [
    { step: { kind: "snapshot", name: "home" }, summary: "1. snapshot: home", target: '"home"' },
    {
      step: { kind: "snapshot", name: "home", cropOn: { identifier: "card" } },
      summary: "1. snapshot: home",
      target: '"home" cropOn id=card',
    },
  ],
} satisfies Record<FlowStep["kind"], readonly Case[]>;

const CASE_LIST: [string, Case][] = Object.entries(CASES).flatMap(([kind, cases]) =>
  (cases as readonly Case[]).map((c, i): [string, Case] => [
    cases.length > 1 ? `${kind} #${i + 1}` : kind,
    c,
  ])
);

describe("flow step definitions", () => {
  describe.each(CASE_LIST)("%s", (_label, testCase) => {
    it("summarizes the recorded step", () => {
      expect(summarizeSteps({ executionPrerequisite: "", steps: [testCase.step] })).toEqual([
        testCase.summary,
      ]);
    });

    it("names what the step acts on", () => {
      expect(stepTarget(testCase.step)).toBe(testCase.target);
    });
  });

  it("numbers summary lines by position in the flow", () => {
    expect(
      summarizeSteps({
        executionPrerequisite: "",
        steps: [
          { kind: "echo", message: "first" },
          { kind: "wait", ms: 5 },
          { kind: "echo", message: "third" },
        ],
      })
    ).toEqual(["1. echo: first", "2. wait: 5ms", "3. echo: third"]);
  });

  it("marks a cyclic tool args body instead of failing the whole summary", () => {
    const args: Record<string, unknown> = { text: "hi" };
    args.self = args;
    expect(
      summarizeSteps({
        executionPrerequisite: "",
        steps: [
          { kind: "tool", name: "keyboard", args },
          { kind: "echo", message: "still summarized" },
        ],
      })
    ).toEqual(["1. tool: keyboard [cyclic args]", "2. echo: still summarized"]);
  });

  it("describes a when guard for report reasons with the failure-prose selector spelling", () => {
    expect(describeWhenCondition({ kind: "platform", platform: "android" })).toBe(
      "platform android"
    );
    expect(
      describeWhenCondition({
        kind: "ui",
        condition: "text",
        selector: { identifier: "status", within: { text: "Cart" } },
        expectedText: "Ready",
        textMatch: "equals",
      })
    ).toBe('id="status" within (text="Cart") equals "Ready"');
  });
});
