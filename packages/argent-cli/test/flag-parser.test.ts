import { describe, it, expect } from "vitest";
import { parseFlags, type JsonSchema } from "../src/flag-parser.js";

// A tool (like flow-add-step) whose schema declares its own `args` field — a
// JSON string holding the recorded step's tool arguments.
const flowAddStepSchema: JsonSchema = {
  type: "object",
  properties: {
    command: { type: "string" },
    args: { type: "string" },
    delayMs: { type: "integer" },
  },
  required: ["command"],
};

// A tool (like gesture-tap) with NO `args` field — here `--args` must stay the
// whole-payload escape hatch.
const gestureTapSchema: JsonSchema = {
  type: "object",
  properties: {
    udid: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
  },
  required: ["udid", "x", "y"],
};

describe("parseFlags — schema-aware --args", () => {
  it("treats --args as the tool's own string field (space-separated form)", () => {
    const result = parseFlags(
      ["--command", "gesture-tap", "--args", '{"udid":"X","x":0.5}'],
      flowAddStepSchema
    );
    expect(result.args.command).toBe("gesture-tap");
    // The raw JSON string is passed through untouched into the `args` field...
    expect(result.args.args).toBe('{"udid":"X","x":0.5}');
    // ...and NOT consumed as the whole-payload escape hatch.
    expect(result.rawArgs).toBeNull();
  });

  it("treats --args=<value> inline form as the tool's own field", () => {
    const result = parseFlags(
      ["--command", "gesture-tap", '--args={"udid":"X","x":0.5}'],
      flowAddStepSchema
    );
    expect(result.args.command).toBe("gesture-tap");
    expect(result.args.args).toBe('{"udid":"X","x":0.5}');
    expect(result.rawArgs).toBeNull();
  });

  it("still parses sibling fields alongside the --args field", () => {
    const result = parseFlags(
      ["--command", "screenshot", "--args", "{}", "--delayMs", "250"],
      flowAddStepSchema
    );
    expect(result.args.command).toBe("screenshot");
    expect(result.args.args).toBe("{}");
    expect(result.args.delayMs).toBe(250);
    expect(result.rawArgs).toBeNull();
  });
});

describe("parseFlags — whole-payload --args (no own `args` field)", () => {
  it("keeps --args as the whole-payload escape hatch", () => {
    const result = parseFlags(["--args", '{"udid":"X","x":0.5,"y":0.5}'], gestureTapSchema);
    expect(result.rawArgs).toBe('{"udid":"X","x":0.5,"y":0.5}');
    // `args` must not appear as a parsed field.
    expect("args" in result.args).toBe(false);
  });

  it("keeps the --args - stdin sentinel as whole-payload", () => {
    const result = parseFlags(["--args", "-"], gestureTapSchema);
    expect(result.rawArgs).toBe("-");
    expect("args" in result.args).toBe(false);
  });

  it("keeps whole-payload behavior when no schema is provided", () => {
    const result = parseFlags(["--args", '{"udid":"X"}'], undefined);
    expect(result.rawArgs).toBe('{"udid":"X"}');
    expect("args" in result.args).toBe(false);
  });
});
