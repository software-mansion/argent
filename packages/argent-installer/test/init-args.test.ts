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
  });

  it("accepts -y and --global", () => {
    const parsed = parseInitArgs(["-y", "--global"]);
    expect(parsed.nonInteractive).toBe(true);
    expect(parsed.wantsGlobal).toBe(true);
  });

  it("silently ignores unknown flags (never breaks an existing invocation)", () => {
    const parsed = parseInitArgs(["--locl", "--verbose", "-y"]);
    expect(parsed.nonInteractive).toBe(true);
    expect(parsed.wantsLocal).toBe(false);
  });

  it("does not treat the --from value as a flag, even when it starts with a dash", () => {
    const parsed = parseInitArgs(["--from", "-weird-dir/argent.tgz"]);
    expect(parsed.fromTar).toBe("-weird-dir/argent.tgz");
  });

  it("accepts the --from=<path> spelling", () => {
    const parsed = parseInitArgs(["--from=./argent.tgz", "-y"]);
    expect(parsed.fromTar).toBe("./argent.tgz");
  });

  it("ignores a dangling --from (no value)", () => {
    expect(parseInitArgs(["--local", "--from"]).fromTar).toBeNull();
    expect(parseInitArgs(["--from=", "-y"]).fromTar).toBeNull();
  });

  it("keeps the first --from when the flag is repeated (previous parser semantics)", () => {
    const parsed = parseInitArgs(["--from", "./pinned.tgz", "--from", "./other.tgz"]);
    expect(parsed.fromTar).toBe("./pinned.tgz");
  });

  it("ignores positional (non-dash) tokens", () => {
    const parsed = parseInitArgs(["extra"]);
    expect(parsed.fromTar).toBeNull();
    expect(parsed.nonInteractive).toBe(false);
  });
});
