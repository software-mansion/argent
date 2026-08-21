import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { BLOCK_DIRECTIVE_KEYS, type FlowStep } from "../../src/tools/flows/flow-utils";

/**
 * The six switches that must have an arm for every `FlowStep` kind, and the
 * `never` bindings that make forgetting one a build error rather than a silent
 * wrong answer at run time.
 *
 * Four of the six would fail to compile anyway, because their arms dereference
 * fields a new kind would not carry. The other two are the hazard these tests
 * exist for, because their `default:` arms read no field of `step`:
 * `execLeafStep`'s, where before the binding was added a leaf kind with no case
 * of its own compiled cleanly and reported `error: unsupported step kind` at
 * run time — a flow that looks executed and is not; and
 * `precedesLeadingLaunch`'s, which arrived after a kind slipped past the two
 * `echo`-only skips it replaced (a chromium flow led by `script:` hoisted no
 * boot and passed a launch it never performed, and the same lead-in walked it
 * past the `executionPrerequisite` refusal).
 */

const SRC = path.resolve(__dirname, "../../src/tools/flows");
const read = (file: string): string => readFileSync(path.join(SRC, file), "utf8");

/**
 * Every step kind, forced complete BY THE COMPILER: `Record` over the union
 * rejects a missing key and an extra one alike, so a kind added to `FlowStep`
 * without a row here fails `typecheck:tests`. That is what makes the coverage
 * assertions below mean something — they compare the switches against a list
 * that cannot go stale.
 */
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

/** The text of one function, from its signature to the next top-level `}`. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} is missing`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  expect(end, `${signature} has no top-level close`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The kinds a switch body has a `case "…":` label for. */
function handledKinds(body: string): Set<string> {
  return new Set([...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!));
}

/**
 * The kinds {@link execLeafStep} is NOT responsible for: `run:`, dispatched by
 * execRunStep, and every registered block directive, dispatched by
 * execBlockStep. Read from the block registry rather than restated, so a new
 * block kind does not have to be remembered here too.
 */
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
    // They are excluded from the parameter type instead. That is what lets the
    // default arm bind `never` honestly, and what keeps a NEW block directive
    // from being forced into a leaf switch that must never execute it.
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
 * The guard itself, in miniature, checked by `typecheck:tests` rather than at
 * run time: a switch that leaves a kind unhandled binds something other than
 * `never` in its default arm, so the assignment is an error. `@ts-expect-error`
 * inverts that — if the binding ever stopped erroring, the typecheck fails
 * here, which is the proof that the same binding in `execLeafStep` is load
 * bearing rather than decorative.
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
