import { describe, expect, it } from "vitest";
import { parseCommandArgs, UsageError, type OptionSpecs } from "../src/command-args.js";

const SPECS = {
  scope: { kind: "value", choices: ["global", "project"] },
  out: { kind: "value" },
  json: { kind: "boolean" },
} as const satisfies OptionSpecs;

describe("parseCommandArgs", () => {
  it("parses value options in both spellings, boolean flags and positionals", () => {
    expect(
      parseCommandArgs(["a", "--scope", "project", "--json", "b", "--out=x.txt"], SPECS)
    ).toEqual({ positionals: ["a", "b"], options: { scope: "project", json: true, out: "x.txt" } });
  });

  it("returns nothing set for an empty argv", () => {
    expect(parseCommandArgs([], SPECS)).toEqual({ positionals: [], options: {} });
  });

  it("last occurrence of a repeated option wins", () => {
    expect(parseCommandArgs(["--scope=global", "--scope", "project"], SPECS).options.scope).toBe(
      "project"
    );
  });

  it("treats everything after -- as positionals", () => {
    expect(parseCommandArgs(["--json", "--", "--scope", "x"], SPECS)).toEqual({
      positionals: ["--scope", "x"],
      options: { json: true },
    });
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCommandArgs(["--force"], SPECS)).toThrow(UsageError);
    expect(() => parseCommandArgs(["--force"], SPECS)).toThrow('Unknown flag "--force"');
  });

  it("rejects a value outside the declared choices, naming them", () => {
    expect(() => parseCommandArgs(["--scope", "team"], SPECS)).toThrow(
      '--scope must be one of "global", "project" (got "team")'
    );
  });

  it("rejects a missing value, and does not swallow a following flag as the value", () => {
    expect(() => parseCommandArgs(["--scope"], SPECS)).toThrow("--scope requires a value");
    expect(() => parseCommandArgs(["--scope", "--json"], SPECS)).toThrow(
      "--scope requires a value (global|project)"
    );
    expect(() => parseCommandArgs(["--out="], SPECS)).toThrow("--out requires a value");
  });

  it("rejects a value given to a boolean flag", () => {
    expect(() => parseCommandArgs(["--json=1"], SPECS)).toThrow("--json does not take a value");
  });
});
