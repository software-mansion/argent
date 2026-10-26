import { afterEach, describe, expect, it, vi } from "vitest";
import { findRuntimeDevice } from "../src/utils/debugger/runtime-device";

/** What each device's log holds: the markers the app wrote there. */
const deviceLogs = vi.hoisted(() => new Map<string, string[]>());

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  runAdb: vi.fn(async (args: string[]) => {
    if (args[0] === "devices") {
      return { stdout: "List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n" };
    }
    const serial = args[1]!;
    const marker = args.at(-1)!;
    const lines = (deviceLogs.get(serial) ?? []).filter((line) => line.includes(marker));
    return { stdout: lines.join("\n") };
  }),
}));

vi.mock("../src/utils/ios-devices", () => ({
  listIosSimulators: vi.fn(async () => [
    { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", state: "Booted" },
    { udid: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB", state: "Shutdown" },
  ]),
}));

vi.mock("../src/utils/ios-device-sets", () => ({
  simctlArgsForUdid: vi.fn(async (_udid: string, args: string[]) => ["simctl", ...args]),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn(
    (
      _file: string,
      args: string[],
      _options: unknown,
      callback: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const udid = args[2]!;
      const predicate = args.at(-1)!;
      const marker = JSON.parse(
        predicate.slice("eventMessage CONTAINS ".length).split(" AND ")[0]!
      );
      const lines = (deviceLogs.get(udid) ?? []).filter((line) => line.includes(marker));
      callback(null, { stdout: lines.join("\n"), stderr: "" });
    }
  ),
}));

/** A runtime on `deviceId`: its native logger writes to that device's log. */
function runtimeOn(deviceId: string | null) {
  return {
    evaluate: vi.fn(async (expression: string) => {
      if (deviceId === null) return false;
      const marker = /"(argent-device-probe:[^"]+)"/.exec(expression)![1]!;
      deviceLogs.set(deviceId, [...(deviceLogs.get(deviceId) ?? []), marker]);
      return true;
    }),
  };
}

afterEach(() => {
  deviceLogs.clear();
});

describe("findRuntimeDevice", () => {
  it("finds the Android device whose logcat holds the runtime's marker", async () => {
    await expect(findRuntimeDevice(runtimeOn("emulator-5556"))).resolves.toBe("emulator-5556");
  });

  it("finds the booted iOS simulator whose log holds the marker", async () => {
    await expect(
      findRuntimeDevice(runtimeOn("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"))
    ).resolves.toBe("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
  });

  it("finds nothing for a runtime without a native logger", async () => {
    await expect(findRuntimeDevice(runtimeOn(null))).resolves.toBeUndefined();
  });

  it("finds nothing when no device it can read holds the marker", async () => {
    await expect(findRuntimeDevice(runtimeOn("ext:cloud-phone"))).resolves.toBeUndefined();
  });
});
