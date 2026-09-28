import { describe, expect, it } from "vitest";
import { parseCommandArgs, UsageError, type OptionSpecs } from "../src/command-args.js";

const SPECS = {
  scope: { kind: "value", choices: ["global", "project"] },
  out: { kind: "value", alias: "o" },
  json: { kind: "boolean" },
  yes: { kind: "boolean", alias: "y" },
} as const satisfies OptionSpecs;

describe("parseCommandArgs", () => {
  it("parses value options in both spellings, boolean flags and positionals", () => {
    expect(
      parseCommandArgs(["a", "--scope", "project", "--json", "b", "--out=x.txt"], SPECS)
    ).toEqual({
      positionals: ["a", "b"],
      options: { scope: "project", json: true, out: "x.txt" },
    });
  });

  it("accepts single-letter aliases for value and boolean options", () => {
    expect(parseCommandArgs(["-o", "x.txt", "-y"], SPECS)).toEqual({
      positionals: [],
      options: { out: "x.txt", yes: true },
    });
  });

  it("returns nothing set for an empty argv", () => {
    expect(parseCommandArgs([], SPECS)).toEqual({ positionals: [], options: {} });
  });

  it("last occurrence of a repeated option wins", () => {
    expect(parseCommandArgs(["--scope=global", "--scope", "project"], SPECS).options.scope).toBe(
      "project"
    );
  });

  it("treats everything after -- as positionals, and a bare - as a positional", () => {
    expect(parseCommandArgs(["--json", "--", "--scope", "-x"], SPECS)).toEqual({
      positionals: ["--scope", "-x"],
      options: { json: true },
    });
    expect(parseCommandArgs(["-", "--out", "-"], SPECS)).toEqual({
      positionals: ["-"],
      options: { out: "-" },
    });
  });

  it("rejects an unknown long or short flag, reporting the token as typed", () => {
    expect(() => parseCommandArgs(["--force"], SPECS)).toThrow(UsageError);
    expect(() => parseCommandArgs(["--force"], SPECS)).toThrow("Unknown flag: --force");
    expect(() => parseCommandArgs(["-z"], SPECS)).toThrow("Unknown flag: -z");
    expect(() => parseCommandArgs(["--platfrom=ios"], SPECS)).toThrow(
      "Unknown flag: --platfrom=ios"
    );
  });

  it("rejects a value outside the declared choices, listing them", () => {
    expect(() => parseCommandArgs(["--scope", "team"], SPECS)).toThrow(
      '--scope must be "global" or "project", got "team"'
    );
  });

  it("rejects a missing value, naming the long form even for an alias", () => {
    expect(() => parseCommandArgs(["--scope"], SPECS)).toThrow("--scope requires a value");
    expect(() => parseCommandArgs(["-o"], SPECS)).toThrow("--out requires a value");
    expect(() => parseCommandArgs(["--out="], SPECS)).toThrow("--out requires a value");
  });

  it("does not swallow a following flag as the value", () => {
    expect(() => parseCommandArgs(["--scope", "--json"], SPECS)).toThrow(
      "--scope requires a value"
    );
    expect(() => parseCommandArgs(["--out", "-y"], SPECS)).toThrow("--out requires a value");
  });

  it("passes an explicitly supplied empty token through as the value", () => {
    // The command validates it (e.g. link rejects "" as a bind address).
    expect(parseCommandArgs(["--out", ""], SPECS).options.out).toBe("");
  });

  it("rejects a value given to a boolean flag, including a trailing true/false word", () => {
    expect(() => parseCommandArgs(["--json=1"], SPECS)).toThrow("--json does not take a value");
    expect(() => parseCommandArgs(["--json", "false"], SPECS)).toThrow(
      "--json does not take a value — it is a switch"
    );
  });
});
