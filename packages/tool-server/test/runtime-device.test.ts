import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findRuntimeDevices,
  OTHER_TRANSPORTS_GRACE_MS,
} from "../src/utils/debugger/runtime-device";
import { XcodeFirstLaunchPendingError } from "../src/utils/dependency-errors";
import { listIosSimulators } from "../src/utils/ios-devices";

/** What each device's log holds: the markers the app wrote there. */
const deviceLogs = vi.hoisted(() => new Map<string, string[]>());
/** The serials `adb devices` lists, and how long each one's logcat read takes. */
const adb = vi.hoisted(() => ({
  serials: [] as string[],
  readDelayMs: new Map<string, number>(),
}));
const DEFAULT_SERIALS = ["emulator-5554", "emulator-5556"];

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  runAdb: vi.fn(async (args: string[]) => {
    if (args[0] === "devices") {
      return {
        stdout: `List of devices attached\n${adb.serials.map((s) => `${s}\tdevice\n`).join("")}`,
      };
    }
    const serial = args[1]!;
    const marker = args.at(-1)!;
    const delayMs = adb.readDelayMs.get(serial);
    if (delayMs === Infinity) return new Promise<never>(() => {});
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
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
      // React Native logs the marker at info level, which `log show` prints
      // only with `--info`.
      if (!args.includes("--info")) {
        callback(null, { stdout: "", stderr: "" });
        return;
      }
      const predicate = args.at(-1)!;
      const marker = JSON.parse(
        predicate.slice("eventMessage CONTAINS ".length).split(" AND ")[0]!
      );
      const lines = (deviceLogs.get(udid) ?? []).filter((line) => line.includes(marker));
      callback(null, { stdout: lines.join("\n"), stderr: "" });
    }
  ),
}));

/**
 * A runtime on the device `deviceIds` name: its native logger writes to that
 * device's log, which every id of the device (one per adb transport) reads.
 */
function runtimeOn(...deviceIds: Array<string | null>) {
  return {
    evaluate: vi.fn(async (expression: string) => {
      if (deviceIds[0] === null) return false;
      const marker = /"(argent-device-probe:[^"]+)"/.exec(expression)![1]!;
      for (const id of deviceIds as string[]) {
        deviceLogs.set(id, [...(deviceLogs.get(id) ?? []), marker]);
      }
      return true;
    }),
  };
}

beforeEach(() => {
  adb.serials = [...DEFAULT_SERIALS];
});

afterEach(() => {
  deviceLogs.clear();
  adb.readDelayMs.clear();
});

describe("findRuntimeDevices", () => {
  it("finds the Android device whose logcat holds the runtime's marker", async () => {
    await expect(findRuntimeDevices(runtimeOn("emulator-5556"))).resolves.toEqual([
      "emulator-5556",
    ]);
  });

  it("finds the booted iOS simulator whose log holds the marker", async () => {
    await expect(
      findRuntimeDevices(runtimeOn("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"))
    ).resolves.toEqual(["AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"]);
  });

  it("finds nothing for a runtime without a native logger", async () => {
    await expect(findRuntimeDevices(runtimeOn(null))).resolves.toEqual([]);
  });

  it("finds nothing when no device it can read holds the marker", async () => {
    await expect(findRuntimeDevices(runtimeOn("ext:cloud-phone"))).resolves.toEqual([]);
  });

  // The simulator listing is refused while Xcode's install is pending.
  it("still answers when the simulator listing is refused", async () => {
    vi.mocked(listIosSimulators).mockRejectedValue(new XcodeFirstLaunchPendingError("simctl"));
    try {
      await expect(findRuntimeDevices(runtimeOn("ext:cloud-phone"))).resolves.toEqual([]);
      await expect(findRuntimeDevices(runtimeOn("emulator-5556"))).resolves.toEqual([
        "emulator-5556",
      ]);
    } finally {
      vi.mocked(listIosSimulators).mockReset();
    }
  });

  describe("for a device reachable over two adb transports", () => {
    const USB = "R58M123ABC";
    const WIRELESS = "192.168.1.5:5555";

    beforeEach(() => {
      adb.serials = [USB, WIRELESS, "emulator-5556"];
    });

    it("finds both serials, whichever answers first", async () => {
      adb.readDelayMs.set(WIRELESS, 50);
      await expect(findRuntimeDevices(runtimeOn(USB, WIRELESS))).resolves.toEqual([USB, WIRELESS]);

      adb.readDelayMs.clear();
      adb.readDelayMs.set(USB, 50);
      await expect(findRuntimeDevices(runtimeOn(USB, WIRELESS))).resolves.toEqual([WIRELESS, USB]);
    });

    it("does not wait out a hung transport's read once another holds the marker", async () => {
      adb.readDelayMs.set(WIRELESS, Infinity);
      const startedAt = Date.now();

      await expect(findRuntimeDevices(runtimeOn(USB, WIRELESS))).resolves.toEqual([USB]);
      expect(Date.now() - startedAt).toBeLessThan(OTHER_TRANSPORTS_GRACE_MS + 1_000);
    });
  });
});
