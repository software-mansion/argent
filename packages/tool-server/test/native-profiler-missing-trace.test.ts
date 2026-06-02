/**
 * Regression: when native-profiler-stop has populated `exportedFiles.cpu` with
 * a path but the file is unreadable (deleted, FS error, /tmp cleanup), the
 * pipeline used to silently swallow the ENOENT inside parseCpuFile and
 * return empty data, and the analyze tool would render an "All clear"
 * report — pretending the trace was successfully analyzed when the data
 * was never read.
 *
 * The analyze tool must distinguish ENOENT/EACCES from "file exists but
 * has no findings" and surface the export failure via `exportErrors`.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { nativeProfilerAnalyzeTool } from "../src/tools/profiler/native-profiler/native-profiler-analyze";
import type { NativeProfilerSessionApi } from "../src/blueprints/native-profiler-session";

describe("native-profiler-analyze: missing trace file", () => {
  it("surfaces an export warning that names the missing CPU file when its path is set but the file is absent", async () => {
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), "native-profiler-missing-"));
      const cpuPath = join(dir, "missing_cpu.xml"); // never written
      // Provide real (empty-but-readable) hangs/leaks files so the only
      // possible warning is about the missing CPU file. This isolates the
      // bug from the existing null-path warnings.
      const hangsPath = join(dir, "hangs.xml");
      const leaksPath = join(dir, "leaks.xml");
      await writeFile(hangsPath, "<root></root>", "utf8");
      await writeFile(leaksPath, "<root></root>", "utf8");
      const traceFile = join(dir, "fake.trace");

      // Simulate what native-profiler-stop hands to native-profiler-analyze:
      // exportedFiles has a non-null CPU path, but the file does not exist.
      const session: NativeProfilerSessionApi = {
        deviceId: "TEST-DEVICE",
        appProcess: null,
        xctracePid: null,
        xctraceProcess: null,
        traceFile,
        exportedFiles: { cpu: cpuPath, hangs: hangsPath, leaks: leaksPath },
        profilingActive: false,
        wallClockStartMs: null,
        parsedData: null,
        recordingTimeout: null,
        recordingTimedOut: false,
        recordingExitedUnexpectedly: false,
        lastExitInfo: null,
      };

      const result = await nativeProfilerAnalyzeTool.execute(
        { session },
        { device_id: "TEST-DEVICE" }
      );

      // Bug: previously this rendered "All clear" with no warning because
      // parseCpuFile silently swallowed the ENOENT. Fix: a missing-file path
      // must produce an Export warning whose CPU entry names the bad path.
      expect(result.report).toContain("Export warnings");
      // The warning should mention the CPU category and reference the file.
      expect(result.report).toMatch(/-\s*\*\*cpu\*\*:[^\n]*missing_cpu\.xml/i);
      // Word it so the user understands the file is missing/unreadable, not
      // that the export was simply empty.
      expect(result.report).toMatch(/missing|not found|unreadable/i);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});
