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
  });

  it("rejects the reverse order too, instead of silently discarding --tags-json", () => {
    // --tags-json first, then a plain --tags: the plain flag used to hit the
    // "first occurrence" branch and silently overwrite the JSON-parsed value
    // with no error at all.
    expect(() =>
      parseFlags(["--tags-json", '["a","b"]', "--tags", "c"], arrSchema)
    ).toThrow(FlagParseException);
  });

  it("rejects --tags-json arriving after a plain --tags, instead of silently overwriting it", () => {
    expect(() =>
      parseFlags(["--tags", "a", "--tags-json", '["b","c"]'], arrSchema)
    ).toThrow(FlagParseException);
  });

  it("still allows repeated plain --tags with no -json involved", () => {
    expect(parseFlags(["--tags", "a", "--tags", "b"], arrSchema).args.tags).toEqual(["a", "b"]);
  });

  it("still allows a bare --tags-json with no plain --tags involved", () => {
    expect(parseFlags(["--tags-json", '["a","b"]'], arrSchema).args.tags).toEqual(["a", "b"]);
  });
});
