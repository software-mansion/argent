import { afterEach, describe, expect, it } from "vitest";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
  getCachedProfilerPaths,
  type ProfilerSessionPaths,
} from "../src/blueprints/react-profiler-session";
import { rememberDeviceAlias, resetDeviceAliases } from "../src/utils/debugger/device-alias";

const PORT = 8081;
const SERIAL = "emulator-5554";
const LOGICAL = "6cca05b47beabb97";
const PATHS = { cpuProfilePath: "/tmp/cpu.json" } as ProfilerSessionPaths;

afterEach(() => {
  clearCachedProfilerPaths(PORT, SERIAL);
  clearCachedProfilerPaths(PORT, LOGICAL);
  resetDeviceAliases();
});

describe("profiler paths cache", () => {
  it("finds a session stored under the connect id by its logicalDeviceId", () => {
    rememberDeviceAlias(LOGICAL, SERIAL);
    cacheProfilerPaths(PORT, PATHS, SERIAL);

    expect(getCachedProfilerPaths(PORT, LOGICAL)).toBe(PATHS);
    expect(getCachedProfilerPaths(PORT, SERIAL)).toBe(PATHS);
  });

  it("clears a session by either id", () => {
    rememberDeviceAlias(LOGICAL, SERIAL);
    cacheProfilerPaths(PORT, PATHS, SERIAL);

    clearCachedProfilerPaths(PORT, LOGICAL);

    expect(getCachedProfilerPaths(PORT, SERIAL)).toBeUndefined();
  });

  it("keeps devices apart", () => {
    rememberDeviceAlias(LOGICAL, SERIAL);
    cacheProfilerPaths(PORT, PATHS, SERIAL);

    expect(getCachedProfilerPaths(PORT, "other-device")).toBeUndefined();
    expect(getCachedProfilerPaths(9090, LOGICAL)).toBeUndefined();
  });
});
