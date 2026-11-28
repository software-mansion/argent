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
      if (result instanceof Error) {
        // Mirror execFile's actual rejection contract: stderr/stdout are
        // attached to the error object so describeAdbFailure can read them.
        const e = result as Error & { stderr?: string; stdout?: string };
        callback(e, { stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
      } else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

// `runAdb` resolves adb to an absolute path before spawning. Stub the
// resolver to return the bare name so existing `cmd === "adb"` mocks fire.
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import { isAdbTransportFailure, waitForBootCompleted } from "../src/utils/adb";
import { FAILURE_CODES, FailureError } from "@argent/registry";

beforeEach(() => {
  execFileMock.mockReset();
});

/**
 * `isTerminalAdbError` checks for the literal substring "device not found",
 * but adb's actual stderr is `error: device 'emulator-5554' not found` —
 * the serial appears between "device" and "not found", so the substring
 * match never fires. Result: when a device drops off PATH mid-boot,
 * `waitForBootCompleted` keeps spinning until the full timeoutMs elapses
 * (default 120 s) instead of failing fast with the actionable error.
 *
 * Expected: the function should detect the terminal state and throw on
 * the first failed poll (well before timeoutMs).
 */
describe("isTerminalAdbError matches adb's real `device 'X' not found` format", () => {
  it("waitForBootCompleted should fail fast when adb says \"device 'X' not found\"", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const err = new Error("Command failed") as Error & { stderr?: string };
        err.stderr = "error: device 'emulator-5554' not found";
        return err;
      }
      return new Error("unexpected call");
    });

    const start = Date.now();
    // Use a small budget so the test doesn't take 2 minutes; the bug
    // produces a full-timeoutMs hang regardless of size.
    await expect(waitForBootCompleted("emulator-5554", 4_000)).rejects.toThrow(
      /terminal state|device.*not found/i
    );
    const elapsed = Date.now() - start;
    // Fail-fast path: throw fires after the first failed poll (< 1 s).
    // Bug path: loop spins until the deadline (~timeoutMs).
    // Anything ≥ 3 s on the 4 s budget proves the bug.
    expect(elapsed).toBeLessThan(2_500);
  }, 8_000);
});

describe("isAdbTransportFailure", () => {
  it.each([
    "protocol fault (couldn't read status)",
    "adb: error: failed to read response from server: Connection reset by peer",
    "adb: error: failed to get feature set: cannot connect to daemon",
    "error: device still connecting",
    "error: device still authorizing",
    "error: device 'emulator-5554' offline",
    "error: device unauthorized.",
    "error: device 'emulator-5554' not found",
    "error: no devices/emulators found",
  ])("is true for %s", (message) => {
    expect(isAdbTransportFailure(new Error(message))).toBe(true);
  });

  it("is true for a timeout", () => {
    expect(
      isAdbTransportFailure(
        new FailureError("adb -s emulator-5554 shell true failed: timed out", {
          error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
          failure_stage: "android_adb_command",
          failure_area: "tool_server",
          error_kind: "timeout",
        })
      )
    ).toBe(true);
  });

  it.each([
    "settings: Can't find service: settings",
    "Error: java.lang.SecurityException: Permission denial",
    "",
  ])("is false for the device's own answer %j", (message) => {
    expect(isAdbTransportFailure(new Error(message))).toBe(false);
  });
});
