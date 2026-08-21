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
    {
      // The pre-step sleep changes what replays, so the summary spells it; the
      // report target still names nothing, because a tool step addresses no element.
      step: { kind: "tool", name: "screenshot", args: { scale: 0.2 }, delayMs: 500 },
      summary: '1. tool: screenshot {"scale":0.2} (after 500ms)',
      target: undefined,
    },
    {
      // The ceiling itself: setTimeout accepts 2³¹−1, so this is a real
      // ~24.8-day sleep the runner performs and the label must keep.
      step: { kind: "tool", name: "screenshot", args: {}, delayMs: 2 ** 31 - 1 },
      summary: "1. tool: screenshot {} (after 2147483647ms)",
      target: undefined,
    },
    {
      // One past it sleeps a clamped tick instead, so the summary describes no
      // delay. Neither bound is hand-edit-only: `flow-add-step`'s `delayMs` is
      // `z.number().int().min(0)` with no ceiling, so the recorder's own
      // per-step line renders these too.
      step: { kind: "tool", name: "screenshot", args: {}, delayMs: 2 ** 31 },
      summary: "1. tool: screenshot {}",
      target: undefined,
    },
    {
      // Below setTimeout's 1ms floor, likewise no delay to describe.
      step: { kind: "tool", name: "screenshot", args: {}, delayMs: 0.5 },
      summary: "1. tool: screenshot {}",
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
    {
      // Not `times: 2` — that is the count a constant `×2` would also produce.
      step: { kind: "tap", selector: { text: "Submit" }, times: 3 },
      summary: '1. tap: {"text":"Submit"} ×3',
      target: '"Submit"',
    },
    {
      // A selector carrying several fields at once — the order the report
      // target concatenates them in is what tells two similar steps apart.
      step: {
        kind: "tap",
        selector: { text: "Save", identifier: "save-btn", role: "button" },
      },
      summary: '1. tap: {"text":"Save","role":"button","id":"save-btn"}',
      target: '"Save" id=save-btn role=button',
    },
    {
      // parseTapTimes normalizes `times: 1` to absent, so no file spells a
      // single tap with a count and `×1` must never render.
      step: { kind: "tap", x: 0.5, y: 0.25, times: 1 },
      summary: "1. tap: (0.5, 0.25)",
      target: "(0.5, 0.25)",
    },
  ],
  "long-press": [
    {
      // A loose selector spells as the bare string the YAML carries.
      step: { kind: "long-press", selector: { text: "row-1", loose: true }, duration: 900 },
      summary: '1. long-press: "row-1" for 900ms',
      target: '"row-1"',
    },
    {
      step: { kind: "long-press", x: 0.4, y: 0.5 },
      summary: "1. long-press: (0.4, 0.5)",
      target: "(0.4, 0.5)",
    },
  ],
  "type": [
    {
      step: { kind: "type", into: { identifier: "email" }, text: "a@b.c" },
      summary: '1. type: {"id":"email"} ← "a@b.c"',
      target: "into id=email",
    },
    {
      // The text is JSON-quoted, so embedded quotes and control characters
      // stay unambiguous in the one-line summary.
      step: { kind: "type", into: { identifier: "bio" }, text: 'say "hi"\none' },
      summary: '1. type: {"id":"bio"} ← "say \\"hi\\"\\none"',
      target: "into id=bio",
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
  // Summarized under `await`, the key the flow file spells it with, not under
  // its kind; its tuning fields are not part of either rendering.
  "idle": [
    { step: { kind: "idle" }, summary: "1. await: screen idle", target: undefined },
    {
      step: { kind: "idle", stableFor: 500, timeout: 8000 },
      summary: "1. await: screen idle",
      target: undefined,
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
      // it is the line read against the YAML, where the direction is either
      // explicit or the bare-string sugar's implicit `down`.
      step: { kind: "scroll-to", target: { text: "Footer" }, direction: "down" },
      summary: '1. scroll-to: {"text":"Footer"} (down)',
      target: '"Footer"',
    },
    {
      step: {
        kind: "scroll-to",
        target: { text: "Footer" },
        direction: "down",
        within: { identifier: "list" },
      },
      summary: '1. scroll-to: {"text":"Footer"} (down) within {"id":"list"}',
      target: '"Footer" in scroll container (id=list)',
    },
    {
      // The scroll container and a scope ON the target selector are different
      // relationships, and a step may carry both: the report has to keep them
      // apart, or these two steps read alike while scrolling different things.
      step: {
        kind: "scroll-to",
        target: { text: "Footer", within: { identifier: "list" } },
        direction: "down",
      },
      summary: '1. scroll-to: {"text":"Footer","within":{"id":"list"}} (down)',
      target: '"Footer" within (id=list)',
    },
    {
      step: {
        kind: "scroll-to",
        target: { text: "Delete", within: { identifier: "cards" } },
        direction: "up",
        within: { identifier: "settings" },
      },
      summary:
        '1. scroll-to: {"text":"Delete","within":{"id":"cards"}} (up) within {"id":"settings"}',
      target: '"Delete" within (id=cards) (up) in scroll container (id=settings)',
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
      summary: '1. snapshot: home cropOn {"id":"card"}',
      target: '"home" cropOn id=card',
    },
    {
      step: { kind: "snapshot", name: "home", maxMismatch: 2.5 },
      summary: "1. snapshot: home maxMismatch 2.5",
      target: '"home"',
    },
    {
      // `maxMismatch: 0` — pixel-exact, the strictest setting a flow can ask
      // for and the one value a truthiness guard would drop from the line.
      step: { kind: "snapshot", name: "home", maxMismatch: 0 },
      summary: "1. snapshot: home maxMismatch 0",
      target: '"home"',
    },
    {
      // Both suffixes together: the order they concatenate in is otherwise
      // pinned by nothing, and this is the shape a real baseline step takes.
      step: { kind: "snapshot", name: "cart", cropOn: { identifier: "total" }, maxMismatch: 1.5 },
      summary: '1. snapshot: cart cropOn {"id":"total"} maxMismatch 1.5',
      target: '"cart" cropOn id=total',
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
