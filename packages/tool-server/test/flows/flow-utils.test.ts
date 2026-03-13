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
      "echo:Hello",
    );
  });

  it("serializes an echo with special characters", () => {
    expect(serializeStep({ kind: "echo", message: "Step: tap x=0.5" })).toBe(
      "echo:Step: tap x=0.5",
    );
  });

  it("serializes a tool step with args", () => {
    const step: FlowStep = {
      kind: "tool",
      name: "tap",
      args: { udid: "ABC", x: 0.5, y: 0.3 },
    };
    expect(serializeStep(step)).toBe(
      'tool:tap {"udid":"ABC","x":0.5,"y":0.3}',
    );
  });

  it("serializes a tool step with empty args", () => {
    const step: FlowStep = { kind: "tool", name: "screenshot", args: {} };
    expect(serializeStep(step)).toBe("tool:screenshot {}");
  });
});

// ── parseFlow ────────────────────────────────────────────────────────

describe("parseFlow", () => {
  it("parses echo lines", () => {
    expect(parseFlow("echo:Hello\n")).toEqual([
      { kind: "echo", message: "Hello" },
    ]);
  });

  it("parses tool lines with args", () => {
    const content = 'tool:tap {"x":0.5,"y":0.3}\n';
    expect(parseFlow(content)).toEqual([
      { kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } },
    ]);
  });

  it("parses tool lines with no args (no space after name)", () => {
    expect(parseFlow("tool:screenshot\n")).toEqual([
      { kind: "tool", name: "screenshot", args: {} },
    ]);
  });

  it("parses a multi-line flow", () => {
    const content = [
      "echo:Step 1",
      'tool:tap {"x":0.5}',
      "echo:Step 2",
      'tool:screenshot {"udid":"ABC"}',
    ].join("\n");

    expect(parseFlow(content)).toEqual([
      { kind: "echo", message: "Step 1" },
      { kind: "tool", name: "tap", args: { x: 0.5 } },
      { kind: "echo", message: "Step 2" },
      { kind: "tool", name: "screenshot", args: { udid: "ABC" } },
    ]);
  });

  it("skips blank lines", () => {
    const content = "echo:A\n\n\necho:B\n";
    expect(parseFlow(content)).toHaveLength(2);
  });

  it("trims whitespace from lines", () => {
    expect(parseFlow("  echo:Hello  \n")).toEqual([
      { kind: "echo", message: "Hello" },
    ]);
  });

  it("returns empty array for empty content", () => {
    expect(parseFlow("")).toEqual([]);
    expect(parseFlow("\n\n")).toEqual([]);
  });

  it("throws on unrecognised line prefix", () => {
    expect(() => parseFlow("bogus:line")).toThrow("Unrecognised flow line");
  });

  it("roundtrips: serialize then parse", () => {
    const steps: FlowStep[] = [
      { kind: "echo", message: "Launch app" },
      { kind: "tool", name: "launch-app", args: { bundleId: "com.test" } },
      { kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } },
      { kind: "echo", message: "Done" },
    ];
    const serialized = steps.map(serializeStep).join("\n");
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
