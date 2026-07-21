import { describe, it, expect, vi, beforeEach } from "vitest";

// `simctlSpawn` parses the CLI's stdout as one `{exit_code,stdout,stderr}` (or
// `{pid}`) JSON object. `sim-remote spawn` only emits that object when passed
// `--json`; without it a non-detached spawn streams the child's raw output live,
// which then fails `JSON.parse` ("Unexpected end of JSON input"). These tests
// pin `--json` onto every spawn argv so the regression that broke every
// ios-remote describe (via bootstrapAx's `defaults write`) can't come back.
const calls: Array<{ cmd: string; args: readonly string[] }> = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      _opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof _opts === "function" ? _opts : cb!;
      calls.push({ cmd, args });
      callback(null, { stdout: '{"exit_code":0,"pid":null,"stdout":"","stderr":""}', stderr: "" });
    },
  };
});

import { simctlSpawn } from "../src/utils/sim-remote";

beforeEach(() => {
  calls.length = 0;
});

describe("simctlSpawn --json", () => {
  it("passes --json for a non-detached in-simulator argv", async () => {
    await simctlSpawn("remote:ABCD1234", { args: ["defaults", "write", "com.apple.Accessibility", "X"] });
    expect(calls).toHaveLength(1);
    const { cmd, args } = calls[0];
    expect(cmd).toBe("sim-remote");
    expect(args).toContain("--json");
    // `--json` must precede the `--` argv separator so it is parsed as an option.
    expect(args.indexOf("--json")).toBeLessThan(args.indexOf("--"));
    // Everything after `--` is the in-simulator argv, untouched.
    expect(args.slice(args.indexOf("--") + 1)).toEqual([
      "defaults",
      "write",
      "com.apple.Accessibility",
      "X",
    ]);
  });

  it("passes --json alongside --bin and --detach for the ax-service daemon spawn", async () => {
    await simctlSpawn("remote:ABCD1234", {
      binPath: "/path/to/tcp/ax-service",
      args: ["--port", "5000", "--timeout", "3600"],
      detach: true,
    });
    const { args } = calls[0];
    expect(args).toContain("--json");
    expect(args).toContain("--detach");
    expect(args).toContain("--bin");
  });
});
