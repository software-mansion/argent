import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeviceInfo } from "@argent/registry";

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

import { pinStatusBar, restoreStatusBar } from "../src/utils/status-bar";

const ANDROID_DEVICE: DeviceInfo = {
  id: "emulator-5554",
  platform: "android",
  kind: "emulator",
};

/** Shell payloads of every `adb -s <serial> shell <cmd>` call, in order. */
function shellCalls(): string[] {
  return execFileMock.mock.calls
    .filter(([cmd, args]) => cmd === "adb" && args[0] === "-s" && args[2] === "shell")
    .map(([, args]) => args[3] as string);
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("pinStatusBar (android)", () => {
  it("returns true when every demo-mode command succeeds", async () => {
    execFileMock.mockReturnValue({ stdout: "", stderr: "" });

    expect(await pinStatusBar(ANDROID_DEVICE)).toBe(true);
    expect(shellCalls().some((c) => c.includes("command exit"))).toBe(false);
  });

  it("sends the demo-mode exit broadcast when a command fails after enter", async () => {
    // Fail the clock broadcast — demo mode has already been entered by then,
    // so pinStatusBar must undo it rather than leave the device pinned with
    // no restore scheduled (the caller skips restoreStatusBar on false).
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = args[3] ?? "";
      if (shell.includes("command clock")) return new Error("adb: device offline");
      return { stdout: "", stderr: "" };
    });

    expect(await pinStatusBar(ANDROID_DEVICE)).toBe(false);
    expect(shellCalls().some((c) => c.includes("command exit"))).toBe(true);
    expect(shellCalls().some((c) => c.includes("sysui_demo_allowed 0"))).toBe(true);
  });

  it("reports pinned when the cleanup exit broadcast fails too, so the run-end restore fires", async () => {
    // Demo mode was entered and could not be exited (transient adb). Returning
    // false here would tell the caller nothing needs restoring, leaving the
    // frozen clock/battery applied after the run — so report `true` instead
    // and let the caller's teardown restore retry.
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = args[3] ?? "";
      if (shell.includes("command clock") || shell.includes("command exit"))
        return new Error("adb: device offline");
      return { stdout: "", stderr: "" };
    });

    await expect(pinStatusBar(ANDROID_DEVICE)).resolves.toBe(true);
  });
});

describe("restoreStatusBar (android)", () => {
  it("exits demo mode and resets sysui_demo_allowed", async () => {
    execFileMock.mockReturnValue({ stdout: "", stderr: "" });

    expect(await restoreStatusBar(ANDROID_DEVICE)).toBe(true);
    expect(shellCalls()).toEqual([
      "am broadcast -a com.android.systemui.demo -e command exit",
      "settings put global sysui_demo_allowed 0",
    ]);
  });

  it("still resets sysui_demo_allowed when the exit broadcast fails, and reports failure", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = args[3] ?? "";
      if (shell.includes("command exit")) return new Error("adb: device offline");
      return { stdout: "", stderr: "" };
    });

    expect(await restoreStatusBar(ANDROID_DEVICE)).toBe(false);
    expect(shellCalls().some((c) => c.includes("sysui_demo_allowed 0"))).toBe(true);
  });
});
