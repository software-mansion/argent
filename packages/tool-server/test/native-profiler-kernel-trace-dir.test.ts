/**
 * The folder where xctrace's helper writes the raw kernel trace of each
 * recording: `getconf DARWIN_USER_TEMP_DIR`, read once. A failed `getconf`
 * (a timeout on a loaded Mac) must not pin the fallback for the server's life.
 */
import { describe, it, expect, vi } from "vitest";
import * as os from "node:os";

// test/setup/isolate-kernel-traces.ts replaces the folder suite-wide.
vi.unmock("../src/utils/ios-profiler/kernel-trace");

const getconf = vi.hoisted(() => ({ calls: 0 }));
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFileSync: vi.fn(() => {
    getconf.calls++;
    // The first call times out; the next ones answer.
    if (getconf.calls === 1) {
      throw Object.assign(new Error("spawnSync getconf ETIMEDOUT"), { code: "ETIMEDOUT" });
    }
    return "/var/folders/xx/user-temp/T/\n";
  }),
}));

import { kernelTraceDir } from "../src/utils/ios-profiler/kernel-trace";

describe("kernelTraceDir", () => {
  it("asks getconf again after a failed call, and then keeps its answer", () => {
    expect(kernelTraceDir()).toBe(os.tmpdir());
    expect(kernelTraceDir()).toBe("/var/folders/xx/user-temp/T/");
    expect(kernelTraceDir()).toBe("/var/folders/xx/user-temp/T/");
    expect(getconf.calls).toBe(2);
  });
});
