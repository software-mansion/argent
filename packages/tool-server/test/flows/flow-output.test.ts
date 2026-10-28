import { describe, expect, it } from "vitest";
import {
  MAX_ECHO_MESSAGE_CHARS,
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
const MAX_DOCUMENT_DEPTH = 256;

const UNSAFE_NOTE =
  "past the largest integer a JSON number holds exactly (9007199254740991), so it may have " +
  "been rounded; write an identifier as a string.";

const PLACEHOLDER_NOTE =
  "A secret placeholder must be written in the e2e test file whole; a script cannot produce one";

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
  // [field, operands]: the field is one reference, its source what the braces hold.
  it.each<[field: string, operands: unknown[]]>([
    ["{{output:user.profile.name}}", [path("user", "profile", "name")]],
    ["{{output:grid[10][2].cell}}", [path("grid", 10, 2, "cell")]],
    ['{{output:order["order-id"]}}', [path("order", "order-id")]],
    ["{{output:order['order-id']}}", [path("order", "order-id")]],
    [String.raw`{{output:q['it\'s']}}`, [path("q", "it's")]],
    [String.raw`{{output:q["say \"hi\""]}}`, [path("q", 'say "hi"')]],
    [String.raw`{{output:q['back\\slash']}}`, [path("q", "back\\slash")]],
    // The escape copies the next character; it is not a JSON escape.
    [String.raw`{{output:x ?? 'a\nb'}}`, [path("x"), literal("anb")]],
    ["{{output:  user.id  ??  'x'  }}", [path("user", "id"), literal("x")]],
    ["{{output:\n\tuser.id\r\n??\t'x'\n}}", [path("user", "id"), literal("x")]],
    ["{{output:a.b ?? c.d ?? 'none'}}", [path("a", "b"), path("c", "d"), literal("none")]],
    ['{{output:flags["null"]}}', [path("flags", "null")]],
    // A literal word is a whole segment, not a prefix.
    ["{{output:x ?? nullable.trueish}}", [path("x"), path("nullable", "trueish")]],
  ])("reads %j", (field, operands) => {
    expect(parts(field)).toEqual([ref(field.slice(9, -2).trim(), ...operands)]);
  });

  it("splits several references and the text around them", () => {
    expect(parts("Hi {{output:user.name}}, #{{output:codes[1]}}!")).toEqual([
      { text: "Hi " },
      ref("user.name", path("user", "name")),
      { text: ", #" },
      ref("codes[1]", path("codes", 1)),
      { text: "!" },
    ]);
    expect(parts("{{output:a}}{{output:b}}")).toEqual([ref("a", path("a")), ref("b", path("b"))]);
    // The first `}}` ends the reference, inside a secret placeholder too.
    expect(parts("{{secret:{{output:name}}}}")).toEqual([
      { text: "{{secret:" },
      ref("name", path("name")),
      { text: "}}" },
    ]);
  });

  // [spelling, JSON value, how a text field writes it]; a text field refuses null.
  it.each([
    ["'single'", "single", "single"],
    ['"double"', "double", "double"],
    ["''", "", ""],
    ["42", 42, "42"],
    ["0", 0, "0"],
    ["-1.5e3", -1500, "-1500"],
    ["2.5E-2", 0.025, "0.025"],
    ["true", true, "true"],
    ["false", false, "false"],
    ["null", null, undefined],
  ] as const)("takes %s as a fallback literal", (spelled, value, text) => {
    expect(parts(`{{output:x ?? ${spelled}}}`)).toEqual([
      ref(`x ?? ${spelled}`, path("x"), literal(value)),
    ]);
    expect(resolve(`{{output:missing ?? ${spelled}}}`, "arg", {}).value).toBe(value);
    if (text !== undefined) {
      expect(resolve(`Value: {{output:missing ?? ${spelled}}}`, "text", {}).value).toBe(
        `Value: ${text}`
      );
    }
  });

  it.each(["{{ output:x }}", "{{Output:x}}", "{{OUTPUT:x}}", "{{output :x}}", "{output:x}"])(
    "leaves the near spelling %s as literal text",
    (field) => {
      expect(parts(field)).toEqual([{ text: field }]);
      expect(resolve(field, "text", { x: "resolved" })).toEqual({
        ok: true,
        value: field,
        references: [],
      });
    }
  );
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

  it.each([
    // A literal holding `}}` is cut at it.
    ["{{output:x ?? '}}'}}", "{{output:x ?? '}}"],
    // A reference that is never closed runs to the end of the field.
    ["Hi {{output:user.id}", "{{output:user.id}"],
    ["{{output:ok}} and {{output:bad ||}}", "{{output:bad ||}}"],
  ])("quotes only the reference %s stopped in", (field, reference) => {
    expect(syntaxError(field).reference).toBe(reference);
  });
});

// ── resolveOutputField: reading paths ─────────────────────────────────

describe("resolveOutputField — operands", () => {
  const document = {
    user: { id: 42, name: "Ada", rank: 3 },
    defaults: { region: "eu" },
    codes: [10, 20],
    flags: { null: "yes" },
    order: { "order-id": "A-1" },
  };

  it("reads a simple path, a nested path, an index and a quoted key", () => {
    expect(resolve("{{output:codes}}", "arg", document).value).toEqual([10, 20]);
    expect(resolve("{{output:user.name}}", "text", document).value).toBe("Ada");
    expect(resolve("{{output:codes[1]}}", "text", document).value).toBe("20");
    expect(resolve('{{output:order["order-id"]}}', "text", document).value).toBe("A-1");
    expect(resolve('{{output:flags["null"]}}', "text", document).value).toBe("yes");
  });

  it("takes the first operand that gives a value, left to right", () => {
    expect(resolve("{{output:user.name ?? defaults.region}}", "text", document).value).toBe("Ada");
    expect(resolve("{{output:user.region ?? other ?? 'unknown'}}", "text", document).value).toBe(
      "unknown"
    );
    expect(
      resolve("{{output:user.region ?? defaults.region ?? 'unknown'}}", "text", document)
    ).toEqual({
      ok: true,
      value: "eu",
      references: [{ source: "user.region ?? defaults.region ?? 'unknown'", value: "eu" }],
    });
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

  // [path, where it stopped]
  const MISSES: Array<[string, string]> = [
    ["user.promo", "`output.user` has no `promo` (its keys: id, name, rank)"],
    [
      "missing",
      "`output` has no `missing` (its keys: user, codes, single, none, nulls, flag, empty, " +
        "maybe, order)",
    ],
    ["user.id.value", "`output.user.id` is a number, so it has no `value`"],
    ["user.name[0]", "`output.user.name` is a string, so it has no `[0]`"],
    ["user.name.length", "`output.user.name` is a string, so it has no `length`"],
    ["codes.length", "`output.codes` is an array, so it has no `length`"],
    ["user.constructor", "`output.user` has no `constructor` (its keys: id, name, rank)"],
    ["user.__proto__", "`output.user` has no `__proto__` (its keys: id, name, rank)"],
    ["codes.first", "`output.codes` is an array, so it has no `first`"],
    ["user[0]", "`output.user` is an object, so it has no `[0]` (its keys: id, name, rank)"],
    ["codes[2]", "`output.codes` has 2 elements, so it has no `[2]`"],
    ["single[1]", "`output.single` has 1 element, so it has no `[1]`"],
    ["none[0]", "`output.none` has 0 elements, so it has no `[0]`"],
    ["maybe.x", "`output.maybe` is null, so it has no `x`"],
    ["maybe", "`output.maybe` is null; add a `??` fallback if the value can be null"],
    ["nulls[0]", "`output.nulls[0]` is null; add a `??` fallback if the value can be null"],
    ["empty.x", "`output.empty` has no `x` (it has no keys)"],
    ["empty[0]", "`output.empty` is an object, so it has no `[0]` (it has no keys)"],
    ['order["missing-id"]', '`output.order` has no `["missing-id"]` (its keys: ["order-id"])'],
    ['order["order-id"].x', '`output.order["order-id"]` is a number, so it has no `x`'],
  ];

  it.each(MISSES)("names where %s stopped", (spelled, miss) => {
    expect(reject(`{{output:${spelled}}}`, "text", document)).toBe(
      `{{output:${spelled}}} did not resolve: ${miss}`
    );
  });

  it.each(MISSES)("lets a fallback stand in for %s", (spelled) => {
    expect(resolve(`{{output:${spelled} ?? 'fallback'}}`, "text", document).value).toBe("fallback");
    expect(resolve(`{{output:${spelled} ?? user.name}}`, "text", document).value).toBe("Ada");
  });

  it("names every operand that gave no value, with no null advice once there is a fallback", () => {
    expect(reject("{{output:user.promo ?? codes[5] ?? flag.x}}", "text", document)).toBe(
      "{{output:user.promo ?? codes[5] ?? flag.x}} did not resolve: " +
        "`output.user` has no `promo` (its keys: id, name, rank); " +
        "`output.codes` has 2 elements, so it has no `[5]`; " +
        "`output.flag` is a boolean, so it has no `x`"
    );
    expect(reject("{{output:maybe ?? user.promo}}", "text", document)).toBe(
      "{{output:maybe ?? user.promo}} did not resolve: `output.maybe` is null; " +
        "`output.user` has no `promo` (its keys: id, name, rank)"
    );
  });

  it.each([
    [25, ", and 5 more"],
    [20, ""],
  ])("lists at most 20 of an object's %i keys", (count, more) => {
    const many = Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, i]));
    const listed = Array.from({ length: 20 }, (_, i) => `k${i}`).join(", ");
    expect(reject("{{output:many.missing}}", "text", { many })).toBe(
      `{{output:many.missing}} did not resolve: \`output.many\` has no \`missing\` ` +
        `(its keys: ${listed}${more})`
    );
  });

  // A key a script wrote can hold a line break, and a reason is one line.
  it("lists a key holding a line break in its escaped spelling", () => {
    const reason = reject("{{output:missing}}", "echo", { user: 1, ['x\n  ✓  7 tap "Pay"']: 2 });
    expect(reason).not.toContain("\n");
    expect(reason).toContain('(its keys: user, ["x\\n  ✓  7 tap \\"Pay\\""])');
  });

  it.each([
    ["0", 0, "0"],
    ["false", false, "false"],
    ['""', "", ""],
  ] as const)("takes %s as a value, not as missing", (_label, value, text) => {
    const doc = { value };
    expect(resolve("{{output:value ?? 'fallback'}}", "arg", doc)).toEqual({
      ok: true,
      value,
      references: [{ source: "value ?? 'fallback'", value }],
      ...(typeof value === "string" ? {} : { wholeFieldType: describeJsonType(value) }),
    });
    expect(resolve("[{{output:value ?? 'fallback'}}]", "typed", doc).value).toBe(`[${text}]`);
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
  it("writes a string, a number the way JSON.stringify does, and a boolean as text", () => {
    for (const [field, text] of [
      ["{{output:name}}", "Ada"],
      ["{{output:n}}", "42"],
      ["{{output:half}}", "-0.5"],
      ["{{output:huge}}", "1e+21"],
      ["{{output:negativeZero}}", "0"],
      ["id-{{output:n}}", "id-42"],
      ["{{output:yes}}", "true"],
      ["{{output:no}}", "false"],
    ] as const) {
      expect(resolve(field, kind, TYPED_DOCUMENT).value).toBe(text);
    }
    // Text even when the field is exactly one reference.
    expect(resolve("{{output:n}}", kind, TYPED_DOCUMENT)).toEqual({
      ok: true,
      value: "42",
      references: [{ source: "n", value: 42 }],
    });
  });

  it("rejects an object, an array and null", () => {
    const needsText =
      "and this field needs text; reference a string, a number or a boolean inside it";
    expect(reject("{{output:user}}", kind, TYPED_DOCUMENT)).toBe(
      `{{output:user}} gave an object, ${needsText}`
    );
    expect(reject("tags: {{output:user.tags}}", kind, TYPED_DOCUMENT)).toBe(
      `{{output:user.tags}} gave an array, ${needsText}`
    );
    expect(reject("{{output:maybe ?? null}}", kind, TYPED_DOCUMENT)).toBe(
      "{{output:maybe ?? null}} gave null, and this field needs text; end the `??` chain with a " +
        "text literal, such as 'none'"
    );
  });
});

describe("resolveOutputField — values in an arg field", () => {
  it.each([
    ["a number", "{{output:n}}", 42, "a number"],
    ["a boolean", "{{output:no}}", false, "a boolean"],
    ["null through a trailing `?? null`", "{{output:maybe ?? null}}", null, "null"],
    ["whitespace inside its braces", "{{output:  n  }}", 42, "a number"],
    ["a string from the document", "{{output:name}}", "Ada", undefined],
    ["a string literal", "{{output:missing ?? 'x'}}", "x", undefined],
  ])("keeps the JSON type of a whole-field reference to %s", (_label, field, value, type) => {
    const result = resolve(field, "arg", TYPED_DOCUMENT);
    expect(result.value).toBe(value);
    expect(result.wholeFieldType).toBe(type);
    expect("wholeFieldType" in result).toBe(type !== undefined);
  });

  it("keeps an object or an array as a deep copy", () => {
    const document = { request: { headers: { accept: "json" }, list: [1, { deep: "value" }] } };
    const object = resolve("{{output:request}}", "arg", document);
    expect(object.wholeFieldType).toBe("an object");
    expect(object.value).toEqual(document.request);
    const copy = object.value as { headers: { accept: string }; list: [number, { deep: string }] };
    copy.headers.accept = "changed";
    copy.list[1].deep = "changed";
    copy.list.push(3);
    expect(document.request).toEqual({ headers: { accept: "json" }, list: [1, { deep: "value" }] });

    const array = resolve("{{output:request.list}}", "arg", document);
    expect(array.wholeFieldType).toBe("an array");
    (array.value as unknown[]).push(4);
    expect(document.request.list).toHaveLength(2);
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

  it("rejects an object embedded in other text", () => {
    expect(reject("x{{output:user}}", "arg", TYPED_DOCUMENT)).toContain(
      "{{output:user}} gave an object, and this field needs text"
    );
  });
});

describe("resolveOutputField — values in an echo", () => {
  it("prints an object, an array and null as compact JSON, and a number as text", () => {
    expect(resolve("{{output:user}}", "echo", TYPED_DOCUMENT).value).toBe(
      '{"id":42,"name":"Ada","tags":["a","b"]}'
    );
    expect(resolve("codes: {{output:codes}}", "echo", TYPED_DOCUMENT).value).toBe("codes: [10,20]");
    expect(resolve("{{output:maybe ?? null}}", "echo", TYPED_DOCUMENT).value).toBe("null");
    const number = resolve("{{output:n}}", "echo", TYPED_DOCUMENT);
    expect(number.value).toBe("42");
    expect("wholeFieldType" in number).toBe(false);
  });

  it("cuts a message past 64 KiB, counting what it dropped and never splitting a surrogate pair", () => {
    const echo = (big: unknown, field = "{{output:big}}") =>
      resolve(field, "echo", { big }).value as string;
    const a = (n: number) => "a".repeat(n);
    expect(MAX_ECHO_MESSAGE_CHARS).toBe(65_536);
    expect(echo(a(65_536))).toBe(a(65_536));
    expect(echo(a(65_537))).toBe(`${a(65_536)}…(+1 chars)`);
    // "log: " (5) + 70,000 = 70,005 characters; 70,005 - 65,536 = 4,469 dropped.
    expect(echo(a(70_000), "log: {{output:big}}")).toBe(`log: ${a(65_531)}…(+4469 chars)`);
    const list = Array.from({ length: 20_000 }, () => "abcd");
    const json = JSON.stringify(list);
    expect(echo(list)).toBe(`${json.slice(0, 65_536)}…(+${json.length - 65_536} chars)`);
    // A pair at indexes 65,535 and 65,536 straddles the cut; one that ends at it is kept.
    const straddling = echo(`${a(65_535)}\u{1F600}b`);
    expect(straddling).toBe(`${a(65_535)}…(+3 chars)`);
    expect(LONE_SURROGATE.test(straddling)).toBe(false);
    expect(echo(`${a(65_534)}\u{1F600}bc`)).toBe(`${a(65_534)}\u{1F600}…(+2 chars)`);
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
    nul: "a\u0000b",
    highSurrogate: "x\uD800y",
    lowSurrogate: "\uDC00",
    pair: "\u{1F600}",
  };

  it.each([
    ["text", "selector text must contain at least one visible character"],
    ["identifier", "a selector identifier cannot be empty"],
    ["role", "a selector role cannot be empty"],
    ["expected", "expected text cannot be empty"],
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

  // Not only `?? ''`: a value of zero-width characters is no visible text either.
  it("rejects a text selector that resolves to no visible character", () => {
    expect(reject("{{output:zeroWidth}}", "text", document)).toContain(
      "selector text must contain at least one visible character"
    );
  });

  it("rejects a NUL character or a lone surrogate in an env value, and takes a whole pair", () => {
    expect(reject("pre-{{output:nul}}", "env", document)).toBe(
      `"pre-{{output:nul}}" resolved to "pre-a\\u0000b", and the value holds a NUL character, ` +
        "which an environment cannot carry"
    );
    for (const key of ["highSurrogate", "lowSurrogate"]) {
      expect(reject(`{{output:${key}}}`, "env", document)).toContain(
        "the value holds an unpaired surrogate, which an environment cannot carry"
      );
    }
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
  const spelled = (field: string) =>
    `${JSON.stringify(field)} would spell the secret placeholder {{secret:API_KEY}} with text ` +
    "from the output document. A secret placeholder must be written in the e2e test file whole";

  const SPELLED: Array<[label: string, field: string, document: OutputDocument]> = [
    [
      "two values between them",
      "{{output:first}}{{output:last}}",
      { first: "{{secre", last: "t:API_KEY}}" },
    ],
    ["a literal `{` before a reference", "{{{output:x}}", { x: "{secret:API_KEY}}" }],
    ["a value closing it with its last `}`", "{{secret:API_KEY}{{output:brace}}", { brace: "}" }],
    // The first `}}` ends the reference, so the document picks the secret's name.
    ["a name the document picks", "{{secret:{{output:name}}}}", { name: "API_KEY" }],
    [
      "a value holding one beside other text",
      "Bearer {{output:token}}",
      { token: "{{secret:API_KEY}}" },
    ],
    [
      "a value holding one inside its text",
      "Bearer {{output:token}}",
      { token: "a {{secret:API_KEY}} b" },
    ],
  ];

  describe.each(GUARDED_KINDS)("in a %s field", (kind) => {
    it.each(SPELLED)("rejects a placeholder spelled by %s", (_label, field, document) => {
      expect(reject(field, kind, document)).toBe(spelled(field));
    });

    it("keeps a placeholder the author wrote, beside a reference or around an empty value", () => {
      const user = { id: 42 };
      expect(
        resolve("Bearer {{secret:API_KEY}} for {{output:user.id}}", kind, { user }).value
      ).toBe("Bearer {{secret:API_KEY}} for 42");
      expect(resolve("{{secret:API_KEY}}{{output:user.id}}", kind, { user }).value).toBe(
        "{{secret:API_KEY}}42"
      );
      // An empty value contributes no character, so the whole name is the author's.
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

  it.each(SPELLED)(
    "prints what an echo reads, the placeholder spelled by %s included",
    (_label, field, document) => {
      expect(resolve(field, "echo", document).value).toContain("{{secret:API_KEY}}");
    }
  );

  // A name the placeholder grammar refuses spells no placeholder.
  it("leaves a document-picked name that is not a placeholder name as text", () => {
    expect(resolve("{{secret:{{output:name}}}}", "typed", { name: "API-KEY" }).value).toBe(
      "{{secret:API-KEY}}"
    );
  });

  it.each<[label: string, value: unknown, placeholder: string, at: string]>([
    ["a string holding one", "{{secret:API_KEY}}", "{{secret:API_KEY}}", ""],
    [
      "an object with one in a nested value",
      { headers: { auth: "Bearer {{secret:API_KEY}}" } },
      "{{secret:API_KEY}}",
      ".headers.auth",
    ],
    [
      "an array with one nested in it",
      ["ok", { value: "{{secret:TOKEN}}" }],
      "{{secret:TOKEN}}",
      "[1].value",
    ],
    [
      "one under a key that is not a name",
      { "x-auth": ["{{secret:TOKEN}}"] },
      "{{secret:TOKEN}}",
      '["x-auth"][0]',
    ],
    ["one in a nested key", { inner: { "{{secret:KEY}}": 1 } }, "{{secret:KEY}}", ".inner"],
    ["one in a key of the value itself", { "{{secret:KEY}}": 1 }, "{{secret:KEY}}", ""],
  ])(
    "rejects a whole-field arg reference to %s, naming its path",
    (_label, value, placeholder, at) => {
      expect(reject("{{output:v}}", "arg", { v: value })).toBe(
        `{{output:v}} gave ${describeJsonType(value)} holding the secret placeholder ${placeholder}` +
          `${at ? ` at \`${at}\`` : ""}. ${PLACEHOLDER_NOTE}`
      );
    }
  );

  it("accepts a whole-field arg object whose strings only nearly spell a placeholder", () => {
    const req = { a: "{{secret:bad-name}}", b: "{{ secret:KEY }}", c: "{{secret:}}" };
    expect(resolve("{{output:req}}", "arg", { req }).value).toEqual(req);
  });
});

// ── describeUnsafeIntegers ────────────────────────────────────────────

describe("describeUnsafeIntegers", () => {
  const warns = (path: string, value: string, more = "") =>
    `${path} is ${value}, ${UNSAFE_NOTE}${more}`;
  const BIG = "1152921504606847000"; // 2 ** 60
  const BIGGER = "2305843009213694000"; // 2 ** 61

  it("warns about an integer past the safe range, and not about a safe one", () => {
    const rounded = JSON.parse('{"order":{"id":12345678901234567891}}') as OutputDocument;
    expect(describeUnsafeIntegers({}, rounded)).toBe(
      warns("output.order.id", "12345678901234567000")
    );
    expect(describeUnsafeIntegers({}, { n: 2 ** 53 })).toBe(warns("output.n", "9007199254740992"));
    expect(describeUnsafeIntegers({}, { n: -(2 ** 60) })).toBe(warns("output.n", `-${BIG}`));
    expect(
      describeUnsafeIntegers({}, { max: 9007199254740991, min: -9007199254740991, half: 1.5 })
    ).toBeUndefined();
  });

  // A script hands back the whole document, so a value an earlier step rounded
  // comes back identical and is not this step's to report.
  it("warns only about a value this step changed", () => {
    const text = '{"order":{"id":12345678901234567891},"ids":[12345678901234567891]}';
    expect(describeUnsafeIntegers(JSON.parse(text), JSON.parse(text))).toBeUndefined();
    expect(describeUnsafeIntegers({ id: 2 ** 61 }, { id: 2 ** 60 })).toBe(warns("output.id", BIG));
    expect(describeUnsafeIntegers({ id: BIG }, { id: 2 ** 60 })).toBe(warns("output.id", BIG));
    expect(describeUnsafeIntegers({ old: 2 ** 60 }, { new: 2 ** 60 })).toBe(
      warns("output.new", BIG)
    );
    expect(
      describeUnsafeIntegers(
        { a: 2 ** 60, ids: [2 ** 60] },
        { a: 2 ** 60, ids: [2 ** 60, 2 ** 61] }
      )
    ).toBe(warns("output.ids[1]", BIGGER));
  });

  it("names the first path in document order, counts the others, and brackets a non-name key", () => {
    expect(describeUnsafeIntegers({}, { z: { b: 2 ** 60 }, c: [1, 2 ** 61], a: 2 ** 62 })).toBe(
      warns("output.z.b", BIG, " 2 more paths hold an integer past that limit.")
    );
    expect(describeUnsafeIntegers({}, { list: [2 ** 61, 2 ** 60] })).toBe(
      warns("output.list[0]", BIGGER, " 1 more path holds an integer past that limit.")
    );
    expect(describeUnsafeIntegers({}, { "order-id": 2 ** 60 })).toBe(
      warns('output["order-id"]', BIG)
    );
    expect(describeUnsafeIntegers({}, { items: [0, { "x y": 2 ** 60 }] })).toBe(
      warns('output.items[1]["x y"]', BIG)
    );
  });
});

// ── depth ─────────────────────────────────────────────────────────────

describe("flow-output — a document nested 256 levels deep", () => {
  it("warns about an unsafe integer at the deepest level without overflowing", () => {
    const returned = nested(MAX_DOCUMENT_DEPTH, "12345678901234567891") as OutputDocument;
    // "output" plus 256 ".a" is 518 characters; a path is cut at 200.
    expect(describeUnsafeIntegers({}, returned)).toBe(
      `${("output" + ".a".repeat(MAX_DOCUMENT_DEPTH)).slice(0, 200)}…(+318 chars) is ` +
        `12345678901234567000, ${UNSAFE_NOTE}`
    );
  });

  it("rejects a whole-field arg object with a placeholder at the deepest level", () => {
    const document = { deep: nested(MAX_DOCUMENT_DEPTH, '"{{secret:X}}"') };
    expect(reject("{{output:deep}}", "arg", document)).toBe(
      "{{output:deep}} gave an object holding the secret placeholder {{secret:X}} at " +
        `\`${".a".repeat(97)}…(+318 chars)\`. ${PLACEHOLDER_NOTE}`
    );
  });

  it("prints a deep object in an echo", () => {
    // The root is level 1, so `a` holds the other 255.
    const inner = MAX_DOCUMENT_DEPTH - 1;
    expect(
      resolve("{{output:a}}", "echo", nested(MAX_DOCUMENT_DEPTH, "1") as OutputDocument).value
    ).toBe('{"a":'.repeat(inner) + "1" + "}".repeat(inner));
  });

  // `structuredClone` is recursive in V8.
  it("copies a whole-field arg object nested as deep as a script may return", () => {
    const document = nested(MAX_DOCUMENT_DEPTH, "1") as OutputDocument;
    const resolution = resolveOutputField("{{output:a}}", "arg", document);
    if (!resolution.ok) throw new Error(resolution.reason);
    // An identity check: on a mismatch vitest's deep-equality hint overflows Node 20's stack.
    expect(resolution.value === document.a).toBe(false);
    expect(depthOf(resolution.value)).toEqual({ depth: MAX_DOCUMENT_DEPTH - 1, leaf: 1 });
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

  it("compares documents 256 levels deep without recursion", () => {
    const left = nested(MAX_DOCUMENT_DEPTH, "1");
    expect(sameJsonValue(left, nested(MAX_DOCUMENT_DEPTH, "1"))).toBe(true);
    expect(sameJsonValue(left, nested(MAX_DOCUMENT_DEPTH, "2"))).toBe(false);
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
