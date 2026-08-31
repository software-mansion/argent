import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  BLOCK_DIRECTIVE_KEYS,
  precedesLeadingLaunch,
  validateFlow,
  type FlowFile,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

const SRC = path.resolve(__dirname, "../../src/tools/flows");
const read = (file: string): string => readFileSync(path.join(SRC, file), "utf8");

const ALL_STEP_KINDS: Record<FlowStep["kind"], true> = {
  "echo": true,
  "launch": true,
  "run": true,
  "when": true,
  "tool": true,
  "tap": true,
  "long-press": true,
  "type": true,
  "await": true,
  "assert": true,
  "idle": true,
  "wait": true,
  "scroll-to": true,
  "pinch": true,
  "rotate": true,
  "snapshot": true,
  "script": true,
};

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} is missing`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  expect(end, `${signature} has no top-level close`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function handledKinds(body: string): Set<string> {
  return new Set([...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!));
}

const DISPATCHED_BEFORE_THE_LEAF_SWITCH = new Set<string>(["run", ...BLOCK_DIRECTIVE_KEYS]);

describe("execLeafStep's exhaustiveness guard", () => {
  it("binds `never` in its default arm", () => {
    const body = functionBody(read("flow-run.ts"), "async function execLeafStep(");
    expect(body).toMatch(/default: \{[\s\S]*?const \w+: never = step;/);
  });

  it("has an arm for every leaf step kind", () => {
    const handled = handledKinds(functionBody(read("flow-run.ts"), "async function execLeafStep("));
    for (const kind of Object.keys(ALL_STEP_KINDS)) {
      if (DISPATCHED_BEFORE_THE_LEAF_SWITCH.has(kind)) continue;
      expect(handled, `execLeafStep has no case for "${kind}"`).toContain(kind);
    }
  });

  it("leaves the two dispatched-elsewhere kinds out, rather than as dead arms", () => {
    const body = functionBody(read("flow-run.ts"), "async function execLeafStep(");
    for (const kind of DISPATCHED_BEFORE_THE_LEAF_SWITCH) {
      expect(handledKinds(body), kind).not.toContain(kind);
    }
  });
});

describe("the other five switches over a step kind", () => {
  it.each([
    ["flow-device.ts", "export function stepRequiresDevice("],
    ["flow-run.ts", "function stepTarget("],
    ["flow-utils.ts", "function toYamlStep("],
    ["flow-utils.ts", "export function precedesLeadingLaunch("],
    ["flow-finish-recording.ts", "export function summarizeStep("],
  ])("%s %s binds `never` in its default arm", (file, signature) => {
    expect(functionBody(read(file), signature)).toMatch(
      /default: ?\{[\s\S]*?const \w+: never = (?:step|kind);/
    );
  });

  it.each([
    ["flow-device.ts", "export function stepRequiresDevice("],
    ["flow-run.ts", "function stepTarget("],
    ["flow-utils.ts", "function toYamlStep("],
    ["flow-utils.ts", "export function precedesLeadingLaunch("],
    ["flow-finish-recording.ts", "export function summarizeStep("],
  ])("%s %s has an arm for every step kind", (file, signature) => {
    const handled = handledKinds(functionBody(read(file), signature));
    for (const kind of Object.keys(ALL_STEP_KINDS)) {
      expect(handled, `${signature} has no case for "${kind}"`).toContain(kind);
    }
  });
});

/**
 * The switch tests above prove only that a `case` label for each kind exists
 * SOMEWHERE in the body — never which `return` it reaches. For
 * `precedesLeadingLaunch` that is the whole content of the function: moving
 * `case "snapshot":` into the `true` arm left this file and the rest of
 * `test/flows` green, while changing behaviour — a leading `snapshot` would
 * start hiding a later `launch`, so a fragment that opens with one would
 * classify end-to-end and be refused for declaring `executionPrerequisite`.
 *
 * Its nearest twin, `stepRequiresDevice`, is pinned by the truth table in
 * `flow-deviceless.test.ts`. This is the same table for the same reason.
 */
describe("precedesLeadingLaunch's arms", () => {
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
    "type": false,
    "await": false,
    "assert": false,
    "idle": false,
    "wait": false,
    "scroll-to": false,
    "pinch": false,
    "rotate": false,
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
    "type": { kind: "type", into: { text: "f" }, text: "hi" },
    "await": { kind: "await", condition: "visible", selector: { text: "f" } },
    "assert": { kind: "assert", condition: "visible", selector: { text: "f" } },
    "idle": { kind: "idle" },
    "wait": { kind: "wait", ms: 1 },
    "scroll-to": { kind: "scroll-to", target: { text: "f" }, direction: "down" },
    "pinch": { kind: "pinch", scale: 2 },
    "rotate": { kind: "rotate", by: 90 },
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

/**
 * The guard in miniature, checked by `typecheck:tests` rather than at run time:
 * a switch that leaves a kind unhandled binds something other than `never` in
 * its default arm, so `@ts-expect-error` fails the typecheck if that binding
 * ever stops erroring — the proof that the same binding in `execLeafStep` is
 * load bearing.
 */
function _theNeverBindingReallyFires(step: Extract<FlowStep, { kind: "echo" | "wait" }>): void {
  switch (step.kind) {
    case "echo":
      return;
    default: {
      // @ts-expect-error `wait` is left unhandled above, so `step` is not `never`
      const unexecuted: never = step;
      void unexecuted;
    }
  }
}
void _theNeverBindingReallyFires;
