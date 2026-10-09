import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import { ensureMetroReverse } from "../src/utils/adb";
import { setFlag } from "@argent/configuration-core";

let flagsDir: string;
let originalHome: string | undefined;
let originalCwd: string;
const originalPort = process.env.ARGENT_METRO_PORT;

beforeEach(() => {
  execFileMock.mockReset();
  // A flag resolves from the project scope first (`<project>/.argent`, walked up
  // from cwd) and the global scope second (`$HOME/.argent`). Both are redirected
  // into one temp dir, so neither the developer's own flags nor a flags file
  // committed anywhere above this checkout can decide these assertions — the
  // "reverse happened" cases fail if either scope carries disable-metro-reverse.
  flagsDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-metro-reverse-"));
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  process.env.HOME = flagsDir;
  process.chdir(flagsDir);
  delete process.env.ARGENT_METRO_PORT;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPort === undefined) delete process.env.ARGENT_METRO_PORT;
  else process.env.ARGENT_METRO_PORT = originalPort;
  fs.rmSync(flagsDir, { recursive: true, force: true });
});

describe("ensureMetroReverse", () => {
  it("reverses Metro's default port for the given serial", async () => {
    await expect(ensureMetroReverse("emulator-5554")).resolves.toBe(8081);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "-s",
      "emulator-5554",
      "reverse",
      "tcp:8081",
      "tcp:8081",
    ]);
  });

  it("honours ARGENT_METRO_PORT for a project running Metro elsewhere", async () => {
    process.env.ARGENT_METRO_PORT = "8082";
    await expect(ensureMetroReverse("emulator-5554")).resolves.toBe(8082);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      "-s",
      "emulator-5554",
      "reverse",
      "tcp:8082",
      "tcp:8082",
    ]);
  });

  it("falls back to 8081 rather than forwarding a nonsense port", async () => {
    for (const bad of ["not-a-port", "0", "70000", "-1"]) {
      execFileMock.mockReset();
      process.env.ARGENT_METRO_PORT = bad;
      await expect(ensureMetroReverse("emulator-5554")).resolves.toBe(8081);
      expect(execFileMock.mock.calls[0][1]).toContain("tcp:8081");
    }
  });

  // The caller is launching an app, and most launches are of apps that never
  // talk to Metro. A device that refuses the reverse must still launch.
  it("reports null instead of throwing when adb refuses", async () => {
    execFileMock.mockReturnValue(new Error("device offline"));
    await expect(ensureMetroReverse("emulator-5554")).resolves.toBeNull();
  });

  it("does nothing at all when disable-metro-reverse is set", async () => {
    setFlag("disable-metro-reverse", true, "global");
    await expect(ensureMetroReverse("emulator-5554")).resolves.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
