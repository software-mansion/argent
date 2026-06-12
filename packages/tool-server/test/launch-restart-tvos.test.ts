import { describe, it, expect, vi, beforeEach } from "vitest";

// launch-app / restart-app classify a tvOS sim as platform "ios" by UDID shape,
// so they must NOT resolve the iOS-only native-devtools service for it: that
// factory runs `simctl spawn … launchctl setenv DYLD_INSERT_LIBRARIES` with an
// iOS-built dylib at resolution time, poisoning the Apple TV sim's launchd env.
// These tests pin the lazy-resolution behaviour: native-devtools is resolved
// for a regular iOS sim and skipped for a tvOS one.

const execFileMock = vi.fn(
  (
    _cmd: string,
    _args: readonly string[],
    opts: unknown,
    cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
  ) => {
    const callback = typeof opts === "function" ? opts : cb!;
    callback(null, { stdout: "", stderr: "" });
  }
);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...a: unknown[]) => (execFileMock as any)(...a) };
});

// Default to the iOS path; the tvOS cases override per-test.
vi.mock("../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => false),
}));

// precheckNativeDevtools would otherwise probe a real api; stub it to a no-op
// "not blocked" so the handler proceeds to the simctl launch.
vi.mock("../src/blueprints/native-devtools", async () => {
  const actual = await vi.importActual<typeof import("../src/blueprints/native-devtools")>(
    "../src/blueprints/native-devtools"
  );
  return { ...actual, precheckNativeDevtools: vi.fn(async () => null) };
});

import { createLaunchAppTool } from "../src/tools/launch-app";
import { createRestartAppTool } from "../src/tools/restart-app";
import { isTvOsSimulator } from "../src/utils/ios-devices";
import { precheckNativeDevtools } from "../src/blueprints/native-devtools";

const mockIsTvOs = vi.mocked(isTvOsSimulator);
const mockPrecheck = vi.mocked(precheckNativeDevtools);

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const TVOS_UDID = "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD";

function makeRegistry() {
  const resolveService = vi.fn(async () => ({}) as unknown);
  return { registry: { resolveService } as any, resolveService };
}

beforeEach(() => {
  execFileMock.mockClear();
  mockIsTvOs.mockReset().mockResolvedValue(false);
  mockPrecheck.mockClear().mockResolvedValue(null);
});

describe("launch-app — tvOS skips native-devtools injection", () => {
  it("resolves native-devtools for a regular iOS simulator", async () => {
    const { registry, resolveService } = makeRegistry();
    const tool = createLaunchAppTool(registry);

    const res = await tool.execute!({}, { udid: IOS_UDID, bundleId: "com.example.app" });

    expect(res).toEqual({ launched: true, bundleId: "com.example.app" });
    expect(resolveService).toHaveBeenCalledTimes(1);
    expect(mockPrecheck).toHaveBeenCalledTimes(1);
  });

  it("does NOT resolve native-devtools for a tvOS simulator", async () => {
    mockIsTvOs.mockResolvedValue(true);
    const { registry, resolveService } = makeRegistry();
    const tool = createLaunchAppTool(registry);

    const res = await tool.execute!({}, { udid: TVOS_UDID, bundleId: "com.example.tvapp" });

    expect(res).toEqual({ launched: true, bundleId: "com.example.tvapp" });
    // The whole point: no iOS-only service resolution / DYLD injection for tvOS.
    expect(resolveService).not.toHaveBeenCalled();
    expect(mockPrecheck).not.toHaveBeenCalled();
    // It still launched the app via simctl.
    const launched = execFileMock.mock.calls.some(
      ([cmd, args]) =>
        cmd === "xcrun" &&
        Array.isArray(args) &&
        args.includes("launch") &&
        args.includes(TVOS_UDID)
    );
    expect(launched).toBe(true);
  });
});

describe("restart-app — tvOS skips native-devtools injection", () => {
  it("resolves native-devtools for a regular iOS simulator", async () => {
    const { registry, resolveService } = makeRegistry();
    const tool = createRestartAppTool(registry);

    const res = await tool.execute!({}, { udid: IOS_UDID, bundleId: "com.example.app" });

    expect(res).toEqual({ restarted: true, bundleId: "com.example.app" });
    expect(resolveService).toHaveBeenCalledTimes(1);
    expect(mockPrecheck).toHaveBeenCalledTimes(1);
  });

  it("does NOT resolve native-devtools for a tvOS simulator", async () => {
    mockIsTvOs.mockResolvedValue(true);
    const { registry, resolveService } = makeRegistry();
    const tool = createRestartAppTool(registry);

    const res = await tool.execute!({}, { udid: TVOS_UDID, bundleId: "com.example.tvapp" });

    expect(res).toEqual({ restarted: true, bundleId: "com.example.tvapp" });
    expect(resolveService).not.toHaveBeenCalled();
    expect(mockPrecheck).not.toHaveBeenCalled();
    // terminate + launch still ran against the tvOS udid.
    const launched = execFileMock.mock.calls.some(
      ([cmd, args]) =>
        cmd === "xcrun" &&
        Array.isArray(args) &&
        args.includes("launch") &&
        args.includes(TVOS_UDID)
    );
    expect(launched).toBe(true);
  });
});
