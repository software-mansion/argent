import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodObjectToJsonSchema } from "@argent/registry";
import {
  parseFlags,
  formatSchemaUsage,
  FlagParseException,
  type JsonSchema,
} from "../src/flag-parser.js";

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
// JSON string holding the recorded step's tool arguments. Mirrors the schema the
// registry advertises for the real tool (zodObjectToJsonSchema over
// packages/tool-server/src/tools/flows/flow-add-step.ts): recordings are keyed by
// `name` + `project_root`, so both are required alongside `command`.
//
// This fixture is hand-copied: `@argent/cli` does not depend on the tool-server,
// so it cannot derive the schema. The guard that catches drift lives where the
// schema does — `flow-tools.test.ts`'s "the flow-add-step schema the CLI tests
// hand-copy". If that fails, this fixture is what it is telling you to update.
const flowAddStepSchema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    project_root: { type: "string" },
    command: { type: "string" },
    args: { type: "string" },
    delayMs: { type: "integer" },
  },
  required: ["name", "project_root", "command"],
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
  it("routes the recording identity through the plain scalar path", () => {
    const result = parseFlags(
      [
        "--name",
        "checkout-e2e",
        "--project_root",
        "/Users/dev/My Projects/demo-app",
        "--command",
        "gesture-tap",
        "--args",
        '{"udid":"X"}',
      ],
      flowAddStepSchema
    );
    expect(result.args.name).toBe("checkout-e2e");
    // `project_root` is the only schema field carrying an underscore, so it pins
    // that flag names reach the payload verbatim — a parser that normalised them
    // to camel/kebab case would file the value under the wrong key and the server
    // would reject the step for a missing `project_root`. The value also holds a
    // space: argv arrives already split, so it must survive whole.
    expect(result.args.project_root).toBe("/Users/dev/My Projects/demo-app");
    expect(result.args.command).toBe("gesture-tap");
    expect(result.args.args).toBe('{"udid":"X"}');
    expect(result.rawArgs).toBeNull();
  });

  it("routes the recording identity through the inline --field=<value> form too", () => {
    const result = parseFlags(
      ["--name=checkout-e2e", "--project_root=/Users/dev/demo-app", "--command=screenshot"],
      flowAddStepSchema
    );
    expect(result.args.name).toBe("checkout-e2e");
    expect(result.args.project_root).toBe("/Users/dev/demo-app");
    expect(result.args.command).toBe("screenshot");
    expect(result.rawArgs).toBeNull();
  });

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

/**
 * Issue #586: `--flag false` on a boolean left the flag TRUE and dropped the
 * word. Reported after chasing a filter bug that did not exist — the tool had
 * simply been asked for the opposite of what was typed. The `=` form worked, and
 * `--help` gave no hint that it was required.
 *
 * The parser had declined to look ahead so it would not steal a following
 * positional. `argent run` is the sole caller and never reads `positional`, so
 * there was nothing to steal — and the module header already documented the
 * space form as legal.
 */
const boolSchema: JsonSchema = {
  type: "object",
  properties: {
    capture: { type: "boolean" },
    name: { type: "string" },
    flags: { type: "array", items: { type: "boolean" } },
  },
};

describe("boolean flags take a following true/false word", () => {
  it("reads --capture false as false", () => {
    const r = parseFlags(["--capture", "false"], boolSchema);
    expect(r.args.capture).toBe(false);
    // The word must be consumed, not left behind as a stray argument.
    expect(r.positional).toEqual([]);
  });

  it("reads --capture true as true, consuming the word", () => {
    const r = parseFlags(["--capture", "true"], boolSchema);
    expect(r.args.capture).toBe(true);
    expect(r.positional).toEqual([]);
  });

  it("accepts the words in any case, and padded", () => {
    expect(parseFlags(["--capture", "False"], boolSchema).args.capture).toBe(false);
    expect(parseFlags(["--capture", "TRUE"], boolSchema).args.capture).toBe(true);
    expect(parseFlags(["--capture", " false "], boolSchema).args.capture).toBe(false);
  });

  it("accepts the same words in the = form, which used to be case-sensitive", () => {
    // Otherwise `--capture True` and `--capture=True` would disagree about the
    // same word, one function apart.
    expect(parseFlags(["--capture=False"], boolSchema).args.capture).toBe(false);
    expect(parseFlags(["--capture=TRUE"], boolSchema).args.capture).toBe(true);
  });

  it("reproduces the reported invocation", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        baselinePath: { type: "string" },
        currentPath: { type: "string" },
        captureCurrent: { type: "boolean" },
      },
    };
    const r = parseFlags(
      ["--baselinePath", "a.png", "--currentPath", "b.png", "--captureCurrent", "false"],
      schema
    );
    expect(r.args.captureCurrent).toBe(false);
    expect(r.positional).toEqual([]);
  });
});

describe("what the lookahead deliberately does NOT take", () => {
  it("still treats a bare flag as true", () => {
    const r = parseFlags(["--capture"], boolSchema);
    expect(r.args.capture).toBe(true);
  });

  it("still treats a bare flag as true when it is the last token", () => {
    expect(parseFlags(["--name", "x", "--capture"], boolSchema).args.capture).toBe(true);
  });

  it("leaves a following flag alone", () => {
    const r = parseFlags(["--capture", "--name", "x"], boolSchema);
    expect(r.args.capture).toBe(true);
    expect(r.args.name).toBe("x");
  });

  it("leaves a non-boolean word alone rather than guessing", () => {
    // Guessing at an ambiguous token is what produced #586 in the first place.
    // `argent run` warns about the leftover instead.
    const r = parseFlags(["--capture", "notabool"], boolSchema);
    expect(r.args.capture).toBe(true);
    expect(r.positional).toEqual(["notabool"]);
  });

  it("takes 1 and 0 in the space form too", () => {
    // `--flag 0` previously set the flag TRUE and dropped the 0 — the same
    // silent inversion as `--flag false`, and the reason 1/0 is not left as an
    // ambiguous token: nothing else a bare 1/0 after a boolean switch can mean.
    const one = parseFlags(["--capture", "1"], boolSchema);
    expect(one.args.capture).toBe(true);
    expect(one.positional).toEqual([]);

    const zero = parseFlags(["--capture", "0"], boolSchema);
    expect(zero.args.capture).toBe(false);
    expect(zero.positional).toEqual([]);
  });

  it("reads 1 and 0 the same way in every form", () => {
    // One helper behind the lookahead, the inline form and array items, so the
    // same token cannot mean different things one call site apart.
    expect(parseFlags(["--capture=1"], boolSchema).args.capture).toBe(true);
    expect(parseFlags(["--capture=0"], boolSchema).args.capture).toBe(false);
    expect(parseFlags(["--flags", "1", "--flags", "0"], boolSchema).args.flags).toEqual([
      true,
      false,
    ]);
    // `--no-flag 0` is a double negative; it names the positive form rather
    // than silently picking one, exactly as `--no-flag false` does.
    expect(() => parseFlags(["--no-capture", "0"], boolSchema)).toThrow(/use --capture false/);
    expect(() => parseFlags(["--no-capture", "1"], boolSchema)).toThrow(/use --capture true/);
  });

  it("still lets -- force a literal true/false positional", () => {
    const r = parseFlags(["--capture", "--", "false"], boolSchema);
    expect(r.args.capture).toBe(true);
    expect(r.positional).toEqual(["false"]);
  });

  it("does not touch a string field's value", () => {
    expect(parseFlags(["--name", "false"], boolSchema).args.name).toBe("false");
  });

  it("does not extend the lookahead to flags with no schema", () => {
    // An unknown flag takes its value the ordinary way; treating it as a
    // boolean would guess at a shape the CLI cannot know.
    expect(parseFlags(["--unknown", "false"], boolSchema).args.unknown).toBe("false");
  });

  it("leaves boolean arrays and last-write-wins alone", () => {
    expect(parseFlags(["--flags", "false", "--flags", "true"], boolSchema).args.flags).toEqual([
      false,
      true,
    ]);
    expect(parseFlags(["--capture", "true", "--capture", "false"], boolSchema).args.capture).toBe(
      false
    );
  });

  it("rejects a value it cannot read", () => {
    expect(() => parseFlags(["--capture=maybe"], boolSchema)).toThrow(FlagParseException);
  });
});

describe("--no-flag", () => {
  it("still sets false", () => {
    expect(parseFlags(["--no-capture"], boolSchema).args.capture).toBe(false);
  });

  it("still rejects an attached value", () => {
    expect(() => parseFlags(["--no-capture=false"], boolSchema)).toThrow(FlagParseException);
  });

  it("names the positive form instead of resolving a contradiction", () => {
    // `--no-capture true` contradicts itself and `--no-capture false` is a
    // double negative; before the lookahead existed both silently meant false.
    expect(() => parseFlags(["--no-capture", "true"], boolSchema)).toThrow(
      /does not take a value; use --capture true/
    );
    expect(() => parseFlags(["--no-capture", "false"], boolSchema)).toThrow(/use --capture false/);
  });
});

describe("boolean value syntax is discoverable from --help", () => {
  it("adds a legend when the tool has a boolean field", () => {
    const usage = formatSchemaUsage(boolSchema);
    expect(usage).toMatch(/Booleans:/);
    expect(usage).toMatch(/--flag false/);
    expect(usage).toMatch(/--no-flag/);
  });

  it("adds nothing when the tool has no boolean field", () => {
    // Otherwise every tool carries a lesson that does not apply to it.
    expect(formatSchemaUsage(numSchema)).not.toMatch(/Booleans:/);
  });

  it("keeps the legend from starting with -- so the e2e harness can parse help", () => {
    // scripts/e2e-full/lib/discover-tools.sh treats any line in the Flags:
    // section matching /^[[:space:]]*--/ as a flag row and takes the first
    // --token as the flag name. A legend starting with a flag would inject a
    // phantom flag into every tool model it builds. This pins the shape so a
    // well-meaning reflow cannot quietly break that harness.
    for (const line of formatSchemaUsage(boolSchema).split("\n")) {
      if (line.includes("Booleans:")) expect(line.trimStart().startsWith("--")).toBe(false);
    }
  });
});

/**
 * A tool carrying a retired key: `z.never().optional().describe(...)` serializes
 * to `{description, not: {}}` with no `type`. Rendered as a flag row it would
 * read as `--settle <value>  any`, indistinguishable from the live optional
 * flags, and the e2e harness would pick it up as a real flag. Carrying no
 * `type`, it also matches none of the parser's branches, so every spelling of it
 * must be refused outright.
 *
 * The fixtures below run the REAL registry serializer over a REAL zod object
 * rather than hand-writing that shape; the shape itself is pinned by the first
 * test.
 */
function schemaFrom(shape: z.ZodRawShape): JsonSchema {
  return zodObjectToJsonSchema(z.object(shape)) as unknown as JsonSchema;
}

const RETIREMENT_NOTE =
  "Retired: renamed to `momentum` with the opposite sense. Pass `momentum: false` for what `settle: true` meant; `settle: false` was the default, so drop the key.";

const retiredSchema = schemaFrom({
  durationMs: z.number().optional().describe("Total gesture duration in milliseconds"),
  momentum: z.boolean().optional().describe("Whether the swipe releases with momentum"),
  // Declared exactly as gesture-drag declares it: `.never({error})` so the
  // server can name the replacement, `.optional()` so the key is
  // declared-and-refused rather than required.
  settle: z
    .never({ error: "`settle` was renamed to `momentum`, with the opposite sense" })
    .optional()
    .describe(RETIREMENT_NOTE),
});

describe("retired (never-typed) keys in usage", () => {
  it("serializes to the {description, not: {}} shape the retirement check keys on", () => {
    // Everything below recognises a retired key by `not: {}` with no `type`, so a
    // change in what the serializer emits for `z.never().optional()` must fail
    // HERE rather than regress usage to a `--settle <value>  any` row.
    expect(retiredSchema.properties?.settle).toEqual({ description: RETIREMENT_NOTE, not: {} });
    // The live siblings keep a plain `type` and no `not`, so the check above is
    // matching the retirement rather than everything the serializer emits.
    expect(retiredSchema.properties?.durationMs).toEqual({
      type: "number",
      description: "Total gesture duration in milliseconds",
    });
  });

  it("renders no flag row for the retired key", () => {
    for (const line of formatSchemaUsage(retiredSchema).split("\n")) {
      if (line.trimStart().startsWith("--")) expect(line).not.toContain("settle");
    }
  });

  it("still surfaces the field and its retirement, without doubling 'Retired:'", () => {
    const usage = formatSchemaUsage(retiredSchema);
    expect(usage).toMatch(
      /^ {2}Retired: settle - renamed to `momentum` with the opposite sense\. Pass `momentum: false` for what `settle: true` meant; `settle: false` was the default, so drop the key\.$/m
    );
    expect(usage).not.toMatch(/Retired:.*Retired:/);
  });

  it("keeps the live flags rendering as before", () => {
    const usage = formatSchemaUsage(retiredSchema);
    expect(usage).toMatch(/^ {2}--durationMs <value> {2}number {2}Total gesture duration/m);
    expect(usage).toMatch(/^ {2}--momentum\s+boolean {2}Whether the swipe/m);
    expect(usage).toMatch(/Booleans:/);
  });
});

describe("retired (never-typed) keys in parseFlags", () => {
  // Spelled out rather than derived from RETIREMENT_NOTE: re-running the source's
  // own "Retired: " strip here would assert nothing about it.
  const REFUSAL =
    "--settle is retired: renamed to `momentum` with the opposite sense. Pass `momentum: false` for what `settle: true` meant; `settle: false` was the default, so drop the key.";

  // A retired key has no `type`, so every spelling used to find a wrong branch:
  // bare `--settle` and `--no-settle` fell to the unknown-scalar tail, and
  // `--settle-json` filed a `settle` key for the server schema to strip. All of
  // them now resolve to one refusal, reachable from whatever the caller typed.
  const spellings = [
    ["--settle"],
    ["--settle", "true"],
    ["--settle=v"],
    ["--no-settle"],
    ["--no-settle", "v"],
    ["--settle-json", '{"a":1}'],
    ["--no-settle-json", "{}"],
  ];

  for (const argv of spellings) {
    it(`refuses \`${argv.join(" ")}\` and names the field, not the spelling`, () => {
      let err: unknown;
      try {
        parseFlags(argv, retiredSchema);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(FlagParseException);
      // Asserted whole: the message must name the retired FIELD (`--settle`, never
      // `--no-settle-json`) and carry the guidance minus its "Retired: " label.
      expect((err as Error).message).toBe(REFUSAL);
    });
  }

  it("refuses before consuming anything, so the next flag is not blamed", () => {
    // The pre-refusal failure mode for the bare form: `--settle` took the
    // following flag as its value, so the user was told about `--durationMs` and
    // never about the retirement.
    expect(() => parseFlags(["--settle", "--durationMs", "300"], retiredSchema)).toThrow(REFUSAL);
    expect(() => parseFlags(["--durationMs", "300", "--settle"], retiredSchema)).toThrow(REFUSAL);
  });

  it("degrades to a bare refusal when the retired key carries no guidance", () => {
    // `retirementGuidance` returns "" for a key declared without `.describe()`;
    // the message must then stop cleanly rather than trail a dangling colon.
    const undocumented = schemaFrom({ settle: z.never().optional() });
    expect(() => parseFlags(["--settle"], undocumented)).toThrow(/^--settle is retired$/);
  });

  it("still parses the live fields of the same schema", () => {
    // The refusal is keyed on the retired property, not on the schema owning
    // one: retiring a key must not cost its neighbours their flags.
    const r = parseFlags(["--durationMs", "300", "--momentum", "false"], retiredSchema);
    expect(r.args).toEqual({ durationMs: 300, momentum: false });
    expect(parseFlags(["--no-momentum"], retiredSchema).args).toEqual({ momentum: false });
    expect(parseFlags(["--momentum"], retiredSchema).args).toEqual({ momentum: true });
  });
});

// A live field literally named `no-x` beside a retired `x`: `--no-x` is both
// the live field's own name and the retired field's negation form. The live
// property is a declared name, so it wins and keeps its flag.
const liveNoPrefixSchema = schemaFrom({
  "no-x": z.boolean().optional().describe("A live field literally named no-x"),
  "x": z.never().optional().describe("Retired: use `no-x` instead."),
});

// A live `y-json` beside a retired `y`: `--y-json` is both the live field's own
// name and the retired field's JSON hatch. Again the declared name wins, so the
// token keeps routing through the hatch to field `y`.
const liveJsonSuffixSchema = schemaFrom({
  "y-json": z.string().optional(),
  "y": z.never().optional().describe("Retired: pass it as `y-json`."),
});

describe("retirement refusal resolves the flag spelling in a fixed order", () => {
  it("keeps a live `no-x` readable as itself, not as the retired `x`'s negation", () => {
    // Resolving the bare name first would read `--no-x` as `x`'s negation and
    // refuse it, taking a live flag away from a tool that never retired it.
    expect(parseFlags(["--no-x"], liveNoPrefixSchema).args).toEqual({ "no-x": true });
  });

  it("still refuses the retired `x` in that schema", () => {
    // Control for the case above: the live `no-x` must not shield `x` itself.
    expect(() => parseFlags(["--x", "1"], liveNoPrefixSchema)).toThrow(
      "--x is retired: use `no-x` instead."
    );
  });

  it("keeps a live `y-json` routing through the -json hatch", () => {
    // `--y-json` resolves to the declared `y-json` property (live), so nothing
    // is refused and the hatch files the parsed JSON under `y`, unchanged.
    expect(parseFlags(["--y-json", '{"a":1}'], liveJsonSuffixSchema).args).toEqual({ y: { a: 1 } });
  });

  it("still refuses the retired `y` in that schema", () => {
    expect(() => parseFlags(["--y", "1"], liveJsonSuffixSchema)).toThrow(
      "--y is retired: pass it as `y-json`."
    );
  });
});
