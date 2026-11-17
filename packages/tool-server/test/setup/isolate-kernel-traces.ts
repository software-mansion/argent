import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// After each xctrace exits, spawnXctraceRecording deletes the raw kernel trace
// that xctrace's helper wrote for it to the user's temporary folder
// (src/utils/ios-profiler/kernel-trace.ts). Unit tests start fake xctrace
// processes on a machine where real recordings can run: give them an empty
// folder of their own, so that no test lists or deletes a real file.
const dir = mkdtempSync(join(tmpdir(), "argent-test-ktrace-"));

vi.mock("../../src/utils/ios-profiler/kernel-trace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-profiler/kernel-trace")>()),
  kernelTraceDir: () => dir,
}));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
