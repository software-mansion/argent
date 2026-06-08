/**
 * Covers the host-all-processes fallback used when the simulator Instruments
 * tap is broken (Xcode 26.x cannot package `--device` simulator traces):
 *  - CPU samples are scoped to the app's PID (the host trace contains every
 *    process), and
 *  - analyze reports "inconclusive" — never "All clear" — when the only data
 *    source (CPU) was empty or unreadable.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  filterSamplesByPid,
  runIosProfilerPipeline,
} from "../../src/utils/ios-profiler/pipeline/index";
import { nativeProfilerAnalyzeTool } from "../../src/tools/profiler/native-profiler/native-profiler-analyze";
import type { NativeProfilerSessionApi } from "../../src/blueprints/native-profiler-session";

// A host all-processes time-profile XML with two processes: the app (pid 111)
// and an unrelated host process (pid 222). Only the app rows must survive.
const HOST_CPU_XML = `<?xml version="1.0"?>
<trace-query-result>
<node>
  <row>
    <sample-time>1000000</sample-time>
    <thread fmt="Main Thread (0x1) (MyApp, pid: 111)"/>
    <weight>2000000</weight>
    <backtrace id="1"><frame id="1" name="appHotFunction"><binary id="1" name="MyApp" path="/var/containers/Bundle/Application/X/MyApp.app/MyApp"/></frame></backtrace>
  </row>
  <row>
    <sample-time>2000000</sample-time>
    <thread fmt="Main Thread (0x2) (OtherProc, pid: 222)"/>
    <weight>9000000</weight>
    <backtrace id="2"><frame id="2" name="hostHotFunction"><binary id="2" name="OtherProc" path="/var/other/OtherProc"/></frame></backtrace>
  </row>
</node>
</trace-query-result>`;

function hostSession(over: Partial<NativeProfilerSessionApi>): NativeProfilerSessionApi {
  return {
    deviceId: "TEST-DEVICE",
    appProcess: "MyApp",
    xctracePid: null,
    xctraceProcess: null,
    traceFile: "/tmp/fake.trace",
    exportedFiles: null,
    profilingActive: false,
    wallClockStartMs: null,
    parsedData: null,
    recordingTimeout: null,
    recordingTimedOut: false,
    recordingExitedUnexpectedly: false,
    lastExitInfo: null,
    recordingMode: "host-all-processes",
    processFilterPid: "111",
    ...over,
  };
}

describe("filterSamplesByPid", () => {
  it("keeps only the matching pid and anchors on the closing paren", () => {
    const samples = [
      { threadFmt: "Main Thread (MyApp, pid: 111)" },
      { threadFmt: "Main Thread (Other, pid: 222)" },
      { threadFmt: "Main Thread (Decoy, pid: 1110)" }, // must NOT match 111
    ];
    expect(filterSamplesByPid(samples, "111")).toEqual([
      { threadFmt: "Main Thread (MyApp, pid: 111)" },
    ]);
  });

  it("is a no-op when pid is null", () => {
    const samples = [{ threadFmt: "a" }, { threadFmt: "b" }];
    expect(filterSamplesByPid(samples, null)).toBe(samples);
  });
});

describe("runIosProfilerPipeline with a process filter", () => {
  it("scopes host all-processes CPU samples to the app pid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-fallback-"));
    try {
      const cpu = join(dir, "cpu.xml");
      await writeFile(cpu, HOST_CPU_XML, "utf8");

      const unfiltered = await runIosProfilerPipeline({ cpu, hangs: null, leaks: null });
      expect(unfiltered.cpuSamples.length).toBe(2); // both processes present

      const filtered = await runIosProfilerPipeline({ cpu, hangs: null, leaks: null }, "111");
      expect(filtered.cpuSamples.length).toBe(1);
      expect(filtered.cpuSamples[0].threadFmt).toContain("pid: 111)");
      // The dominant hotspot must be the app's function, not the louder host one.
      expect(filtered.cpuHotspots.some((h) => h.dominantFunction === "appHotFunction")).toBe(true);
      expect(filtered.cpuHotspots.some((h) => h.dominantFunction === "hostHotFunction")).toBe(
        false
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("native-profiler-analyze host fallback", () => {
  it("reports app-scoped findings (not host-wide) when samples match the pid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-analyze-ok-"));
    try {
      const cpu = join(dir, "cpu.xml");
      await writeFile(cpu, HOST_CPU_XML, "utf8");
      const api = hostSession({
        traceFile: join(dir, "fake.trace"),
        exportedFiles: { cpu, hangs: null, leaks: null },
        processFilterPid: "111",
      });

      const result = await nativeProfilerAnalyzeTool.execute(
        { session: api },
        { device_id: "TEST-DEVICE" }
      );

      expect(result.status).toBe("ok");
      expect(result.mode).toBe("host-all-processes");
      expect(result.report).toContain("appHotFunction");
      expect(result.report).not.toContain("hostHotFunction");
      // The findings report must carry the CPU-only / app-scoped fallback note.
      expect(result.report).toMatch(/host all-processes fallback/i);
      // Must NOT warn about missing hangs/leaks — they're expected-absent here.
      expect(result.report).not.toMatch(/Hangs export failed/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is inconclusive (not All clear) when the CPU export is missing", async () => {
    const api = hostSession({ exportedFiles: { cpu: null, hangs: null, leaks: null } });
    const result = await nativeProfilerAnalyzeTool.execute(
      { session: api },
      { device_id: "TEST-DEVICE" }
    );
    expect(result.status).toBe("inconclusive");
    expect(result.report).toContain("Analysis Inconclusive");
    expect(result.report).not.toContain("All clear");
  });

  it("is inconclusive when CPU exported but no samples match the app pid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-analyze-nomatch-"));
    try {
      const cpu = join(dir, "cpu.xml");
      await writeFile(cpu, HOST_CPU_XML, "utf8");
      const api = hostSession({
        traceFile: join(dir, "fake.trace"),
        exportedFiles: { cpu, hangs: null, leaks: null },
        processFilterPid: "999", // nothing in the trace
      });
      const result = await nativeProfilerAnalyzeTool.execute(
        { session: api },
        { device_id: "TEST-DEVICE" }
      );
      expect(result.status).toBe("inconclusive");
      expect(result.report).not.toContain("All clear");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("device-attach mode with all exports null is inconclusive", async () => {
    const api = hostSession({
      recordingMode: "device-attach",
      processFilterPid: null,
      exportedFiles: { cpu: null, hangs: null, leaks: null },
    });
    const result = await nativeProfilerAnalyzeTool.execute(
      { session: api },
      { device_id: "TEST-DEVICE" }
    );
    expect(result.status).toBe("inconclusive");
  });
});
