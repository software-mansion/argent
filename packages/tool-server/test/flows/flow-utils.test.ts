import { describe, it, expect, beforeEach } from "vitest";
import {
  serializeStep,
  parseFlow,
  setActiveFlow,
  getActiveFlow,
  clearActiveFlow,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

// ── serializeStep ────────────────────────────────────────────────────

describe("serializeStep", () => {
  it("serializes an echo step", () => {
    expect(serializeStep({ kind: "echo", message: "Hello" })).toBe(
      "- echo: Hello",
    );
  });

  it("serializes an echo with special characters", () => {
    expect(serializeStep({ kind: "echo", message: "Step: tap x=0.5" })).toBe(
      "- echo: \"Step: tap x=0.5\"",
    );
  });

  it("serializes a tool step with args", () => {
    const step: FlowStep = {
      kind: "tool",
      name: "tap",
      args: { udid: "ABC", x: 0.5, y: 0.3 },
    };
    const result = serializeStep(step);
    expect(result).toContain("- tool: tap");
    expect(result).toContain("  args:");
    expect(result).toContain("    udid: ABC");
    expect(result).toContain("    x: 0.5");
    expect(result).toContain("    y: 0.3");
  });

  it("serializes a tool step with empty args (omits args key)", () => {
    const step: FlowStep = { kind: "tool", name: "screenshot", args: {} };
    expect(serializeStep(step)).toBe("- tool: screenshot");
  });
});

// ── parseFlow ────────────────────────────────────────────────────────

describe("parseFlow", () => {
  it("parses echo entries", () => {
    expect(parseFlow("- echo: Hello\n")).toEqual([
      { kind: "echo", message: "Hello" },
    ]);
  });

  it("parses tool entries with args", () => {
    const content = "- tool: tap\n  args:\n    x: 0.5\n    y: 0.3\n";
    expect(parseFlow(content)).toEqual([
      { kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } },
    ]);
  });

  it("parses tool entries with no args", () => {
    expect(parseFlow("- tool: screenshot\n")).toEqual([
      { kind: "tool", name: "screenshot", args: {} },
    ]);
  });

  it("parses a multi-step flow", () => {
    const content = [
      "- echo: Step 1",
      "- tool: tap",
      "  args:",
      "    x: 0.5",
      "- echo: Step 2",
      "- tool: screenshot",
      "  args:",
      "    udid: ABC",
    ].join("\n");

    expect(parseFlow(content)).toEqual([
      { kind: "echo", message: "Step 1" },
      { kind: "tool", name: "tap", args: { x: 0.5 } },
      { kind: "echo", message: "Step 2" },
      { kind: "tool", name: "screenshot", args: { udid: "ABC" } },
    ]);
  });

  it("returns empty array for empty content", () => {
    expect(parseFlow("")).toEqual([]);
    expect(parseFlow("\n\n")).toEqual([]);
  });

  it("throws on unrecognised entries", () => {
    expect(() => parseFlow("- bogus: line\n")).toThrow(
      "Unrecognised flow entry",
    );
  });

  it("roundtrips: serialize then parse", () => {
    const steps: FlowStep[] = [
      { kind: "echo", message: "Launch app" },
      { kind: "tool", name: "launch-app", args: { bundleId: "com.test" } },
      { kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } },
      { kind: "echo", message: "Done" },
    ];
    const serialized = steps.map(serializeStep).join("\n") + "\n";
    expect(parseFlow(serialized)).toEqual(steps);
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
