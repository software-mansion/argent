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
