import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pass-4 finding 4: keep IOS_PROFILER_REFERENCE.md's description of the
 * degraded-Xcode bound in agreement with `isDegraded`. The code treats EVERY
 * 26.x from 26.4 up (26.4, 26.5, 26.6, …) and all of 27+ as broken. The doc
 * previously said "26.4 and every version from 27 up", which omits 26.5/26.6 —
 * a maintainer on Xcode 26.5 would expect the device/malloc path to work, but
 * the selector refuses it. This test binds the doc claim to real behavior so
 * the two can't drift again.
 */
vi.mock("child_process", () => ({
  execFileSync: () => "Xcode 26.5\nBuild version 17F42\n",
  execSync: () => {
    throw new Error("execSync must not be used (shell risk)");
  },
}));

import { resolveIosCaptureStrategy } from "../../src/utils/ios-profiler/capture-strategy/select";

const REFERENCE_MD = join(__dirname, "../../src/utils/ios-profiler/IOS_PROFILER_REFERENCE.md");

describe("degraded-Xcode bound: doc matches isDegraded (pass-4 finding 4)", () => {
  beforeEach(() => {
    delete process.env.ARGENT_IOS_CAPTURE;
  });
  afterEach(() => {
    delete process.env.ARGENT_IOS_CAPTURE;
  });

  it("treats Xcode 26.5 as degraded (a mid-band 26.x, not just 26.4 and 27+)", () => {
    const decision = resolveIosCaptureStrategy();
    expect(decision.reason).toEqual({ kind: "degraded-xcode", major: 26, minor: 5 });
    expect(decision.strategy.name).toBe("all-processes");
  });

  it("REFERENCE.md no longer implies only 26.4 and 27+ are broken", () => {
    const md = readFileSync(REFERENCE_MD, "utf8");
    // The old phrasing skipped the 26.5+ band; it must be gone.
    expect(md).not.toContain("26.4 and every version from 27 up");
    // And the corrected text must acknowledge the mid-band 26.x versions.
    expect(md).toContain("26.5");
  });
});
