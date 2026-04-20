import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";

type ExecFileCallback = (error: Error | null, stdout?: string, stderr?: string) => void;

const mockExecFile = vi.fn();

function getCallback(args: unknown[]): ExecFileCallback {
  const callback = args[args.length - 1];
  if (typeof callback !== "function") {
    throw new Error("Missing execFile callback");
  }
  return callback as ExecFileCallback;
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

describe("boot-device — iOS path (previously boot-simulator)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pre-warm the dep cache so `ensureDep('xcrun')` doesn't probe PATH and
    // add an extra first `command -v xcrun` call to mockExecFile.
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
    mockExecFile.mockImplementation((...args: unknown[]) => {
      getCallback(args)(null, "", "");
      return {} as never;
    });
  });

  it("waits for boot completion and native-devtools init before returning", async () => {
    const resolveService = vi.fn(async () => {});
    const registry = {
      resolveService,
    } as unknown as Registry;

    const tool = createBootDeviceTool(registry);

    await expect(
      tool.execute!({}, { udid: "11111111-1111-1111-1111-111111111111" })
    ).resolves.toEqual({
      platform: "ios",
      udid: "11111111-1111-1111-1111-111111111111",
      booted: true,
    });

    expect(mockExecFile.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ["xcrun", ["simctl", "boot", "11111111-1111-1111-1111-111111111111"]],
      ["xcrun", ["simctl", "bootstatus", "11111111-1111-1111-1111-111111111111", "-b"]],
      [
        "defaults",
        [
          "write",
          "com.apple.iphonesimulator",
          "CurrentDeviceUDID",
          "11111111-1111-1111-1111-111111111111",
        ],
      ],
      ["open", ["-a", "Simulator.app"]],
    ]);
    expect(resolveService).toHaveBeenCalledWith(
      "NativeDevtools:11111111-1111-1111-1111-111111111111"
    );
    // NativeDevtools must be primed AFTER bootstatus returns (launchd env is
    // only reachable once the simulator is fully up) and BEFORE `open`, so
    // the UI reflects the injected state on first paint.
    expect(resolveService.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockExecFile.mock.invocationCallOrder[1]
    );
    expect(resolveService.mock.invocationCallOrder[0]).toBeLessThan(
      mockExecFile.mock.invocationCallOrder[2]
    );
  });

  it("still primes native-devtools when simctl reports the simulator is already booted", async () => {
    mockExecFile
      .mockImplementationOnce((...args: unknown[]) => {
        getCallback(args)(new Error("Unable to boot device in current state: Booted"));
        return {} as never;
      })
      .mockImplementation((...args: unknown[]) => {
        getCallback(args)(null, "", "");
        return {} as never;
      });

    const resolveService = vi.fn(async () => {});
    const registry = { resolveService } as unknown as Registry;

    const tool = createBootDeviceTool(registry);

    await expect(
      tool.execute!({}, { udid: "22222222-2222-2222-2222-222222222222" })
    ).resolves.toEqual({
      platform: "ios",
      udid: "22222222-2222-2222-2222-222222222222",
      booted: true,
    });

    expect(mockExecFile.mock.calls[1]?.slice(0, 2)).toEqual([
      "xcrun",
      ["simctl", "bootstatus", "22222222-2222-2222-2222-222222222222", "-b"],
    ]);
    expect(resolveService).toHaveBeenCalledWith(
      "NativeDevtools:22222222-2222-2222-2222-222222222222"
    );
  });
});

describe("boot-device — input validation (exclusive udid/avdName)", () => {
  // The zodSchema marks both udid and avdName as optional so the JSON schema
  // advertises both; the execute function enforces that exactly one is set.
  // These tests pin the mutual-exclusion rule at the execute boundary where
  // callers actually hit it.

  it("rejects when both udid and avdName are provided — ambiguous target", async () => {
    const tool = createBootDeviceTool({ resolveService: async () => {} } as unknown as Registry);
    await expect(
      tool.execute!(
        {},
        {
          udid: "11111111-1111-1111-1111-111111111111",
          avdName: "Pixel_7_API_34",
        }
      )
    ).rejects.toThrow(/exactly one of `udid` .* or `avdName`/);
  });

  it("rejects when neither udid nor avdName is provided — no target", async () => {
    const tool = createBootDeviceTool({ resolveService: async () => {} } as unknown as Registry);
    await expect(tool.execute!({}, {})).rejects.toThrow(/exactly one of `udid`/);
  });

  it("bounds bootTimeoutMs to [30s, 15min]", () => {
    // Timeouts should fail at the zod layer before reaching execute.
    const tool = createBootDeviceTool({} as unknown as Registry);
    expect(tool.zodSchema.safeParse({ avdName: "x", bootTimeoutMs: 29_999 }).success).toBe(false);
    expect(tool.zodSchema.safeParse({ avdName: "x", bootTimeoutMs: 900_001 }).success).toBe(false);
    expect(tool.zodSchema.safeParse({ avdName: "x", bootTimeoutMs: 60_000 }).success).toBe(true);
  });
});
