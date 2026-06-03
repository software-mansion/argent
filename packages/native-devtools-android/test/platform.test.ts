import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectHostPlatform,
  tryDetectHostPlatform,
  traceProcessorCacheDir,
  traceProcessorCachePath,
} from "../src/platform";
import { TraceProcessorUnavailableError } from "../src/errors";

describe("detectHostPlatform", () => {
  // Mirrors the uname case-switch in scripts/download-native-binaries.sh.
  const cases: Array<[NodeJS.Platform, string, string]> = [
    ["darwin", "arm64", "mac-arm64"],
    ["darwin", "x64", "mac-amd64"],
    ["linux", "x64", "linux-amd64"],
    ["linux", "arm64", "linux-arm64"],
  ];

  it.each(cases)("maps %s/%s → %s", (platform, arch, expected) => {
    expect(detectHostPlatform(platform, arch)).toBe(expected);
  });

  it("throws unsupported_platform on win32", () => {
    try {
      detectHostPlatform("win32", "x64");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TraceProcessorUnavailableError);
      expect((err as TraceProcessorUnavailableError).kind).toBe("unsupported_platform");
      expect((err as Error).message).toContain("win32-x64");
    }
  });

  it("throws unsupported_platform on an unknown arch", () => {
    expect(() => detectHostPlatform("linux", "mips")).toThrowError(TraceProcessorUnavailableError);
  });
});

describe("tryDetectHostPlatform", () => {
  it("returns the platform for a supported host", () => {
    expect(tryDetectHostPlatform("darwin", "arm64")).toBe("mac-arm64");
  });

  it("returns null instead of throwing for an unsupported host", () => {
    expect(tryDetectHostPlatform("win32", "x64")).toBeNull();
  });
});

describe("trace-processor cache paths", () => {
  it("traceProcessorCacheDir is version- and platform-keyed under ~/.argent", () => {
    const dir = traceProcessorCacheDir("v55.3", "linux-amd64");
    expect(dir).toBe(
      path.join(os.homedir(), ".argent", "trace-processor", "v55.3", "linux-amd64")
    );
  });

  it("traceProcessorCachePath appends the binary filename", () => {
    const p = traceProcessorCachePath("v55.3", "mac-arm64");
    expect(p).toBe(
      path.join(
        os.homedir(),
        ".argent",
        "trace-processor",
        "v55.3",
        "mac-arm64",
        "trace_processor_shell"
      )
    );
  });

  it("a version bump produces a distinct cache path (auto-invalidation)", () => {
    expect(traceProcessorCachePath("v55.3", "mac-arm64")).not.toBe(
      traceProcessorCachePath("v56.0", "mac-arm64")
    );
  });
});
