import { describe, it, expect, beforeEach } from "vitest";
import * as path from "node:path";
import {
  serializeFlow,
  parseFlow,
  setActiveFlow,
  getActiveFlow,
  getActiveFlowOrNull,
  clearActiveFlow,
  setActiveProjectRoot,
  clearActiveProjectRoot,
  getFlowPath,
  type FlowFile,
} from "../../src/tools/flows/flow-utils";

// ── serializeFlow ────────────────────────────────────────────────────

describe("serializeFlow", () => {
  it("serializes an empty flow with prerequisite", () => {
    const flow: FlowFile = {
      executionPrerequisite: "App on home screen",
      steps: [],
    };
    const result = serializeFlow(flow);
    expect(result).toContain("executionPrerequisite: App on home screen");
    expect(result).toContain("steps: []");
  });

  it("serializes echo steps", () => {
    const flow: FlowFile = {
      executionPrerequisite: "Fresh reload",
      steps: [{ kind: "echo", message: "Hello" }],
    };
    const result = serializeFlow(flow);
    expect(result).toContain("- echo: Hello");
  });

  it("serializes tool steps with args", () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } }],
    };
    const result = serializeFlow(flow);
    expect(result).toContain("- tool: tap");
    expect(result).toContain("    x: 0.5");
    expect(result).toContain("    y: 0.3");
  });

  it("serializes tool steps with empty args (omits args key)", () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "screenshot", args: {} }],
    };
    const result = serializeFlow(flow);
    expect(result).toContain("- tool: screenshot");
    expect(result).not.toContain("args:");
  });
});

// ── parseFlow ────────────────────────────────────────────────────────

describe("parseFlow", () => {
  it("parses a flow with executionPrerequisite and echo steps", () => {
    const content = "executionPrerequisite: App on home screen\nsteps:\n  - echo: Hello\n";
    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe("App on home screen");
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello" }]);
  });

  it("parses tool entries with args", () => {
    const content =
      'executionPrerequisite: ""\nsteps:\n  - tool: tap\n    args:\n      x: 0.5\n      y: 0.3\n';
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([{ kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } }]);
  });

  it("parses tool entries with no args", () => {
    const content = 'executionPrerequisite: ""\nsteps:\n  - tool: screenshot\n';
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([{ kind: "tool", name: "screenshot", args: {} }]);
  });

  it("parses a multi-step flow", () => {
    const content = [
      "executionPrerequisite: Settings open",
      "steps:",
      "  - echo: Step 1",
      "  - tool: tap",
      "    args:",
      "      x: 0.5",
      "  - echo: Step 2",
      "  - tool: screenshot",
      "    args:",
      "      udid: ABC",
    ].join("\n");

    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe("Settings open");
    expect(flow.steps).toEqual([
      { kind: "echo", message: "Step 1" },
      { kind: "tool", name: "tap", args: { x: 0.5 } },
      { kind: "echo", message: "Step 2" },
      { kind: "tool", name: "screenshot", args: { udid: "ABC" } },
    ]);
  });

  it("returns empty steps for empty content", () => {
    const flow = parseFlow("");
    expect(flow.executionPrerequisite).toBe("");
    expect(flow.steps).toEqual([]);
  });

  it("defaults executionPrerequisite to empty string when missing", () => {
    const content = "steps:\n  - echo: Hello\n";
    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe("");
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello" }]);
  });

  it("throws on unrecognized entries", () => {
    const content = 'executionPrerequisite: ""\nsteps:\n  - bogus: line\n';
    expect(() => parseFlow(content)).toThrow("Unrecognized flow entry");
  });

  it("throws when content is not an object with steps", () => {
    expect(() => parseFlow("- echo: Hello\n")).toThrow("expected an object with a steps array");
  });

  it("throws a validation error (not a TypeError) on a primitive step entry", () => {
    const content = 'executionPrerequisite: ""\nsteps:\n  - tap\n';
    expect(() => parseFlow(content)).toThrow("Unrecognized flow entry");
  });

  it("throws a validation error on a null step entry", () => {
    const content = 'executionPrerequisite: ""\nsteps:\n  - ~\n';
    expect(() => parseFlow(content)).toThrow("Unrecognized flow entry");
  });

  it("sugars a bare-string selector into { text } for tap", () => {
    const flow = parseFlow("steps:\n  - tap: Settings\n");
    expect(flow.steps).toEqual([{ kind: "tap", selector: { text: "Settings" } }]);
  });

  it("sugars a bare-string selector for type.into", () => {
    const flow = parseFlow('steps:\n  - type: { into: email, text: "a@b.com" }\n');
    expect(flow.steps).toEqual([
      { kind: "type", into: { text: "email" }, text: "a@b.com" },
    ]);
  });

  it("parses condition-as-key await/assert sugar (visible/exists/hidden)", () => {
    const flow = parseFlow(
      [
        "steps:",
        "  - await: { visible: Account }",
        "  - assert: { exists: { identifier: row } }",
        "  - await: { hidden: spinner }",
      ].join("\n")
    );
    expect(flow.steps).toEqual([
      { kind: "await", condition: "visible", selector: { text: "Account" } },
      { kind: "assert", condition: "exists", selector: { identifier: "row" } },
      { kind: "await", condition: "hidden", selector: { text: "spinner" } },
    ]);
  });

  it("parses the text sugar { in, equals }", () => {
    const flow = parseFlow(
      'steps:\n  - assert: { text: { in: { identifier: counter }, equals: "Taps: 0" } }\n'
    );
    expect(flow.steps).toEqual([
      { kind: "assert", condition: "text", selector: { identifier: "counter" }, expectedText: "Taps: 0" },
    ]);
  });

  it("rejects the explicit { condition, selector, expectedText } form (sugar only)", () => {
    expect(() =>
      parseFlow(
        [
          "steps:",
          "  - assert:",
          "      condition: text",
          "      selector: { text: 'Taps:' }",
          "      expectedText: 'Taps: 0'",
        ].join("\n")
      )
    ).toThrow(/exactly one condition key/);
  });

  it("rejects an await/assert body with no condition key", () => {
    expect(() => parseFlow("steps:\n  - assert: { selector: foo }\n")).toThrow(
      /exactly one condition key/
    );
  });

  it("rejects text sugar without a non-empty equals", () => {
    expect(() => parseFlow("steps:\n  - assert: { text: { in: counter } }\n")).toThrow(
      /non-empty `equals`/
    );
  });

  it("serializes await/assert with the condition-as-key sugar (no condition: field)", () => {
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "assert", condition: "visible", selector: { text: "Welcome" } },
        { kind: "assert", condition: "text", selector: { identifier: "counter" }, expectedText: "Taps: 0" },
      ],
    });
    expect(yaml).toContain("visible: Welcome");
    expect(yaml).not.toContain("condition:");
    expect(yaml).toContain('equals: "Taps: 0"');
    expect(yaml).toContain("identifier: counter");
  });

  it("roundtrips the sugared step kinds through YAML", () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", selector: { text: "Login" } },
        { kind: "type", into: { text: "email" }, text: "a@b.com" },
        { kind: "await", condition: "hidden", selector: { identifier: "spinner" } },
        { kind: "assert", condition: "text", selector: { text: "Taps:" }, expectedText: "Taps: 0" },
      ],
    };
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("roundtrips: serialize then parse", () => {
    const flow: FlowFile = {
      executionPrerequisite: "App freshly loaded on home screen",
      steps: [
        { kind: "echo", message: "Launch app" },
        { kind: "tool", name: "launch-app", args: { bundleId: "com.test" } },
        { kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } },
        { kind: "echo", message: "Done" },
      ],
    };
    const serialized = serializeFlow(flow);
    expect(parseFlow(serialized)).toEqual(flow);
  });
});

// ── Active flow state ────────────────────────────────────────────────

describe("active flow state", () => {
  beforeEach(() => {
    clearActiveFlow();
  });

  it("throws when no active flow", () => {
    expect(() => getActiveFlow()).toThrow("No active flow");
  });

  it("returns the active flow after setActiveFlow", () => {
    setActiveFlow("my-flow");
    expect(getActiveFlow()).toBe("my-flow");
  });

  it("clears the active flow", () => {
    setActiveFlow("my-flow");
    clearActiveFlow();
    expect(() => getActiveFlow()).toThrow("No active flow");
  });

  it("overwrites previous active flow", () => {
    setActiveFlow("first");
    setActiveFlow("second");
    expect(getActiveFlow()).toBe("second");
  });

  it("getActiveFlowOrNull returns null when no active flow", () => {
    expect(getActiveFlowOrNull()).toBeNull();
  });

  it("getActiveFlowOrNull returns the active flow name", () => {
    setActiveFlow("my-flow");
    expect(getActiveFlowOrNull()).toBe("my-flow");
  });

  it("getActiveFlowOrNull returns null after clearing", () => {
    setActiveFlow("my-flow");
    clearActiveFlow();
    expect(getActiveFlowOrNull()).toBeNull();
  });
});

// ── getFlowPath name validation ──────────────────────────────────────

describe("getFlowPath name validation", () => {
  beforeEach(() => {
    clearActiveProjectRoot();
    setActiveProjectRoot("/tmp/argent-flow-name-test");
  });

  it("accepts plain alphanumeric names", () => {
    expect(getFlowPath("my-flow_1")).toBe(
      path.join("/tmp/argent-flow-name-test", ".argent", "flows", "my-flow_1.yaml")
    );
  });

  it("rejects path-traversal segments", () => {
    expect(() => getFlowPath("../../etc/passwd")).toThrow(/Invalid flow name/);
    expect(() => getFlowPath("../foo")).toThrow(/Invalid flow name/);
  });

  it("rejects path separators", () => {
    expect(() => getFlowPath("foo/bar")).toThrow(/Invalid flow name/);
    expect(() => getFlowPath("/abs/path")).toThrow(/Invalid flow name/);
  });

  it("rejects names with spaces or shell metacharacters", () => {
    expect(() => getFlowPath("foo bar")).toThrow(/Invalid flow name/);
    expect(() => getFlowPath("foo;bar")).toThrow(/Invalid flow name/);
    expect(() => getFlowPath("foo$(id)")).toThrow(/Invalid flow name/);
  });

  it("rejects empty names", () => {
    expect(() => getFlowPath("")).toThrow(/Invalid flow name/);
  });
});

// PR #194 follow-up C: project_root must be absolute AND free of ".."
// segments (path.join collapses ".." and would relocate the flows dir).
describe("setActiveProjectRoot validation", () => {
  it("rejects a relative project_root", () => {
    expect(() => setActiveProjectRoot("relative/path")).toThrow(/absolute path/);
  });

  it('rejects an absolute project_root containing ".." segments', () => {
    expect(() => setActiveProjectRoot("/a/../../../etc")).toThrow(/must not contain "\.\."/);
    expect(() => setActiveProjectRoot("/home/user/../../root")).toThrow(/must not contain "\.\."/);
  });

  it("accepts a clean absolute project_root", () => {
    expect(() => setActiveProjectRoot("/tmp/argent-pr194-c-test")).not.toThrow();
  });
});
