import { describe, it, expect, vi, beforeEach } from "vitest";

// The iOS branch shells out to `xcrun simctl ui … appearance`. Stub the
// subprocess so the tests assert the argv and the parsing without a booted
// simulator. `simctl ui <udid> appearance` with no value prints the current one.
const { simctlStdout } = vi.hoisted(() => ({ simctlStdout: { current: "light\n" } }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn(
    (_file: string, args: string[], _opts: unknown, cb: (e: null, out: unknown) => void) =>
      cb(null, { stdout: args.length === 4 ? simctlStdout.current : "", stderr: "" })
  ),
}));

// Device-set resolution reads config off disk; pin it so argv is deterministic.
vi.mock("../src/utils/ios-device-sets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device-sets")>()),
  simctlArgsForUdid: vi.fn(async (_udid: string, args: readonly string[]) => ["simctl", ...args]),
}));

// The Android branch runs `cmd uimode night` through the adb shell.
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell: vi.fn(async (_serial: string, command: string) => {
    const wanted = /night (yes|no)$/.exec(command)?.[1];
    return `Night mode: ${wanted ?? "no"}\n`;
  }),
}));

// `dispatchByPlatform` preflights each branch's `requires`; CI has neither
// xcrun nor adb, so treat both as present.
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
  ensureDeps: vi.fn(async () => {}),
}));

import { execFile } from "node:child_process";
import { setAppearanceTool } from "../src/tools/set-appearance";
import { parseNightMode } from "../src/tools/set-appearance/platforms/android";
import { adbShell } from "../src/utils/adb";

const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const androidEmulator = "emulator-5554";
const services = {} as never;

beforeEach(() => {
  vi.mocked(execFile).mockClear();
  vi.mocked(adbShell).mockClear();
  simctlStdout.current = "light\n";
});

describe("set-appearance — iOS", () => {
  it("reads the current appearance, then sets the new one with simctl ui", async () => {
    await expect(
      setAppearanceTool.execute(services, { udid: iosUdid, appearance: "dark" })
    ).resolves.toEqual({ appearance: "dark", previous: "light" });

    const calls = vi.mocked(execFile).mock.calls.map(([bin, args]) => [bin, args]);
    expect(calls).toEqual([
      ["xcrun", ["simctl", "ui", iosUdid, "appearance"]],
      ["xcrun", ["simctl", "ui", iosUdid, "appearance", "dark"]],
    ]);
  });

  it("fails on a runtime with no dark mode instead of reporting a switch that never happened", async () => {
    simctlStdout.current = "unsupported\n";
    await expect(
      setAppearanceTool.execute(services, { udid: iosUdid, appearance: "dark" })
    ).rejects.toThrow(/needs iOS 13 or later/);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("points a shut-down simulator at boot-device", async () => {
    vi.mocked(execFile).mockImplementationOnce(((
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (e: Error | null) => void
    ) =>
      cb(
        new Error(
          "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to lookup in current state: Shutdown"
        )
      )) as never);
    await expect(
      setAppearanceTool.execute(services, { udid: iosUdid, appearance: "light" })
    ).rejects.toThrow(/must be booted first — use boot-device/);
  });
});

describe("set-appearance — Android", () => {
  it("switches the system dark theme with cmd uimode night", async () => {
    await expect(
      setAppearanceTool.execute(services, { udid: androidEmulator, appearance: "dark" })
    ).resolves.toEqual({ appearance: "dark", previous: "light" });
    expect(vi.mocked(adbShell).mock.calls).toEqual([
      [androidEmulator, "cmd uimode night"],
      [androidEmulator, "cmd uimode night yes"],
    ]);
  });

  it("reports no previous appearance when the device was on auto", async () => {
    vi.mocked(adbShell).mockResolvedValueOnce("Night mode: auto\n");
    await expect(
      setAppearanceTool.execute(services, { udid: androidEmulator, appearance: "light" })
    ).resolves.toEqual({ appearance: "light", previous: null });
  });

  it("fails when uimode does not confirm the new mode", async () => {
    // `cmd` can print an error and still exit 0, so the reply is checked.
    vi.mocked(adbShell)
      .mockResolvedValueOnce("Night mode: no\n")
      .mockResolvedValueOnce("Error: unknown command 'night'\n");
    await expect(
      setAppearanceTool.execute(services, { udid: androidEmulator, appearance: "dark" })
    ).rejects.toThrow(/Failed to set the appearance of emulator-5554 to dark/);
  });

  it("parses every night mode uimode reports", () => {
    expect(parseNightMode("Night mode: yes\n")).toBe("yes");
    expect(parseNightMode("Night mode: no")).toBe("no");
    expect(parseNightMode("Night mode: auto\n")).toBe("auto");
    expect(parseNightMode("garbage")).toBeNull();
  });
});
