import { describe, it, expect } from "vitest";
import { parseFlags, FlagParseException, type JsonSchema } from "../src/flag-parser.js";

const numSchema: JsonSchema = {
  type: "object",
  properties: { x: { type: "number" }, n: { type: "integer" } },
};
const arrSchema: JsonSchema = {
  type: "object",
  properties: { tags: { type: "array", items: { type: "string" } } },
};
const numArrSchema: JsonSchema = {
  type: "object",
  properties: { nums: { type: "array", items: { type: "number" } } },
};

describe("flag-parser number coercion rejects empty/whitespace", () => {
  it("rejects --x= (empty)", () => {
    expect(() => parseFlags(["--x="], numSchema)).toThrow(FlagParseException);
  });
  it('rejects --x "   " (whitespace)', () => {
    expect(() => parseFlags(["--x", "   "], numSchema)).toThrow(FlagParseException);
  });
  it("rejects --n= (empty integer)", () => {
    expect(() => parseFlags(["--n="], numSchema)).toThrow(FlagParseException);
  });
  it("still accepts a valid number", () => {
    expect(parseFlags(["--x", "12"], numSchema).args.x).toBe(12);
  });
  it("still accepts a number with surrounding whitespace", () => {
    // The empty/whitespace guard keys off raw.trim() === "", so a padded but
    // otherwise-valid number (" 12 ") must still be accepted — Number() ignores
    // the surrounding whitespace. Pins that the guard doesn't over-reject.
    expect(parseFlags(["--x", " 12 "], numSchema).args.x).toBe(12);
  });
  it("still rejects a non-numeric string", () => {
    expect(() => parseFlags(["--x", "abc"], numSchema)).toThrow(FlagParseException);
  });

  it("still ACCEPTS zero and negatives (guards against over-rejecting falsy numbers)", () => {
    // The whole fix exists because Number("") === 0 slipped through, so the
    // tempting-but-wrong guard is `if (!Number(raw))` / `Number(raw) === 0`,
    // which would ALSO reject the legitimate value 0. Pin that 0 and negatives
    // (and exponent form) still parse — the guard must key off emptiness, not
    // falsiness.
    expect(parseFlags(["--x=0"], numSchema).args.x).toBe(0);
    expect(parseFlags(["--x=-5"], numSchema).args.x).toBe(-5);
    expect(parseFlags(["--x=1e3"], numSchema).args.x).toBe(1000);
    expect(parseFlags(["--n=0"], numSchema).args.n).toBe(0);
    expect(parseFlags(["--n=-3"], numSchema).args.n).toBe(-3);
  });

  it("rejects a non-integer / whitespace-only integer, still accepts a valid one", () => {
    expect(() => parseFlags(["--n=1.5"], numSchema)).toThrow(FlagParseException);
    expect(() => parseFlags(["--n", "   "], numSchema)).toThrow(FlagParseException);
    expect(parseFlags(["--n", " 7 "], numSchema).args.n).toBe(7);
  });
});

describe("flag-parser array + -json interleave never throws a raw error", () => {
  it("throws FlagParseException (not TypeError) on interleave", () => {
    let err: unknown;
    try {
      parseFlags(["--tags", "a", "--tags-json", '"b"', "--tags", "c"], arrSchema);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FlagParseException);
    // Assert the message too — it names the field/flags and the guidance the
    // user acts on, so a wording or flag-interpolation regression is caught.
    expect((err as Error).message).toMatch(/--tags and --tags-json cannot be mixed/);
  });

  it("rejects the reverse order too, instead of silently discarding --tags-json", () => {
    // --tags-json first, then a plain --tags: the plain flag used to hit the
    // "first occurrence" branch and silently overwrite the JSON-parsed value
    // with no error at all.
    expect(() => parseFlags(["--tags-json", '["a","b"]', "--tags", "c"], arrSchema)).toThrow(
      /--tags and --tags-json cannot be mixed/
    );
  });

  it("rejects --tags-json arriving after a plain --tags, instead of silently overwriting it", () => {
    expect(() => parseFlags(["--tags", "a", "--tags-json", '["b","c"]'], arrSchema)).toThrow(
      /--tags and --tags-json cannot be mixed/
    );
  });

  it("reports the mixing error (not a coercion error) when the plain numeric value is also invalid", () => {
    // For a numeric array, the mixing check runs BEFORE scalar coercion, so a
    // mixed --nums-json/--nums whose plain value ALSO fails to coerce surfaces
    // the actionable "cannot be mixed" error rather than "expected a number".
    expect(() => parseFlags(["--nums-json", "[1]", "--nums", "abc"], numArrSchema)).toThrow(
      /--nums and --nums-json cannot be mixed/
    );
    // A valid plain value in the same mix still reports the mixing error.
    expect(() => parseFlags(["--nums-json", "[1]", "--nums", "5"], numArrSchema)).toThrow(
      /--nums and --nums-json cannot be mixed/
    );
  });

  it("still allows repeated plain --tags with no -json involved", () => {
    expect(parseFlags(["--tags", "a", "--tags", "b"], arrSchema).args.tags).toEqual(["a", "b"]);
  });

  it("still allows a bare --tags-json with no plain --tags involved", () => {
    expect(parseFlags(["--tags-json", '["a","b"]'], arrSchema).args.tags).toEqual(["a", "b"]);
  });
});

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

  it("treats --args - as the literal field value, NOT the stdin sentinel", () => {
    // For a tool that owns `args`, `-` is just this field's value. The
    // whole-payload stdin sentinel must not fire, so `rawArgs` stays null and
    // nothing is read from stdin. This is the inverse of the no-`args` case
    // below; asserting it here guards against a refactor that moved the `-`
    // sentinel ahead of the `properties.args === undefined` gate and started
    // routing flow-add-step's `--args -` to stdin.
    const result = parseFlags(["--command", "gesture-tap", "--args", "-"], flowAddStepSchema);
    expect(result.args.command).toBe("gesture-tap");
    expect(result.args.args).toBe("-");
    expect(result.rawArgs).toBeNull();
  });

  it("treats --args=- inline form as the literal field value too", () => {
    const result = parseFlags(["--command", "gesture-tap", "--args=-"], flowAddStepSchema);
    expect(result.args.args).toBe("-");
    expect(result.rawArgs).toBeNull();
  });
});

// A hypothetical future tool that OWNS its top-level `args` field but as an
// object / array of objects (flow-add-step's is a string). The whole-payload
// `--args '<json>'` hatch is disabled for any tool that owns `args`, so the
// error text must NOT suggest that dead-end form — only `--<field>-json` works.
const objectArgsSchema: JsonSchema = {
  type: "object",
  properties: { args: { type: "object" } },
};
const arrayArgsSchema: JsonSchema = {
  type: "object",
  properties: { args: { type: "array", items: { type: "object" } } },
};
// A control tool that does NOT own `args`, with an object field. Here the
// whole-payload hatch exists, so the "or --args '<json>'" suggestion must stay.
const objectFieldSchema: JsonSchema = {
  type: "object",
  properties: { filter: { type: "object" } },
};

describe("parseFlags — error hints omit the whole-payload --args form when the tool owns `args`", () => {
  it("object `args`: suggests only --args-json, not the dead-end --args '<json>'", () => {
    let err: unknown;
    try {
      parseFlags(["--args", '{"a":1}'], objectArgsSchema);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FlagParseException);
    const msg = (err as Error).message;
    expect(msg).toBe("--args is an object; pass it as --args-json '<json>'");
    // The whole-payload form no longer routes to the hatch for this tool, so it
    // must not be advertised as a fallback (it would just re-enter this branch).
    expect(msg).not.toContain("or --args '<json>'");
  });

  it("array-of-objects `args`: suggests only --args-json, not the dead-end --args '<json>'", () => {
    let err: unknown;
    try {
      parseFlags(["--args", '[{"a":1}]'], arrayArgsSchema);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FlagParseException);
    const msg = (err as Error).message;
    expect(msg).toBe("--args is an array of objects; pass it as --args-json '<json>'");
    expect(msg).not.toContain("or --args '<json>'");
  });

  it("still suggests --args '<json>' for an object field on a tool WITHOUT its own `args`", () => {
    // Control: dropping the whole-payload suggestion is scoped to tools that own
    // `args`; for everyone else the hatch exists and stays advertised.
    let err: unknown;
    try {
      parseFlags(["--filter", '{"a":1}'], objectFieldSchema);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FlagParseException);
    expect((err as Error).message).toBe(
      "--filter is an object; pass it as --filter-json '<json>' or --args '<json>'"
    );
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
