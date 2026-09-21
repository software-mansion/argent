import { describe, expect, it } from "vitest";
import {
  MAX_ECHO_MESSAGE_CHARS,
  OUTPUT_REFERENCE_MARKER,
  describeJsonType,
  describeOutputReferenceSyntaxError,
  describeUnsafeIntegers,
  parseOutputReferences,
  renderOutputPath,
  renderedValue,
  resolveOutputField,
  sameJsonValue,
  type OutputDocument,
  type OutputReferenceSyntaxError,
} from "../../src/tools/flows/flow-output";

type FieldKind = Parameters<typeof resolveOutputField>[1];
type Resolved = Extract<ReturnType<typeof resolveOutputField>, { ok: true }>;

const TEXT_KINDS = ["text", "identifier", "role", "expected", "typed", "env"] as const;
// Every kind the secret placeholder rule applies to: all but `echo`.
const GUARDED_KINDS = [...TEXT_KINDS, "arg"] as const;

// MAX_OUTPUT_DEPTH in flow-script-executor.ts: the deepest document a script
// step may return, its root object counting as level 1.
const MAX_DOCUMENT_DEPTH = 4096;

const UNSAFE_NOTE =
  "past the largest integer a JSON number holds exactly (9007199254740991), so it may have " +
  "been rounded; write an identifier as a string.";

const PLACEHOLDER_NOTE =
  "A secret placeholder must be written in the flow file whole; a script cannot produce one";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function resolve(text: string, kind: FieldKind, document: OutputDocument): Resolved {
  const result = resolveOutputField(text, kind, document);
  if (!result.ok) {
    throw new Error(`expected ${JSON.stringify(text)} (${kind}) to resolve, got: ${result.reason}`);
  }
  return result;
}

function reject(text: string, kind: FieldKind, document: OutputDocument): string {
  const result = resolveOutputField(text, kind, document);
  if (result.ok) {
    throw new Error(
      `expected ${JSON.stringify(text)} (${kind}) to be rejected, got ${String(result.value)}`
    );
  }
  return result.reason;
}

function parts(text: string) {
  const parsed = parseOutputReferences(text);
  if ("error" in parsed) throw new Error(describeOutputReferenceSyntaxError(parsed.error));
  return parsed.parts;
}

function syntaxError(text: string): OutputReferenceSyntaxError {
  const parsed = parseOutputReferences(text);
  if (!("error" in parsed)) throw new Error(`expected ${JSON.stringify(text)} to be rejected`);
  return parsed.error;
}

const path = (...accessors: Array<string | number>) => ({
  kind: "path",
  accessors: accessors.map((accessor) =>
    typeof accessor === "number" ? { index: accessor } : { key: accessor }
  ),
});
const literal = (value: string | number | boolean | null) => ({ kind: "literal", value });
const ref = (source: string, ...operands: unknown[]) => ({ reference: { source, operands } });

/**
 * A JSON value `depth` containers deep. `JSON.parse` builds it, so no recursive
 * builder can overflow before the code under test does.
 */
function nested(depth: number, leaf: string, open = '{"a":', close = "}"): unknown {
  return JSON.parse(open.repeat(depth) + leaf + close.repeat(depth));
}

/** How many containers deep `value` goes along its first member, without recursion. */
function depthOf(value: unknown): { depth: number; leaf: unknown } {
  let depth = 0;
  let node = value;
  while (node !== null && typeof node === "object") {
    depth++;
    node = Object.values(node)[0];
  }
  return { depth, leaf: node };
}

// ── parseOutputReferences: accepted syntax ────────────────────────────

describe("parseOutputReferences — accepted syntax", () => {
  it("reads a simple path", () => {
    expect(parts("{{output:user}}")).toEqual([ref("user", path("user"))]);
  });

  it("reads a nested path", () => {
    expect(parts("{{output:user.profile.name}}")).toEqual([
      ref("user.profile.name", path("user", "profile", "name")),
    ]);
  });

  it("reads an index, a multi-digit index and a chain of them", () => {
    expect(parts("{{output:codes[0]}}")).toEqual([ref("codes[0]", path("codes", 0))]);
    expect(parts("{{output:grid[10][2].cell}}")).toEqual([
      ref("grid[10][2].cell", path("grid", 10, 2, "cell")),
    ]);
  });

  it("reads a quoted key in double or single quotes", () => {
    expect(parts('{{output:order["order-id"]}}')).toEqual([
      ref('order["order-id"]', path("order", "order-id")),
    ]);
    expect(parts("{{output:order['order-id']}}")).toEqual([
      ref("order['order-id']", path("order", "order-id")),
    ]);
  });

  it("lets a backslash escape the next character in a quoted key", () => {
    expect(parts(String.raw`{{output:quotes['it\'s']}}`)).toEqual([
      ref(String.raw`quotes['it\'s']`, path("quotes", "it's")),
    ]);
    expect(parts(String.raw`{{output:quotes["say \"hi\""]}}`)).toEqual([
      ref(String.raw`quotes["say \"hi\""]`, path("quotes", 'say "hi"')),
    ]);
    expect(parts(String.raw`{{output:quotes['back\\slash']}}`)).toEqual([
      ref(String.raw`quotes['back\\slash']`, path("quotes", "back\\slash")),
    ]);
  });

  // The escape copies the next character; it is not a JSON escape, so `\n` is
  // an `n`, not a newline.
  it("reads a backslash before an ordinary letter as that letter", () => {
    expect(parts(String.raw`{{output:x ?? 'a\nb'}}`)).toEqual([
      ref(String.raw`x ?? 'a\nb'`, path("x"), literal("anb")),
    ]);
  });

  it("allows whitespace between tokens, after `{{output:` and before `}}`", () => {
    expect(parts("{{output:  user.id  ??  'x'  }}")).toEqual([
      ref("user.id  ??  'x'", path("user", "id"), literal("x")),
    ]);
    expect(parts("{{output:\n\tuser.id\r\n??\t'x'\n}}")).toEqual([
      ref("user.id\r\n??\t'x'", path("user", "id"), literal("x")),
    ]);
  });

  it("reads a chain of three operands", () => {
    expect(parts("{{output:user.region ?? defaults.region ?? 'unknown'}}")).toEqual([
      ref(
        "user.region ?? defaults.region ?? 'unknown'",
        path("user", "region"),
        path("defaults", "region"),
        literal("unknown")
      ),
    ]);
  });

  it.each([
    ["a single-quoted string", "'single'", "single"],
    ["a double-quoted string", '"double"', "double"],
    ["an empty string", "''", ""],
    ["an integer", "42", 42],
    ["zero", "0", 0],
    ["a negative decimal with an exponent", "-1.5e3", -1500],
    ["a decimal with a signed exponent", "2.5E-2", 0.025],
    ["true", "true", true],
    ["false", "false", false],
    ["null", "null", null],
  ] as const)("takes %s as a fallback literal", (_label, spelled, value) => {
    expect(parts(`{{output:x ?? ${spelled}}}`)).toEqual([
      ref(`x ?? ${spelled}`, path("x"), literal(value)),
    ]);
  });

  it("reads a key named like a literal word with brackets", () => {
    expect(parts('{{output:flags["null"]}}')).toEqual([
      ref('flags["null"]', path("flags", "null")),
    ]);
  });

  // A literal word is a whole segment, not a prefix: `nullable` is a path.
  it("reads a word that only starts with a literal word as a path", () => {
    expect(parts("{{output:x ?? nullable.trueish}}")).toEqual([
      ref("x ?? nullable.trueish", path("x"), path("nullable", "trueish")),
    ]);
  });

  it("splits several references and the literal text around them", () => {
    expect(parts("Hi {{output:user.name}}, #{{output:codes[1]}}!")).toEqual([
      { text: "Hi " },
      ref("user.name", path("user", "name")),
      { text: ", #" },
      ref("codes[1]", path("codes", 1)),
      { text: "!" },
    ]);
    expect(parts("{{output:a}}{{output:b}}")).toEqual([ref("a", path("a")), ref("b", path("b"))]);
  });

  it.each(["{{ output:x }}", "{{Output:x}}", "{{OUTPUT:x}}", "{{output :x}}", "{output:x}"])(
    "leaves the near spelling %s as literal text",
    (field) => {
      expect(parts(field)).toEqual([{ text: field }]);
      const result = resolve(field, "text", { x: "resolved" });
      expect(result.value).toBe(field);
      expect(result.references).toEqual([]);
    }
  );

  it("exports the marker a reference starts with", () => {
    expect(OUTPUT_REFERENCE_MARKER).toBe("{{output:");
  });
});

// ── parseOutputReferences: rejected syntax ────────────────────────────

describe("parseOutputReferences — rejected syntax", () => {
  // [label, field, index where the parser stopped, message fragment]. Each
  // index is counted from the start of the field: `{{output:` is 9 characters,
  // so the first character of a reference body is index 9.
  const REJECTED: Array<[string, string, number, string]> = [
    ["JavaScript `||`", "{{output:user.id || 'x'}}", 17, "`||` is not supported"],
    ["JavaScript `&&`", "{{output:a && b}}", 11, "`&&` is not supported"],
    ["`typeof`", "{{output:typeof user}}", 16, "expected `??` between two operands"],
    ["optional chaining", "{{output:user?.id}}", 13, "`?` is not supported"],
    ["`+`", "{{output:a + b}}", 11, "`+` is not supported"],
    ["a ternary", "{{output:a ? b : c}}", 11, "`?` is not supported"],
    ["a method call", "{{output:user.toString()}}", 22, "function calls are not supported"],
    ["a function call", "{{output:trim(user)}}", 13, "function calls are not supported"],
    ["parentheses", "{{output:(user.id)}}", 9, "parentheses are not supported"],
    [
      "a string as the first operand",
      "{{output:'x' ?? user}}",
      9,
      "the first operand must be a path",
    ],
    ["a number as the first operand", "{{output:42}}", 9, "the first operand must be a path"],
    ["null as the first operand", "{{output:null ?? x}}", 9, 'such as `flags["null"]`'],
    // The first `}}` closes the reference, so the body ends right after `{`.
    ["an object literal fallback", "{{output:x ?? {}}}", 14, "object and array literals"],
    ["an array literal fallback", "{{output:x ?? []}}", 14, "object and array literals"],
    ["`??` with nothing after it", "{{output:user.id ??}}", 17, "`??` needs an operand after it"],
    ["an unterminated string", "{{output:x ?? 'abc}}", 14, "the string has no closing quote"],
    ["whitespace before `.`", "{{output:user .id}}", 14, "a path cannot contain whitespace"],
    ["whitespace after `.`", "{{output:user. id}}", 14, "expected a name after `.`"],
    ["whitespace before `[`", "{{output:codes [0]}}", 15, "a path cannot contain whitespace"],
    ["whitespace inside `[`", "{{output:codes[ 0]}}", 15, "expected an index such as `[0]`"],
    ["two operands without `??`", "{{output:user.id user.name}}", 17, "expected `??` between"],
    ["an index with a leading zero", "{{output:codes[01]}}", 15, "an index cannot start with 0"],
    ["a negative index", "{{output:codes[-1]}}", 15, "expected an index such as `[0]`"],
    ["a number with a leading zero", "{{output:x ?? 01}}", 14, "a number cannot start with 0"],
    ["whitespace inside a number", "{{output:x ?? - 1}}", 14, "expected a number after `-`"],
    ["a number too large to hold", "{{output:x ?? 1e999}}", 14, "the number is too large to hold"],
    ["an empty reference", "{{output:}}", 9, "the reference names no path"],
    ["a blank reference", "{{output:   }}", 12, "the reference names no path"],
    ["a missing `}}`", "{{output:user.id", 0, "the reference has no closing `}}`"],
    ["a missing `}}` after text", "Hi {{output:user.id}", 3, "the reference has no closing `}}`"],
    ["a `'}}'` literal", "{{output:x ?? '}}'}}", 14, "the string has no closing quote"],
    ["a bad second reference", "{{output:ok}} and {{output:bad ||}}", 31, "`||` is not supported"],
  ];

  it.each(REJECTED)("rejects %s", (_label, field, at, message) => {
    const error = syntaxError(field);
    expect(error.at).toBe(at);
    expect(error.message).toContain(message);
    const description = describeOutputReferenceSyntaxError(error);
    expect(description).toContain(`(character ${at + 1}, in `);
    expect(reject(field, "arg", { user: { id: 1 }, codes: [1], x: 1, a: 1, b: 1, ok: 1 })).toBe(
      `malformed output reference: ${description}`
    );
  });

  it("describes an error by its 1-based character and the reference it stopped in", () => {
    const error = syntaxError("Hi {{output:user.id || 'x'}} there");
    expect(error).toEqual({
      at: 20,
      reference: "{{output:user.id || 'x'}}",
      message: "`||` is not supported; `??` is the only operator",
    });
    expect(describeOutputReferenceSyntaxError(error)).toBe(
      "`||` is not supported; `??` is the only operator (character 21, in " +
        "\"{{output:user.id || 'x'}}\")"
    );
  });

  it("quotes the reference up to the first `}}` when a literal holds `}}`", () => {
    const error = syntaxError("{{output:x ?? '}}'}}");
    expect(error.reference).toBe("{{output:x ?? '}}");
    expect(error.message).toContain("the first `}}` ends a reference, even inside a string");
  });

  it("quotes the rest of the field when the reference is never closed", () => {
    expect(syntaxError("Hi {{output:user.id}").reference).toBe("{{output:user.id}");
  });

  it("quotes only the reference that failed, not an earlier good one", () => {
    expect(syntaxError("{{output:ok}} and {{output:bad ||}}").reference).toBe("{{output:bad ||}}");
  });

  it("tells an author to read a literal-word key with brackets", () => {
    expect(syntaxError("{{output:null ?? x}}").message).toBe(
      "the first operand must be a path into the output document, such as `user.id`; a " +
        "literal can only follow `??`. `null` is a literal; read a key of that name with " +
        'brackets, such as `flags["null"]`'
    );
  });
});

// ── resolveOutputField: reading paths ─────────────────────────────────

describe("resolveOutputField — operands", () => {
  const document = {
    user: { id: 42, name: "Ada", rank: 3 },
    defaults: { region: "eu" },
    codes: [10, 20],
    flags: { null: "yes" },
  };

  it("reads a simple path, a nested path, an index and a quoted key", () => {
    const doc = { ...document, order: { "order-id": "A-1" } };
    expect(resolve("{{output:codes}}", "arg", doc).value).toEqual([10, 20]);
    expect(resolve("{{output:user.name}}", "text", doc).value).toBe("Ada");
    expect(resolve("{{output:codes[1]}}", "text", doc).value).toBe("20");
    expect(resolve('{{output:order["order-id"]}}', "text", doc).value).toBe("A-1");
    expect(resolve("{{output:order['order-id']}}", "text", doc).value).toBe("A-1");
  });

  it("takes the value from the middle operand when only that one is set", () => {
    const result = resolve(
      "{{output:user.region ?? defaults.region ?? 'unknown'}}",
      "text",
      document
    );
    expect(result.value).toBe("eu");
    expect(result.references).toEqual([
      { source: "user.region ?? defaults.region ?? 'unknown'", value: "eu" },
    ]);
  });

  it("takes the first operand that gives a value, left to right", () => {
    expect(resolve("{{output:user.name ?? defaults.region}}", "text", document).value).toBe("Ada");
    expect(resolve("{{output:user.region ?? other ?? 'unknown'}}", "text", document).value).toBe(
      "unknown"
    );
  });

  it.each([
    ["a single-quoted string", "'single'", "single"],
    ["a double-quoted string", '"double"', "double"],
    ["an integer", "42", 42],
    ["a negative decimal with an exponent", "-1.5e3", -1500],
    ["true", "true", true],
    ["false", "false", false],
    ["null", "null", null],
  ] as const)("resolves %s fallback to its own JSON value", (_label, spelled, value) => {
    expect(resolve(`{{output:missing ?? ${spelled}}}`, "arg", document).value).toBe(value);
  });

  it.each([
    ["'single'", "single"],
    ['"double"', "double"],
    ["42", "42"],
    ["-1.5e3", "-1500"],
    ["true", "true"],
    ["false", "false"],
  ])("writes the fallback literal %s into text as %s", (spelled, text) => {
    expect(resolve(`Value: {{output:missing ?? ${spelled}}}`, "text", document).value).toBe(
      `Value: ${text}`
    );
  });

  it("reads a key named `null` with brackets", () => {
    expect(resolve('{{output:flags["null"]}}', "text", document).value).toBe("yes");
  });

  it("resolves several references in one field with the literal text around them", () => {
    const result = resolve(
      "Hello {{output:user.name}}, you are #{{output:user.rank}} of {{output:codes[1]}}.",
      "typed",
      document
    );
    expect(result.value).toBe("Hello Ada, you are #3 of 20.");
    expect(result.references).toEqual([
      { source: "user.name", value: "Ada" },
      { source: "user.rank", value: 3 },
      { source: "codes[1]", value: 20 },
    ]);
  });

  it("returns a field with no reference unchanged", () => {
    expect(resolve("plain text", "text", document)).toEqual({
      ok: true,
      value: "plain text",
      references: [],
    });
  });
});

// ── resolveOutputField: missing paths ─────────────────────────────────

describe("resolveOutputField — missing paths", () => {
  const document = {
    user: { id: 42, name: "Ada", rank: 3 },
    codes: [10, 20],
    single: ["only"],
    none: [],
    nulls: [null],
    flag: true,
    empty: {},
    maybe: null,
    order: { "order-id": 7 },
  };

  const MISSES: Array<[string, string, string]> = [
    [
      "a key an object does not have",
      "user.promo",
      "`output.user` has no `promo` (its keys: id, name, rank)",
    ],
    [
      "a key the root does not have",
      "missing",
      "`output` has no `missing` (its keys: user, codes, single, none, nulls, flag, empty, " +
        "maybe, order)",
    ],
    [
      "a segment below a number",
      "user.id.value",
      "`output.user.id` is a number, so it has no `value`",
    ],
    [
      "a segment below a string",
      "user.name.first",
      "`output.user.name` is a string, so it has no `first`",
    ],
    ["a segment below a boolean", "flag.on", "`output.flag` is a boolean, so it has no `on`"],
    [
      "an index below a string",
      "user.name[0]",
      "`output.user.name` is a string, so it has no `[0]`",
    ],
    ["an index below a number", "user.id[0]", "`output.user.id` is a number, so it has no `[0]`"],
    [
      "`length` of a string",
      "user.name.length",
      "`output.user.name` is a string, so it has no `length`",
    ],
    ["`length` of an array", "codes.length", "`output.codes` is an array, so it has no `length`"],
    [
      "an inherited `constructor`",
      "user.constructor",
      "`output.user` has no `constructor` (its keys: id, name, rank)",
    ],
    [
      "an inherited `toString`",
      "user.toString",
      "`output.user` has no `toString` (its keys: id, name, rank)",
    ],
    [
      "an inherited `__proto__`",
      "user.__proto__",
      "`output.user` has no `__proto__` (its keys: id, name, rank)",
    ],
    ["a key on an array", "codes.first", "`output.codes` is an array, so it has no `first`"],
    [
      "an index on an object",
      "user[0]",
      "`output.user` is an object, so it has no `[0]` (its keys: id, name, rank)",
    ],
    ["an index past the end", "codes[2]", "`output.codes` has 2 elements, so it has no `[2]`"],
    [
      "an index past a one-element array",
      "single[1]",
      "`output.single` has 1 element, so it has no `[1]`",
    ],
    ["an index into an empty array", "none[0]", "`output.none` has 0 elements, so it has no `[0]`"],
    ["a key below null", "maybe.x", "`output.maybe` is null, so it has no `x`"],
    [
      "null at the end",
      "maybe",
      "`output.maybe` is null; add a `??` fallback if the value can be null",
    ],
    [
      "null in an array at the end",
      "nulls[0]",
      "`output.nulls[0]` is null; add a `??` fallback if the value can be null",
    ],
    ["a key of an empty object", "empty.x", "`output.empty` has no `x` (it has no keys)"],
    [
      "an index on an empty object",
      "empty[0]",
      "`output.empty` is an object, so it has no `[0]` (it has no keys)",
    ],
    [
      "a quoted key an object does not have",
      'order["missing-id"]',
      '`output.order` has no `["missing-id"]` (its keys: ["order-id"])',
    ],
    [
      "a segment below a quoted key",
      'order["order-id"].x',
      '`output.order["order-id"]` is a number, so it has no `x`',
    ],
  ];

  it.each(MISSES)("names where %s stopped", (_label, spelled, miss) => {
    expect(reject(`{{output:${spelled}}}`, "text", document)).toBe(
      `{{output:${spelled}}} did not resolve: ${miss}`
    );
  });

  it.each(MISSES)("lets a fallback stand in for %s", (_label, spelled) => {
    expect(resolve(`{{output:${spelled} ?? 'fallback'}}`, "text", document).value).toBe("fallback");
    expect(resolve(`{{output:${spelled} ?? user.name}}`, "text", document).value).toBe("Ada");
  });

  it("names every operand that gave no value", () => {
    expect(reject("{{output:user.promo ?? codes[5] ?? flag.x}}", "text", document)).toBe(
      "{{output:user.promo ?? codes[5] ?? flag.x}} did not resolve: " +
        "`output.user` has no `promo` (its keys: id, name, rank); " +
        "`output.codes` has 2 elements, so it has no `[5]`; " +
        "`output.flag` is a boolean, so it has no `x`"
    );
  });

  it("lists the first 20 keys of a large object and counts the rest", () => {
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
    const listed = Array.from({ length: 20 }, (_, i) => `k${i}`).join(", ");
    expect(reject("{{output:many.missing}}", "text", { many })).toBe(
      `{{output:many.missing}} did not resolve: \`output.many\` has no \`missing\` ` +
        `(its keys: ${listed}, and 5 more)`
    );
  });

  it("lists all keys of an object with exactly 20", () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    const listed = Array.from({ length: 20 }, (_, i) => `k${i}`).join(", ");
    expect(reject("{{output:many.missing}}", "text", { many })).toBe(
      `{{output:many.missing}} did not resolve: \`output.many\` has no \`missing\` ` +
        `(its keys: ${listed})`
    );
  });

  it.each([
    ["0", 0, "0"],
    ["false", false, "false"],
  ] as const)("takes %s as a value, not as missing", (_label, value, text) => {
    const doc = { value };
    expect(resolve("{{output:value ?? 'fallback'}}", "text", doc).value).toBe(text);
    expect(resolve("{{output:value ?? 'fallback'}}", "arg", doc).value).toBe(value);
  });

  it('takes "" as a value, not as missing', () => {
    const doc = { blank: "" };
    const whole = resolve("{{output:blank ?? 'fallback'}}", "arg", doc);
    expect(whole.value).toBe("");
    expect(whole.references).toEqual([{ source: "blank ?? 'fallback'", value: "" }]);
    expect(resolve("[{{output:blank ?? 'fallback'}}]", "typed", doc).value).toBe("[]");
  });
});

// ── resolveOutputField: value types ───────────────────────────────────

const TYPED_DOCUMENT = {
  user: { id: 42, name: "Ada", tags: ["a", "b"] },
  codes: [10, 20],
  name: "Ada",
  n: 42,
  half: -0.5,
  huge: 1e21,
  negativeZero: -0,
  yes: true,
  no: false,
  maybe: null,
};

describe.each(TEXT_KINDS)("resolveOutputField — values in a %s field", (kind) => {
  it("writes a string as is", () => {
    expect(resolve("{{output:name}}", kind, TYPED_DOCUMENT).value).toBe("Ada");
  });

  it("writes a number the way JSON.stringify does", () => {
    expect(resolve("{{output:n}}", kind, TYPED_DOCUMENT).value).toBe("42");
    expect(resolve("{{output:half}}", kind, TYPED_DOCUMENT).value).toBe("-0.5");
    expect(resolve("{{output:huge}}", kind, TYPED_DOCUMENT).value).toBe("1e+21");
    expect(resolve("{{output:negativeZero}}", kind, TYPED_DOCUMENT).value).toBe("0");
    expect(resolve("id-{{output:n}}", kind, TYPED_DOCUMENT).value).toBe("id-42");
  });

  it("writes a boolean as true or false", () => {
    expect(resolve("{{output:yes}}", kind, TYPED_DOCUMENT).value).toBe("true");
    expect(resolve("{{output:no}}", kind, TYPED_DOCUMENT).value).toBe("false");
  });

  it("keeps text even when the field is exactly one reference", () => {
    const result = resolve("{{output:n}}", kind, TYPED_DOCUMENT);
    expect(result.value).toBe("42");
    expect("wholeFieldType" in result).toBe(false);
    expect(result.references).toEqual([{ source: "n", value: 42 }]);
  });

  it("rejects an object", () => {
    expect(reject("{{output:user}}", kind, TYPED_DOCUMENT)).toBe(
      "{{output:user}} gave an object, and this field needs text; reference a string, a number " +
        "or a boolean inside it"
    );
  });

  it("rejects an array", () => {
    expect(reject("tags: {{output:user.tags}}", kind, TYPED_DOCUMENT)).toBe(
      "{{output:user.tags}} gave an array, and this field needs text; reference a string, a " +
        "number or a boolean inside it"
    );
  });

  it("rejects null and advises ending the chain with a text literal", () => {
    expect(reject("{{output:maybe ?? null}}", kind, TYPED_DOCUMENT)).toBe(
      "{{output:maybe ?? null}} gave null, and this field needs text; end the `??` chain with a " +
        "text literal, such as 'none'"
    );
  });
});

describe("resolveOutputField — values in an arg field", () => {
  it("keeps a number when the field is exactly one reference", () => {
    const result = resolve("{{output:n}}", "arg", TYPED_DOCUMENT);
    expect(result.value).toBe(42);
    expect(result.wholeFieldType).toBe("a number");
  });

  it("keeps a boolean when the field is exactly one reference", () => {
    const result = resolve("{{output:no}}", "arg", TYPED_DOCUMENT);
    expect(result.value).toBe(false);
    expect(result.wholeFieldType).toBe("a boolean");
  });

  it("keeps an object as a deep copy", () => {
    const document = {
      request: { headers: { accept: "json" }, list: [1, { deep: "value" }] },
    };
    const result = resolve("{{output:request}}", "arg", document);
    expect(result.wholeFieldType).toBe("an object");
    expect(result.value).toEqual(document.request);
    expect(result.value).not.toBe(document.request);

    const copy = result.value as { headers: { accept: string }; list: [number, { deep: string }] };
    copy.headers.accept = "changed";
    copy.list[1].deep = "changed";
    copy.list.push(3);
    expect(document.request).toEqual({
      headers: { accept: "json" },
      list: [1, { deep: "value" }],
    });
  });

  it("keeps an array as a deep copy", () => {
    const document = { rows: [{ id: 1 }, { id: 2 }] };
    const result = resolve("{{output:rows}}", "arg", document);
    expect(result.wholeFieldType).toBe("an array");
    expect(result.value).toEqual([{ id: 1 }, { id: 2 }]);
    (result.value as Array<{ id: number }>)[0]!.id = 99;
    expect(document.rows[0]!.id).toBe(1);
  });

  it("gives null through a trailing `?? null`", () => {
    const result = resolve("{{output:maybe ?? null}}", "arg", TYPED_DOCUMENT);
    expect(result.value).toBeNull();
    expect(result.wholeFieldType).toBe("null");
  });

  it("keeps a string, and sets no wholeFieldType for it", () => {
    const fromDocument = resolve("{{output:name}}", "arg", TYPED_DOCUMENT);
    expect(fromDocument.value).toBe("Ada");
    expect("wholeFieldType" in fromDocument).toBe(false);

    const fromLiteral = resolve("{{output:missing ?? 'x'}}", "arg", TYPED_DOCUMENT);
    expect(fromLiteral.value).toBe("x");
    expect("wholeFieldType" in fromLiteral).toBe(false);
  });

  it("still counts a reference with whitespace inside its braces as the whole field", () => {
    const result = resolve("{{output:  n  }}", "arg", TYPED_DOCUMENT);
    expect(result.value).toBe(42);
    expect(result.wholeFieldType).toBe("a number");
  });

  it.each([
    ["text before it", "id-{{output:n}}", "id-42"],
    ["a leading space", " {{output:n}}", " 42"],
    ["a trailing space", "{{output:n}} ", "42 "],
    ["a second reference", "{{output:n}}{{output:yes}}", "42true"],
  ])("writes text when the reference has %s", (_label, field, text) => {
    const result = resolve(field, "arg", TYPED_DOCUMENT);
    expect(result.value).toBe(text);
    expect("wholeFieldType" in result).toBe(false);
  });

  it("rejects an object, an array or null embedded in other text", () => {
    expect(reject("x{{output:user}}", "arg", TYPED_DOCUMENT)).toBe(
      "{{output:user}} gave an object, and this field needs text; reference a string, a number " +
        "or a boolean inside it"
    );
    expect(reject("{{output:codes}} ", "arg", TYPED_DOCUMENT)).toContain(
      "{{output:codes}} gave an array, and this field needs text"
    );
    expect(reject("x{{output:maybe ?? null}}", "arg", TYPED_DOCUMENT)).toContain(
      "{{output:maybe ?? null}} gave null, and this field needs text"
    );
  });
});

describe("resolveOutputField — values in an echo", () => {
  it("prints an object, an array and null as compact JSON", () => {
    expect(resolve("{{output:user}}", "echo", TYPED_DOCUMENT).value).toBe(
      '{"id":42,"name":"Ada","tags":["a","b"]}'
    );
    expect(resolve("codes: {{output:codes}}", "echo", TYPED_DOCUMENT).value).toBe("codes: [10,20]");
    expect(resolve("{{output:maybe ?? null}}", "echo", TYPED_DOCUMENT).value).toBe("null");
  });

  it("prints a whole-field number as text and sets no wholeFieldType", () => {
    const result = resolve("{{output:n}}", "echo", TYPED_DOCUMENT);
    expect(result.value).toBe("42");
    expect("wholeFieldType" in result).toBe(false);
  });

  it("has a 64 KiB limit", () => {
    expect(MAX_ECHO_MESSAGE_CHARS).toBe(65_536);
  });

  it("keeps a message of exactly the limit whole", () => {
    const big = "a".repeat(MAX_ECHO_MESSAGE_CHARS);
    expect(resolve("{{output:big}}", "echo", { big }).value).toBe(big);
  });

  it("cuts a message one character over the limit", () => {
    const big = "a".repeat(MAX_ECHO_MESSAGE_CHARS + 1);
    expect(resolve("{{output:big}}", "echo", { big }).value).toBe(
      `${"a".repeat(MAX_ECHO_MESSAGE_CHARS)}…(+1 chars)`
    );
  });

  it("cuts a long message and counts exactly what it dropped, text around it included", () => {
    const big = "a".repeat(70_000);
    // "log: " (5) + 70,000 = 70,005 characters; 70,005 - 65,536 = 4,469 dropped.
    expect(resolve("log: {{output:big}}", "echo", { big }).value).toBe(
      `log: ${"a".repeat(MAX_ECHO_MESSAGE_CHARS - 5)}…(+4469 chars)`
    );
  });

  it("cuts a long object printed as JSON", () => {
    const list = Array.from({ length: 20_000 }, () => "abcd");
    const json = JSON.stringify(list);
    expect(resolve("{{output:list}}", "echo", { list }).value).toBe(
      `${json.slice(0, MAX_ECHO_MESSAGE_CHARS)}…(+${json.length - MAX_ECHO_MESSAGE_CHARS} chars)`
    );
  });

  it("never splits a surrogate pair that straddles the cut", () => {
    // The pair occupies indexes 65,535 and 65,536, so a cut at 65,536 would
    // keep only its high half.
    const big = `${"a".repeat(MAX_ECHO_MESSAGE_CHARS - 1)}\u{1F600}b`;
    const value = resolve("{{output:big}}", "echo", { big }).value as string;
    expect(value).toBe(`${"a".repeat(MAX_ECHO_MESSAGE_CHARS - 1)}…(+3 chars)`);
    expect(LONE_SURROGATE.test(value)).toBe(false);
  });

  it("keeps a surrogate pair that ends exactly at the cut", () => {
    const big = `${"a".repeat(MAX_ECHO_MESSAGE_CHARS - 2)}\u{1F600}bc`;
    const value = resolve("{{output:big}}", "echo", { big }).value as string;
    expect(value).toBe(`${"a".repeat(MAX_ECHO_MESSAGE_CHARS - 2)}\u{1F600}…(+2 chars)`);
    expect(LONE_SURROGATE.test(value)).toBe(false);
  });

  it("cuts only an echo, not a field a tool reads", () => {
    const big = "a".repeat(70_000);
    expect(resolve("{{output:big}}", "typed", { big }).value).toBe(big);
  });
});

// ── resolveOutputField: resolved text is validated again ──────────────

describe("resolveOutputField — `?? ''` and the field's own rules", () => {
  const document = {
    zeroWidth: "​‍",
    privateUse: "",
    blank: "  \t",
    icon: " Save",
    nul: "a\u0000b",
    highSurrogate: "x\uD800y",
    lowSurrogate: "\uDC00",
    pair: "\u{1F600}",
  };

  it.each([
    ["text", "selector text must contain at least one visible character"],
    ["identifier", "a selector identifier cannot be empty"],
    ["role", "a selector role cannot be empty"],
    ["expected", "expected text cannot be empty — empty text is found in every element"],
    ["typed", "type needs a non-empty text"],
  ] as const)("rejects `?? ''` alone in a %s field", (kind, rule) => {
    expect(reject("{{output:missing ?? ''}}", kind, document)).toContain(
      `"{{output:missing ?? ''}}" resolved to "", and ${rule}`
    );
  });

  it.each(["text", "identifier", "role", "expected", "typed", "env", "arg", "echo"] as const)(
    "accepts `?? ''` next to other text in a %s field",
    (kind) => {
      expect(resolve("Order {{output:missing ?? ''}}", kind, document).value).toBe("Order ");
    }
  );

  it.each(["echo", "arg", "env"] as const)("accepts `?? ''` alone in a %s field", (kind) => {
    expect(resolve("{{output:missing ?? ''}}", kind, document).value).toBe("");
  });

  it.each([
    ["only zero-width characters", "zeroWidth"],
    ["only a private-use character", "privateUse"],
    ["only whitespace", "blank"],
  ])("rejects a text selector that resolves to %s", (_label, key) => {
    expect(reject(`{{output:${key}}}`, "text", document)).toContain(
      "selector text must contain at least one visible character"
    );
  });

  it("accepts a text selector with an icon beside a visible word", () => {
    expect(resolve("{{output:icon}}", "text", document).value).toBe(" Save");
  });

  it("rejects a NUL character in an env value", () => {
    expect(reject("pre-{{output:nul}}", "env", document)).toBe(
      `"pre-{{output:nul}}" resolved to "pre-a\\u0000b", and the value holds a NUL character, ` +
        "which an environment cannot carry"
    );
  });

  it("rejects a lone surrogate in an env value", () => {
    expect(reject("{{output:highSurrogate}}", "env", document)).toContain(
      "the value holds an unpaired surrogate, which an environment cannot carry"
    );
    expect(reject("{{output:lowSurrogate}}", "env", document)).toContain(
      "the value holds an unpaired surrogate"
    );
  });

  it("accepts a whole surrogate pair in an env value", () => {
    expect(resolve("{{output:pair}}", "env", document).value).toBe("\u{1F600}");
  });
});

// ── resolveOutputField: values are copied, never read again ───────────

describe("resolveOutputField — a value is copied literally", () => {
  it("copies `$&`, `$1` and the other replacement patterns literally", () => {
    const price = "$& costs $1, $$, $` and $'";
    expect(resolve("Total: {{output:price}} ({{output:price}})", "typed", { price }).value).toBe(
      `Total: ${price} (${price})`
    );
  });

  it.each(["typed", "echo", "arg"] as const)(
    "does not read a value holding `{{output:` again in a %s field",
    (kind) => {
      const document = { a: "{{output:b}}", b: "B" };
      const embedded = resolve("see {{output:a}}", kind, document);
      expect(embedded.value).toBe("see {{output:b}}");
      expect(embedded.references).toEqual([{ source: "a", value: "{{output:b}}" }]);
      expect(resolve("{{output:a}}", kind, document).value).toBe("{{output:b}}");
    }
  );
});

// ── resolveOutputField: secret placeholders ───────────────────────────

describe("resolveOutputField — secret placeholders", () => {
  const spelled = (field: string, placeholder = "{{secret:API_KEY}}") =>
    `${JSON.stringify(field)} would spell the secret placeholder ${placeholder} with text from ` +
    "the output document. A secret placeholder must be written in the flow file whole";

  describe.each(GUARDED_KINDS)("in a %s field", (kind) => {
    it("rejects a placeholder two values spell between them", () => {
      const field = "{{output:first}}{{output:last}}";
      expect(reject(field, kind, { first: "{{secre", last: "t:API_KEY}}" })).toBe(spelled(field));
    });

    it("rejects a placeholder a literal `{` before a reference completes", () => {
      const field = "{{{output:x}}";
      expect(reject(field, kind, { x: "{secret:API_KEY}}" })).toBe(spelled(field));
    });

    it("rejects a placeholder a value closes with its last `}`", () => {
      const field = "{{secret:API_KEY}{{output:brace}}";
      expect(reject(field, kind, { brace: "}" })).toBe(spelled(field));
    });

    // The first `}}` ends the reference, so this field is the text
    // `{{secret:`, a reference to `name`, and the text `}}`: the document
    // would pick which secret the placeholder names.
    it("rejects a placeholder whose name the document picks", () => {
      const field = "{{secret:{{output:name}}}}";
      expect(reject(field, kind, { name: "API_KEY" })).toBe(spelled(field));
    });

    it("rejects a value that holds a whole placeholder beside other text", () => {
      const field = "Bearer {{output:token}}";
      expect(reject(field, kind, { token: "{{secret:API_KEY}}" })).toBe(spelled(field));
      expect(reject(field, kind, { token: "a {{secret:API_KEY}} b" })).toBe(spelled(field));
    });

    it("keeps a placeholder the author wrote beside a reference", () => {
      expect(
        resolve("Bearer {{secret:API_KEY}} for {{output:user.id}}", kind, { user: { id: 42 } })
          .value
      ).toBe("Bearer {{secret:API_KEY}} for 42");
      expect(
        resolve("{{secret:API_KEY}}{{output:user.id}}", kind, { user: { id: 42 } }).value
      ).toBe("{{secret:API_KEY}}42");
    });

    // The rule is "at least one character came from a value": an empty value
    // inside an authored placeholder contributes none, so every character of
    // the name is still the author's.
    it("keeps an authored placeholder an empty value sits inside", () => {
      expect(resolve("{{secret:API{{output:blank}}_KEY}}", kind, { blank: "" }).value).toBe(
        "{{secret:API_KEY}}"
      );
    });
  });

  it.each(TEXT_KINDS)("rejects a whole-field value holding a placeholder in a %s field", (kind) => {
    expect(reject("{{output:token}}", kind, { token: "{{secret:API_KEY}}" })).toBe(
      spelled("{{output:token}}")
    );
  });

  it("prints what an echo reads, placeholders included", () => {
    expect(
      resolve("{{output:first}}{{output:last}}", "echo", { first: "{{secre", last: "t:API_KEY}}" })
        .value
    ).toBe("{{secret:API_KEY}}");
    expect(resolve("{{secret:{{output:name}}}}", "echo", { name: "API_KEY" }).value).toBe(
      "{{secret:API_KEY}}"
    );
    expect(resolve("{{output:token}}", "echo", { token: "{{secret:API_KEY}}" }).value).toBe(
      "{{secret:API_KEY}}"
    );
  });

  it("parses a document-picked secret name the way the first `}}` dictates", () => {
    expect(parts("{{secret:{{output:name}}}}")).toEqual([
      { text: "{{secret:" },
      ref("name", path("name")),
      { text: "}}" },
    ]);
  });

  // A name the placeholder grammar refuses spells no placeholder, so nothing
  // downstream would resolve it either.
  it("leaves a document-picked name that is not a placeholder name as text", () => {
    expect(resolve("{{secret:{{output:name}}}}", "typed", { name: "API-KEY" }).value).toBe(
      "{{secret:API-KEY}}"
    );
  });

  describe("in a whole-field arg reference", () => {
    it("rejects a string holding a placeholder", () => {
      expect(reject("{{output:token}}", "arg", { token: "{{secret:API_KEY}}" })).toBe(
        `{{output:token}} gave a string holding the secret placeholder {{secret:API_KEY}}. ${PLACEHOLDER_NOTE}`
      );
    });

    it("rejects an object with a placeholder nested in a value, naming its path", () => {
      const document = { req: { headers: { auth: "Bearer {{secret:API_KEY}}" } } };
      expect(reject("{{output:req}}", "arg", document)).toBe(
        "{{output:req}} gave an object holding the secret placeholder {{secret:API_KEY}} at " +
          `\`.headers.auth\`. ${PLACEHOLDER_NOTE}`
      );
    });

    it("rejects an array with a placeholder nested in it, naming its path", () => {
      const document = { list: ["ok", { value: "{{secret:TOKEN}}" }] };
      expect(reject("{{output:list}}", "arg", document)).toBe(
        "{{output:list}} gave an array holding the secret placeholder {{secret:TOKEN}} at " +
          `\`[1].value\`. ${PLACEHOLDER_NOTE}`
      );
    });

    it("spells a non-identifier key on the path with brackets", () => {
      const document = { req: { "x-auth": ["{{secret:TOKEN}}"] } };
      expect(reject("{{output:req}}", "arg", document)).toContain(
        'holding the secret placeholder {{secret:TOKEN}} at `["x-auth"][0]`'
      );
    });

    it("rejects a placeholder in a nested key", () => {
      const document = { req: { inner: { "{{secret:KEY}}": 1 } } };
      const reason = reject("{{output:req}}", "arg", document);
      expect(reason).toContain("gave an object holding the secret placeholder {{secret:KEY}}");
      expect(reason).toContain("`.inner`");
    });

    it("rejects a placeholder in a key of the value itself", () => {
      const document = { req: { "{{secret:KEY}}": 1 } };
      expect(reject("{{output:req}}", "arg", document)).toContain(
        "gave an object holding the secret placeholder {{secret:KEY}}"
      );
    });

    it("accepts an object whose strings only nearly spell a placeholder", () => {
      const document = {
        req: { a: "{{secret:bad-name}}", b: "{{ secret:KEY }}", c: "{{secret:}}" },
      };
      expect(resolve("{{output:req}}", "arg", document).value).toEqual(document.req);
    });
  });
});

// ── describeUnsafeIntegers ────────────────────────────────────────────

describe("describeUnsafeIntegers", () => {
  it("warns about an integer JSON.parse rounded", () => {
    const returned = JSON.parse('{"order":{"id":12345678901234567891}}') as OutputDocument;
    expect(describeUnsafeIntegers({}, returned)).toBe(
      `output.order.id is 12345678901234567000, ${UNSAFE_NOTE}`
    );
  });

  it("does not warn about the largest safe integer, or a non-integer", () => {
    expect(
      describeUnsafeIntegers({}, { max: 9007199254740991, min: -9007199254740991, half: 1.5 })
    ).toBeUndefined();
  });

  it("warns about the first integer past the safe range", () => {
    expect(describeUnsafeIntegers({}, { n: 2 ** 53 })).toBe(
      `output.n is 9007199254740992, ${UNSAFE_NOTE}`
    );
    expect(describeUnsafeIntegers({}, { n: -(2 ** 60) })).toBe(
      `output.n is -1152921504606847000, ${UNSAFE_NOTE}`
    );
  });

  // A script is handed the whole document and hands it back, so a value an
  // earlier step rounded comes back identical and is not this step's to report.
  it("does not warn about a value unchanged from the given document", () => {
    const text = '{"order":{"id":12345678901234567891},"ids":[12345678901234567891]}';
    const given = JSON.parse(text) as OutputDocument;
    const returned = JSON.parse(text) as OutputDocument;
    expect(describeUnsafeIntegers(given, returned)).toBeUndefined();
  });

  it("warns when the given document held a different value at that path", () => {
    expect(describeUnsafeIntegers({ id: 2 ** 61 }, { id: 2 ** 60 })).toBe(
      `output.id is 1152921504606847000, ${UNSAFE_NOTE}`
    );
    expect(describeUnsafeIntegers({ id: "1152921504606847000" }, { id: 2 ** 60 })).toBe(
      `output.id is 1152921504606847000, ${UNSAFE_NOTE}`
    );
    // The same number at another path is not the same value.
    expect(describeUnsafeIntegers({ old: 2 ** 60 }, { new: 2 ** 60 })).toBe(
      `output.new is 1152921504606847000, ${UNSAFE_NOTE}`
    );
  });

  it("reports only the paths that changed", () => {
    expect(
      describeUnsafeIntegers(
        { a: 2 ** 60, ids: [2 ** 60] },
        { a: 2 ** 60, ids: [2 ** 60, 2 ** 61] }
      )
    ).toBe(`output.ids[1] is 2305843009213694000, ${UNSAFE_NOTE}`);
  });

  it("names the first path in document order and counts the others", () => {
    const returned = { z: { b: 2 ** 60 }, c: [1, 2 ** 61], a: 2 ** 62 };
    expect(describeUnsafeIntegers({}, returned)).toBe(
      `output.z.b is 1152921504606847000, ${UNSAFE_NOTE} 2 more paths hold an integer past ` +
        "that limit."
    );
  });

  it("says `1 more path holds` for a single other path", () => {
    expect(describeUnsafeIntegers({}, { list: [2 ** 61, 2 ** 60] })).toBe(
      `output.list[0] is 2305843009213694000, ${UNSAFE_NOTE} 1 more path holds an integer past ` +
        "that limit."
    );
  });

  it("spells a key that is not an identifier with brackets", () => {
    expect(describeUnsafeIntegers({}, { "order-id": 2 ** 60 })).toBe(
      `output["order-id"] is 1152921504606847000, ${UNSAFE_NOTE}`
    );
    expect(describeUnsafeIntegers({}, { items: [0, { "x y": 2 ** 60 }] })).toBe(
      `output.items[1]["x y"] is 1152921504606847000, ${UNSAFE_NOTE}`
    );
  });
});

// ── depth ─────────────────────────────────────────────────────────────

describe("flow-output — a document nested 4,096 levels deep", () => {
  // renderOutputPath cuts a path over 200 characters; "output" plus 4,096
  // ".a" is 8,198 characters, so 7,998 are dropped.
  const DEEP_PATH = `${("output" + ".a".repeat(MAX_DOCUMENT_DEPTH)).slice(0, 200)}…(+7998 chars)`;

  it("warns about an unsafe integer at the deepest level without overflowing", () => {
    const returned = nested(MAX_DOCUMENT_DEPTH, "12345678901234567891") as OutputDocument;
    expect(describeUnsafeIntegers({}, returned)).toBe(
      `${DEEP_PATH} is 12345678901234567000, ${UNSAFE_NOTE}`
    );
  });

  it("walks a deep unchanged document without warning", () => {
    const text = "12345678901234567891";
    const given = nested(MAX_DOCUMENT_DEPTH, text) as OutputDocument;
    const returned = nested(MAX_DOCUMENT_DEPTH, text) as OutputDocument;
    expect(describeUnsafeIntegers(given, returned)).toBeUndefined();
  });

  it("warns about an unsafe integer at the bottom of deeply nested arrays", () => {
    const returned = {
      a: nested(MAX_DOCUMENT_DEPTH - 1, "12345678901234567891", "[", "]"),
    } as OutputDocument;
    expect(describeUnsafeIntegers({}, returned)).toContain(
      `is 12345678901234567000, ${UNSAFE_NOTE}`
    );
  });

  it("rejects a whole-field arg object with a placeholder at the deepest level", () => {
    const document = { deep: nested(MAX_DOCUMENT_DEPTH, '"{{secret:X}}"') };
    expect(reject("{{output:deep}}", "arg", document)).toBe(
      "{{output:deep}} gave an object holding the secret placeholder {{secret:X}} at " +
        `\`${".a".repeat(97)}…(+7998 chars)\`. ${PLACEHOLDER_NOTE}`
    );
  });

  it("rejects a whole-field arg array with a placeholder at the deepest level", () => {
    const document = { deep: nested(MAX_DOCUMENT_DEPTH, '"{{secret:X}}"', "[", "]") };
    expect(reject("{{output:deep}}", "arg", document)).toContain(
      "{{output:deep}} gave an array holding the secret placeholder {{secret:X}} at `[0][0]"
    );
  });

  it("prints a deep object in an echo", () => {
    // The root is level 1, so `a` holds the other 4,095.
    const document = nested(MAX_DOCUMENT_DEPTH, "1") as OutputDocument;
    const inner = MAX_DOCUMENT_DEPTH - 1;
    const json = '{"a":'.repeat(inner) + "1" + "}".repeat(inner);
    expect(resolve("{{output:a}}", "echo", document).value).toBe(json);
  });

  // A whole-field `arg` reference hands the tool a copy. `structuredClone`, the
  // obvious copy, is recursive in V8 and threw "Maximum call stack size
  // exceeded" well below the 4,096 levels a script may return (at 1,817 levels
  // on Node 20.20, 2,386 on 26.7), so the copy must be iterative.
  it("copies a whole-field arg object nested as deep as a script may return", () => {
    const document = nested(MAX_DOCUMENT_DEPTH, "1") as OutputDocument;
    let resolution: ReturnType<typeof resolveOutputField> | undefined;
    expect(() => {
      resolution = resolveOutputField("{{output:a}}", "arg", document);
    }).not.toThrow();
    expect(resolution?.ok).toBe(true);
    if (!resolution?.ok) return;
    // An identity check rather than `.not.toBe`: when the two differ, vitest
    // computes a recursive deep-equality hint that overflows Node 20's stack here.
    expect(resolution.value === document.a).toBe(false);
    expect(depthOf(resolution.value)).toEqual({ depth: MAX_DOCUMENT_DEPTH - 1, leaf: 1 });
  });
});

describe("flow-output — a value a script set to null", () => {
  it("advises a ?? fallback when a reference with none meets a null value", () => {
    const document = { user: { promo: null } } as OutputDocument;
    const resolution = resolveOutputField("{{output:user.promo}}", "typed", document);
    expect(resolution).toEqual({
      ok: false,
      reason:
        "{{output:user.promo}} did not resolve: `output.user.promo` is null; add a `??` fallback if the value can be null",
    });
  });

  it("gives no fallback advice to a reference that already has one, or to a missing key", () => {
    const document = { user: { promo: null } } as OutputDocument;
    const withFallback = resolveOutputField("{{output:user.promo ?? other}}", "typed", document);
    expect(withFallback.ok).toBe(false);
    if (!withFallback.ok) expect(withFallback.reason).not.toContain("add a `??` fallback");
    const missing = resolveOutputField("{{output:user.code}}", "typed", document);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).not.toContain("add a `??` fallback");
  });
});

describe("flow-output — keys a script wrote", () => {
  it("lists a key holding a line break in its escaped spelling, so the reason stays one line", () => {
    const document = { user: 1, ['x\n  ✓  7 tap "Pay"']: 2 } as OutputDocument;
    const resolution = resolveOutputField("{{output:missing}}", "echo", document);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).not.toContain("\n");
    expect(resolution.reason).toContain('(its keys: user, ["x\\n  ✓  7 tap \\"Pay\\""])');
  });
});

describe("sameJsonValue", () => {
  it("ignores key order and nothing else", () => {
    expect(
      sameJsonValue(
        { b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } },
        { a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }
      )
    ).toBe(true);
    expect(sameJsonValue([1, 2], [2, 1])).toBe(false);
    expect(sameJsonValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJsonValue({ a: 1 }, { b: 1 })).toBe(false);
    expect(sameJsonValue({ a: "1" }, { a: 1 })).toBe(false);
    expect(sameJsonValue({ a: [] }, { a: {} })).toBe(false);
    expect(sameJsonValue(null, {})).toBe(false);
  });

  it("compares documents 4,096 levels deep without recursion", () => {
    const left = JSON.parse('{"a":'.repeat(4096) + "1" + "}".repeat(4096)) as unknown;
    const same = JSON.parse('{"a":'.repeat(4096) + "1" + "}".repeat(4096)) as unknown;
    const other = JSON.parse('{"a":'.repeat(4096) + "2" + "}".repeat(4096)) as unknown;
    expect(sameJsonValue(left, same)).toBe(true);
    expect(sameJsonValue(left, other)).toBe(false);
  });
});

// ── small exports ─────────────────────────────────────────────────────

describe("renderOutputPath", () => {
  it("spells identifier keys with dots, other keys with brackets and indexes in brackets", () => {
    expect(renderOutputPath([])).toBe("output");
    expect(renderOutputPath(["user", 0, "order-id", "_ok1", "1abc", ""])).toBe(
      'output.user[0]["order-id"]._ok1["1abc"][""]'
    );
  });
});

describe("describeJsonType", () => {
  it.each([
    [null, "null"],
    [[], "an array"],
    [{}, "an object"],
    ["", "a string"],
    [0, "a number"],
    [false, "a boolean"],
  ])("describes %j as %s", (value, description) => {
    expect(describeJsonType(value)).toBe(description);
  });
});

describe("renderedValue", () => {
  it("keeps a value of up to 200 characters and cuts a longer one", () => {
    expect(renderedValue("x".repeat(200))).toBe("x".repeat(200));
    expect(renderedValue("x".repeat(201))).toBe(`${"x".repeat(200)}…(+1 chars)`);
  });
});
