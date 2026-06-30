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
});
