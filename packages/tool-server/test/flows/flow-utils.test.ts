import { describe, it, expect, beforeEach } from "vitest";
import {
  serializeFlow,
  parseFlow,
  setActiveFlow,
  getActiveFlow,
  clearActiveFlow,
  type FlowStep,
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
    const content =
      "executionPrerequisite: App on home screen\nsteps:\n  - echo: Hello\n";
    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe("App on home screen");
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello" }]);
  });

  it("parses tool entries with args", () => {
    const content =
      "executionPrerequisite: \"\"\nsteps:\n  - tool: tap\n    args:\n      x: 0.5\n      y: 0.3\n";
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([
      { kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } },
    ]);
  });

  it("parses tool entries with no args", () => {
    const content =
      "executionPrerequisite: \"\"\nsteps:\n  - tool: screenshot\n";
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([
      { kind: "tool", name: "screenshot", args: {} },
    ]);
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

  it("throws on unrecognised entries", () => {
    const content = "executionPrerequisite: \"\"\nsteps:\n  - bogus: line\n";
    expect(() => parseFlow(content)).toThrow("Unrecognised flow entry");
  });

  it("throws when content is not an object with steps", () => {
    expect(() => parseFlow("- echo: Hello\n")).toThrow(
      "expected an object with a steps array",
    );
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
});
