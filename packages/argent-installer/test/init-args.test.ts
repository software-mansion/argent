import { describe, it, expect } from "vitest";
import { parseInitArgs } from "../src/init-args.js";

describe("parseInitArgs", () => {
  it("parses the full known flag set", () => {
    const parsed = parseInitArgs(["--yes", "--no-telemetry", "--local", "--from", "./argent.tgz"]);
    expect(parsed.nonInteractive).toBe(true);
    expect(parsed.noTelemetry).toBe(true);
    expect(parsed.wantsLocal).toBe(true);
    expect(parsed.wantsGlobal).toBe(false);
    expect(parsed.fromTar).toBe("./argent.tgz");
    expect(parsed.unknownFlags).toEqual([]);
  });

  it("accepts -y and --global", () => {
    const parsed = parseInitArgs(["-y", "--global"]);
    expect(parsed.nonInteractive).toBe(true);
    expect(parsed.wantsGlobal).toBe(true);
    expect(parsed.unknownFlags).toEqual([]);
  });

  it("collects unknown flags instead of silently ignoring them", () => {
    // The failure this guards against: an old argent that predates a flag
    // (e.g. --local) ran a DIFFERENT setup than the user asked for.
    const parsed = parseInitArgs(["--locl", "--verbose", "-y"]);
    expect(parsed.unknownFlags).toEqual(["--locl", "--verbose"]);
    expect(parsed.nonInteractive).toBe(true);
  });

  it("does not treat the --from value as a flag, even when it starts with a dash", () => {
    const parsed = parseInitArgs(["--from", "-weird-dir/argent.tgz"]);
    expect(parsed.fromTar).toBe("-weird-dir/argent.tgz");
    expect(parsed.unknownFlags).toEqual([]);
  });

  it("accepts the --from=<path> spelling", () => {
    const parsed = parseInitArgs(["--from=./argent.tgz", "-y"]);
    expect(parsed.fromTar).toBe("./argent.tgz");
    expect(parsed.unknownFlags).toEqual([]);
  });

  it("flags a dangling --from instead of silently installing from the registry", () => {
    expect(parseInitArgs(["--local", "--from"]).unknownFlags).toEqual(["--from (missing value)"]);
    expect(parseInitArgs(["--from=", "-y"]).unknownFlags).toEqual(["--from (missing value)"]);
  });

  it("keeps the first --from when the flag is repeated (previous parser semantics)", () => {
    const parsed = parseInitArgs(["--from", "./pinned.tgz", "--from", "./other.tgz"]);
    expect(parsed.fromTar).toBe("./pinned.tgz");
    expect(parsed.unknownFlags).toEqual([]);
  });

  it("ignores positional (non-dash) tokens", () => {
    const parsed = parseInitArgs(["extra"]);
    expect(parsed.unknownFlags).toEqual([]);
  });
});
