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

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { createBootSimulatorTool } from "../src/tools/simulator/boot-simulator";

describe("boot-simulator tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const tool = createBootSimulatorTool(registry);

    await expect(tool.execute!({}, { udid: "SIM-1" })).resolves.toEqual({
      udid: "SIM-1",
      booted: true,
    });

    expect(mockExecFile.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ["xcrun", ["simctl", "boot", "SIM-1"]],
      ["xcrun", ["simctl", "bootstatus", "SIM-1", "-b"]],
      ["defaults", ["write", "com.apple.iphonesimulator", "CurrentDeviceUDID", "SIM-1"]],
      ["open", ["-a", "Simulator.app"]],
    ]);
    expect(resolveService).toHaveBeenCalledWith("NativeDevtools:SIM-1");
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

    const tool = createBootSimulatorTool(registry);

    await expect(tool.execute!({}, { udid: "SIM-2" })).resolves.toEqual({
      udid: "SIM-2",
      booted: true,
    });

    expect(mockExecFile.mock.calls[1]?.slice(0, 2)).toEqual([
      "xcrun",
      ["simctl", "bootstatus", "SIM-2", "-b"],
    ]);
    expect(resolveService).toHaveBeenCalledWith("NativeDevtools:SIM-2");
  });
});
