import { describe, it, expect } from "vitest";
import {
  precedesLeadingLaunch,
  validateFlow,
  type FlowFile,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

describe("precedesLeadingLaunch", () => {
  // Keyed on the union, so a new step kind fails to compile until it is
  // classified here as well as in the implementation.
  const CAN_PRECEDE_A_LEADING_LAUNCH: Record<FlowStep["kind"], boolean> = {
    "echo": true,
    "script": true,
    "launch": false,
    "run": false,
    "when": false,
    "tool": false,
    "tap": false,
    "long-press": false,
    "swipe": false,
    "type": false,
    "await": false,
    "assert": false,
    "idle": false,
    "wait": false,
    "scroll-to": false,
    "pinch": false,
    "rotate": false,
    "fold": false,
    "snapshot": false,
  };

  const SAMPLES: Record<FlowStep["kind"], FlowStep> = {
    "echo": { kind: "echo", message: "x" },
    "script": { kind: "script", path: "seed.mjs" },
    "launch": { kind: "launch", app: { ios: "com.example" } },
    "run": { kind: "run", flow: "other" },
    "when": { kind: "when", condition: { kind: "platform", platform: "ios" }, steps: [] },
    "tool": { kind: "tool", name: "screenshot", args: {} },
    "tap": { kind: "tap", x: 0, y: 0 },
    "long-press": { kind: "long-press", x: 0, y: 0 },
    "swipe": { kind: "swipe", direction: "left" },
    "type": { kind: "type", into: { text: "f" }, text: "hi" },
    "await": { kind: "await", condition: "visible", selector: { text: "f" } },
    "assert": { kind: "assert", condition: "visible", selector: { text: "f" } },
    "idle": { kind: "idle" },
    "wait": { kind: "wait", ms: 1 },
    "scroll-to": { kind: "scroll-to", target: { text: "f" }, direction: "down" },
    "pinch": { kind: "pinch", scale: 2 },
    "rotate": { kind: "rotate", by: 90 },
    "fold": { kind: "fold", posture: "open" },
    "snapshot": { kind: "snapshot", name: "s" },
  };

  it("classifies every step kind", () => {
    for (const kind of Object.keys(CAN_PRECEDE_A_LEADING_LAUNCH) as FlowStep["kind"][]) {
      expect(precedesLeadingLaunch(SAMPLES[kind]), `kind: ${kind}`).toBe(
        CAN_PRECEDE_A_LEADING_LAUNCH[kind]
      );
    }
  });

  it("is what decides whether a flow with a later launch may state a prerequisite", () => {
    // The consequence the table above stands for, so a wrong arm fails as
    // behaviour and not only as a mismatched constant.
    for (const kind of Object.keys(CAN_PRECEDE_A_LEADING_LAUNCH) as FlowStep["kind"][]) {
      if (kind === "launch") continue;
      const flow: FlowFile = {
        executionPrerequisite: "The Settings screen is open",
        steps: [SAMPLES[kind], { kind: "launch", app: { ios: "com.example" } }],
      };
      const refused = CAN_PRECEDE_A_LEADING_LAUNCH[kind];
      if (refused) {
        expect(() => validateFlow(flow), kind).toThrow(/must not declare executionPrerequisite/);
      } else {
        expect(() => validateFlow(flow), kind).not.toThrow();
      }
    }
  });
});
