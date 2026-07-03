import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Records how the capture-strategy selector probes the active Xcode version, so
// the test can assert it never reaches /bin/sh (execSync). Part of keeping the
// whole iOS-profiler subsystem uniformly shell-free.
const rec = vi.hoisted(() => ({
  calls: [] as { fn: string; file: string; args: string[] }[],
}));

vi.mock("child_process", () => ({
  execFileSync: (file: string, args: string[]) => {
    rec.calls.push({ fn: "execFileSync", file, args });
    return "Xcode 26.5\nBuild version 17F42\n";
  },
  execSync: (cmd: string) => {
    rec.calls.push({ fn: "execSync", file: String(cmd), args: [] });
    throw new Error(`execSync must not be used here (shell risk): ${cmd}`);
  },
}));

import { selectIosCaptureStrategy } from "../src/utils/ios-profiler/capture-strategy/select";

describe("iOS capture-strategy: xcodebuild probe is shell-free", () => {
  beforeEach(() => {
    rec.calls.length = 0;
    delete process.env.ARGENT_IOS_CAPTURE;
  });
  afterEach(() => {
    delete process.env.ARGENT_IOS_CAPTURE;
  });

  it("reads the Xcode version via execFileSync(argv), never execSync", () => {
    // Xcode 26.5 is a degraded version → the selector falls through to the
    // version probe (rather than the env override), exercising the sink.
    const strategy = selectIosCaptureStrategy();
    expect(strategy.name).toBe("all-processes");

    expect(rec.calls.every((c) => c.fn === "execFileSync")).toBe(true);
    const probe = rec.calls.find((c) => c.file === "xcodebuild");
    expect(probe).toBeDefined();
    expect(probe?.args).toEqual(["-version"]);
  });
});
