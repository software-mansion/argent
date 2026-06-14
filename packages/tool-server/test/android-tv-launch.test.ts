import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { resolveLauncherActivity } from "../src/tools/launch-app/platforms/android";

// Returns the shell command string of an `adb -s <serial> shell <cmd>` call.
function shellCmd(args: string[]): string {
  return args[0] === "-s" && args[2] === "shell" ? (args[3] ?? "") : "";
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("resolveLauncherActivity — leanback (Android TV)", () => {
  it("resolves the LEANBACK_LAUNCHER activity first on TV targets", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = shellCmd(args);
      if (shell.includes("LEANBACK_LAUNCHER") && shell.includes("com.example.tv")) {
        return { stdout: "com.example.tv/com.example.tv.LeanbackActivity\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const component = await resolveLauncherActivity("emulator-5556", "com.example.tv", true);
    expect(component).toBe("com.example.tv/com.example.tv.LeanbackActivity");
    // The resolve query must have carried the leanback category.
    const calls = execFileMock.mock.calls.map((c) => shellCmd(c[1] as string[]));
    expect(calls.some((s) => s.includes("LEANBACK_LAUNCHER"))).toBe(true);
  });

  it("falls back to the standard LAUNCHER when no leanback activity exists", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = shellCmd(args);
      // No leanback match; a plain resolve (no category) returns the launcher.
      if (
        shell.startsWith("cmd package resolve-activity --brief ") &&
        !shell.includes("-c ") &&
        shell.includes("com.example.tv")
      ) {
        return { stdout: "com.example.tv/com.example.tv.MainActivity\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const component = await resolveLauncherActivity("emulator-5556", "com.example.tv", true);
    expect(component).toBe("com.example.tv/com.example.tv.MainActivity");
  });

  it("does NOT query leanback for a non-TV target", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = shellCmd(args);
      if (
        shell.startsWith("cmd package resolve-activity --brief ") &&
        !shell.includes("-c ")
      ) {
        return { stdout: "com.example.app/com.example.app.MainActivity\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const component = await resolveLauncherActivity("emulator-5554", "com.example.app", false);
    expect(component).toBe("com.example.app/com.example.app.MainActivity");
    const calls = execFileMock.mock.calls.map((c) => shellCmd(c[1] as string[]));
    expect(calls.some((s) => s.includes("LEANBACK_LAUNCHER"))).toBe(false);
  });

  it("throws a leanback-aware error when nothing resolves on a TV target", async () => {
    execFileMock.mockImplementation(() => ({ stdout: "", stderr: "" }));
    await expect(
      resolveLauncherActivity("emulator-5556", "com.example.tv", true)
    ).rejects.toThrow(/LEANBACK_LAUNCHER or LAUNCHER/);
  });
});
