/**
 * A trace with no leaks export must not read as leak-free.
 *
 * The all-processes capture fallback records the built-in Time Profiler template,
 * which has no Leaks instrument, so stop exports no leaks file. The reports used to
 * treat that like a capture with zero leaks: analyze said "All clear — no CPU
 * hotspots, UI hangs, or memory issues detected", leak_stacks said "No memory leaks
 * detected" and the combined report said "0 leaks". A capture whose template has
 * the Leaks instrument exports an empty table when nothing leaked, so a missing
 * export always means the leaks were not checked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
} from "../../src/blueprints/react-profiler-session";
import {
  LEAKS_NOT_RECORDED,
  renderNativeProfilerReport,
} from "../../src/utils/ios-profiler/render";
import type { MemoryLeak, ProfilerPayload, UiHang } from "../../src/utils/ios-profiler/types";

// The real pipeline, so the leaks export decides whether leaks were recorded. The
// CPU and hangs exports are empty: zero bottlenecks, and analyze takes the all-clear path.
vi.mock("../../src/utils/ios-profiler/pipeline/index", async (importActual) => {
  const actual = await importActual<typeof import("../../src/utils/ios-profiler/pipeline/index")>();
  return { ...actual, runIosProfilerPipeline: vi.fn(actual.runIosProfilerPipeline) };
});

// profiler-load reads saved sessions from getDebugDir(); point it at the test dir.
// The rest of the module stays real: the combined report reads commits with it.
vi.mock("../../src/utils/react-profiler/debug/dump", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/react-profiler/debug/dump")>()),
  getDebugDir: vi.fn(),
}));

// The Android combined report re-queries the .pftrace through trace processor.
vi.mock("../../src/utils/android-profiler/pipeline/index", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/android-profiler/pipeline/index")>()),
  loadAndroidCombinedData: vi.fn(),
}));

import { getDebugDir } from "../../src/utils/react-profiler/debug/dump";
import { runIosProfilerPipeline } from "../../src/utils/ios-profiler/pipeline/index";
import { loadAndroidCombinedData } from "../../src/utils/android-profiler/pipeline/index";
import { analyzeNativeProfilerIos } from "../../src/tools/profiler/native-profiler/platforms/ios";
import {
  profilerStackQueryTool,
  renderLeakStacksIos,
} from "../../src/tools/profiler/query/profiler-stack-query";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";
import { profilerCombinedReportTool } from "../../src/tools/profiler/combined/profiler-combined-report";

const DEVICE = "ios-sim";
const ANDROID_DEVICE = "emulator-5554";
const PORT = 8081;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-leaks-not-recorded-"));
  vi.mocked(getDebugDir).mockResolvedValue(dir);
});

afterEach(async () => {
  clearCachedProfilerPaths(PORT, DEVICE);
  clearCachedProfilerPaths(PORT, ANDROID_DEVICE);
  await fs.rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const SESSION_ID = "20261030-120000";

// The leaks exports as xctrace writes them. A template with the Leaks instrument
// exports its Leaks detail, with no row when nothing leaked:
const LEAKS_CHECKED_NONE_FOUND =
  `<?xml version="1.0"?>\n<trace-query-result>\n` +
  `<node xpath='//trace-toc[1]/run[1]/tracks[1]/track[2]/details[1]/detail[1]'></node>` +
  `</trace-query-result>\n`;
// A template without it, such as the built-in Time Profiler of the all-processes
// capture: the xctrace of Xcode 26.6 still exits 0 and writes no detail.
const LEAKS_NOT_CHECKED = `<?xml version="1.0"?>\n<trace-query-result>\n</trace-query-result>\n`;

function leakStacks(api: NativeProfilerSessionApi): Promise<string> {
  return profilerStackQueryTool.execute({ session: api } as never, {
    device_id: DEVICE,
    mode: "leak_stacks",
    top_n: 15,
  });
}

function loadNative(api: NativeProfilerSessionApi): Promise<string> {
  return profilerLoadTool.execute({ session: api } as never, {
    mode: "load_native",
    session_id: SESSION_ID,
    port: PORT,
    device_id: DEVICE,
  });
}

// The .md report analyze writes next to the trace, built separately from the
// inline report.
async function readReportFile(reportFile: string | null): Promise<string> {
  expect(reportFile).not.toBeNull();
  return fs.readFile(reportFile!, "utf8");
}

// Writes a saved iOS session to the debug dir the way stop leaves it on disk.
async function writeSavedIosSession(sessionId: string, leaksXml: string | null): Promise<void> {
  const base = path.join(dir, `native-profiler-${sessionId}`);
  await fs.writeFile(`${base}_raw_cpu.xml`, "");
  await fs.writeFile(`${base}_raw_hangs.xml`, "");
  if (leaksXml !== null) await fs.writeFile(`${base}_raw_leaks.xml`, leaksXml);
}

// Seeds a React session so the combined report has commits to correlate.
async function cacheReactSession(deviceId: string): Promise<void> {
  const commitsPath = path.join(dir, "commits.json");
  const commit = {
    commitIndex: 0,
    timestamp: 1000,
    componentName: "MyComp",
    actualDuration: 500,
    selfDuration: 500,
    commitDuration: 500,
    didRender: true,
    changeDescription: null,
  };
  await fs.writeFile(
    commitsPath,
    JSON.stringify({ commits: [commit], meta: { profileStartWallMs: 1_000_000 } })
  );
  cacheProfilerPaths(
    PORT,
    {
      sessionId: "s",
      debugDir: dir,
      cpuProfilePath: null,
      commitsPath,
      cpuSampleIndexPath: null,
      detectedArchitecture: null,
      anyCompilerOptimized: null,
      hotCommitIndices: [0],
      totalReactCommits: 1,
    },
    deviceId
  );
}

async function freshIosSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: DEVICE, platform: "ios" as const, kind: "simulator" as const };
  const { api } = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return api;
}

async function freshMacSession(): Promise<NativeProfilerSessionApi> {
  const device = {
    id: "macos-app-com.example.app",
    platform: "macos" as const,
    kind: "app" as const,
  };
  const { api } = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return api;
}

async function buildIosSession(leaksFile: string | null): Promise<NativeProfilerSessionApi> {
  const api = await freshIosSession();
  api.traceFile = path.join(dir, "native-profiler-ios.trace");
  // Null cpu/hangs paths short-circuit the missing-file checks; only the leaks
  // export decides whether leaks were recorded.
  const cpu = path.join(dir, "raw_cpu.xml");
  const hangs = path.join(dir, "raw_hangs.xml");
  await fs.writeFile(cpu, "");
  await fs.writeFile(hangs, "");
  api.exportedFiles = { cpu, hangs, leaks: leaksFile };
  return api;
}

const hang: UiHang = {
  type: "ui_hang",
  platform: "ios",
  hangType: "Hang",
  startNs: 1_000_000,
  endNs: 2_000_000,
  durationMs: 1,
  startTimeFormatted: "0:01",
  severity: "RED",
  suspectedFunctions: [],
  appCallChains: [],
};

const leak: MemoryLeak = {
  type: "memory_leak",
  platform: "ios",
  objectType: "ProbeLeakNode",
  count: 200,
  totalSizeBytes: 9600,
  responsibleFrame: "-[ProbeLeaker leak]",
  responsibleLibrary: "ProfProbe",
  attributed: true,
  severity: "RED",
};

describe("iOS reports when no leak data was recorded", () => {
  it("analyze says leaks were not checked instead of all clear", async () => {
    const api = await buildIosSession(null);
    const res = await analyzeNativeProfilerIos(api);

    expect(res.report).toContain(LEAKS_NOT_RECORDED);
    expect(res.report).not.toContain("memory issues detected");
    expect(res.report).toContain("No CPU hotspots or UI hangs detected.");
    // Not an export failure: CPU and hangs were analyzed.
    expect(res.status).toBe("ok");
    expect(res.exportErrors).toEqual({});
    expect(api.parsedData?.leaksRecorded).toBe(false);

    const file = await readReportFile(res.reportFile);
    expect(file).toContain(LEAKS_NOT_RECORDED);
    expect(file).not.toContain("memory issues detected");
  });

  it("analyze keeps the all-clear wording when the leaks table was exported", async () => {
    const leaks = path.join(dir, "raw_leaks.xml");
    await fs.writeFile(leaks, LEAKS_CHECKED_NONE_FOUND);
    const api = await buildIosSession(leaks);
    const res = await analyzeNativeProfilerIos(api);

    expect(res.report).toContain("All clear — no CPU hotspots, UI hangs, or memory issues");
    expect(res.report).not.toContain(LEAKS_NOT_RECORDED);
    expect(api.parsedData?.leaksRecorded).toBe(true);
  });

  it("analyze says leaks were not checked when the leaks export has no Leaks detail", async () => {
    // An all-processes (Time Profiler) recording exported by Xcode 26.6.
    const leaks = path.join(dir, "raw_leaks.xml");
    await fs.writeFile(leaks, LEAKS_NOT_CHECKED);
    const api = await buildIosSession(leaks);
    const res = await analyzeNativeProfilerIos(api);

    expect(api.parsedData?.leaksRecorded).toBe(false);
    expect(res.report).toContain(LEAKS_NOT_RECORDED);
    expect(res.report).not.toContain("memory issues detected");
    expect(res.exportErrors).toEqual({});
    expect(await leakStacks(api)).toContain(LEAKS_NOT_RECORDED);
  });

  it("analyze says leaks were not checked, and why, when xctrace could not capture them", async () => {
    // The Leaks detail with no row, from a recording whose leak checks failed.
    const leaks = path.join(dir, "raw_leaks.xml");
    await fs.writeFile(leaks, LEAKS_CHECKED_NONE_FOUND);
    const api = await buildIosSession(leaks);
    api.leaksCaptureError = "Failed to handshake with LeakAgent (pid: 46018)";
    const res = await analyzeNativeProfilerIos(api);

    expect(api.parsedData?.leaksRecorded).toBe(false);
    expect(res.report).toContain(
      `${LEAKS_NOT_RECORDED} xctrace reported that Instruments could not capture the leak data: ` +
        `Failed to handshake with LeakAgent (pid: 46018). Record again to check for leaks.`
    );
    expect(res.report).not.toContain("memory issues detected");
    expect(res.exportErrors).toEqual({});
    expect(await leakStacks(api)).toContain(LEAKS_NOT_RECORDED);
  });

  it("analyze keeps the leaks that a check found before the leak capture failed", async () => {
    vi.mocked(runIosProfilerPipeline).mockResolvedValueOnce({
      bottlenecks: [],
      cpuSamples: [],
      uiHangs: [],
      cpuHotspots: [],
      memoryLeaks: [leak],
      toolingCpuMs: { argent: 0, instruments: 0 },
      totalCpuMs: 0,
    });
    const leaks = path.join(dir, "raw_leaks.xml");
    await fs.writeFile(leaks, LEAKS_CHECKED_NONE_FOUND);
    const api = await buildIosSession(leaks);
    api.leaksCaptureError = "Failed to handshake with LeakAgent (pid: 46018)";
    const res = await analyzeNativeProfilerIos(api);

    expect(api.parsedData?.leaksRecorded).toBe(true);
    expect(res.report).not.toContain(LEAKS_NOT_RECORDED);
  });

  it("analyze treats a leaks export that vanished before analyze as not recorded", async () => {
    // Stop reported the file, but it is gone by the time analyze runs.
    const api = await buildIosSession(path.join(dir, "raw_leaks.xml"));
    const res = await analyzeNativeProfilerIos(api);

    expect(api.parsedData?.leaksRecorded).toBe(false);
    expect(res.exportErrors.leaks).toContain("no leak data could be analyzed");
    expect(res.report).toContain(LEAKS_NOT_RECORDED);
    expect(res.report).not.toContain("memory issues detected");
  });

  it("the full report flags leaks as not recorded in the header and summary", async () => {
    const payload: ProfilerPayload = {
      metadata: { traceFile: null, platform: "iOS", timestamp: "2026-10-30T00:00:00Z" },
      bottlenecks: [hang],
    };
    const res = await renderNativeProfilerReport({
      payload,
      traceFile: path.join(dir, "native-profiler-ios.trace"),
      leaksRecorded: false,
    });

    expect(res.report).toContain(LEAKS_NOT_RECORDED);
    expect(res.report).toContain("| Memory Leaks | not recorded | — |");

    const file = await readReportFile(res.reportFile);
    expect(file).toContain(LEAKS_NOT_RECORDED);
    expect(file).toContain("| Memory Leaks | not recorded | — |");
  });

  it("leaves reports without the flag (Android) unchanged", async () => {
    const payload: ProfilerPayload = {
      metadata: { traceFile: null, platform: "Android", timestamp: "2026-10-30T00:00:00Z" },
      bottlenecks: [],
    };
    const res = await renderNativeProfilerReport({ payload, traceFile: null });

    expect(res.report).toContain("All clear — no CPU hotspots, UI hangs, or memory issues");
    expect(res.report).not.toContain(LEAKS_NOT_RECORDED);
  });

  it("leak_stacks says leaks were not checked instead of none detected", () => {
    const out = renderLeakStacksIos([], undefined, 10, null, false);
    expect(out).toContain(LEAKS_NOT_RECORDED);
    expect(out).not.toContain("No memory leaks detected");

    expect(renderLeakStacksIos([], undefined, 10, null, true)).toContain(
      "No memory leaks detected"
    );
  });

  it("leak_stacks through the tool reads the flag analyze stored", async () => {
    const notRecorded = await buildIosSession(null);
    await analyzeNativeProfilerIos(notRecorded);
    const out = await leakStacks(notRecorded);
    expect(out).toContain(LEAKS_NOT_RECORDED);
    expect(out).not.toContain("No memory leaks detected");

    const leaks = path.join(dir, "raw_leaks.xml");
    await fs.writeFile(leaks, LEAKS_CHECKED_NONE_FOUND);
    const recorded = await buildIosSession(leaks);
    await analyzeNativeProfilerIos(recorded);
    expect(await leakStacks(recorded)).toContain("No memory leaks detected");
  });

  it("profiler-load of a session with no leaks export says leaks were not recorded", async () => {
    await writeSavedIosSession(SESSION_ID, null);
    const api = await freshIosSession();
    const out = await loadNative(api);

    expect(out).toContain("- Memory leaks: not recorded");
    expect(api.parsedData?.leaksRecorded).toBe(false);
    expect(await leakStacks(api)).toContain(LEAKS_NOT_RECORDED);
  });

  it("profiler-load of a session with a leaks export keeps the leak count", async () => {
    await writeSavedIosSession(SESSION_ID, LEAKS_CHECKED_NONE_FOUND);
    const api = await freshIosSession();
    const out = await loadNative(api);

    expect(out).toContain("- Memory leaks: 0");
    expect(api.parsedData?.leaksRecorded).toBe(true);
    expect(await leakStacks(api)).toContain("No memory leaks detected");
  });

  it.each([
    ["an iOS simulator", freshIosSession],
    ["a Mac app", freshMacSession],
  ])(
    "profiler-load on %s of a leaks export with no Leaks detail says leaks were not recorded",
    async (_name, freshSession) => {
      await writeSavedIosSession(SESSION_ID, LEAKS_NOT_CHECKED);
      const api = await freshSession();
      const out = await loadNative(api);

      expect(out).toContain("- Memory leaks: not recorded");
      expect(api.parsedData?.leaksRecorded).toBe(false);
      expect(await leakStacks(api)).toContain(LEAKS_NOT_RECORDED);
      expect(await leakStacks(api)).not.toContain("No memory leaks detected");
    }
  );

  it("the combined report says leaks were not recorded instead of 0 leaks", async () => {
    await cacheReactSession(DEVICE);

    const api = await buildIosSession(null);
    api.parsedData = {
      cpuSamples: [],
      uiHangs: [hang],
      cpuHotspots: [],
      memoryLeaks: [],
      leaksRecorded: false,
      mallocStackLogging: null,
      customTemplate: null,
      wallClockStartMs: 1_000_000,
    };
    const out = (await profilerCombinedReportTool.execute({ nativeSession: api } as never, {
      port: PORT,
      device_id: DEVICE,
    })) as string;

    expect(out).toContain("**Native Profiler:** 1 hangs, leaks not recorded");
    expect(out).not.toContain("0 leaks");
  });
});

describe("leaks of a Mac app with no CPU sample", () => {
  // A template without Time Profiler, or a CPU export that failed: the CPU export
  // gives no path of a library, so the libraries of the OS are those of this Mac.
  const FOUNDATION_LEAK =
    `<?xml version="1.0"?>\n<trace-query-result>\n` +
    `<node xpath='//trace-toc[1]/run[1]/tracks[1]/track[2]/details[1]/detail[1]'>` +
    `<row leaked-object="NSXPCInterface" size="80" responsible-frame="+[NSXPCInterface interfaceWithProtocol:]" ` +
    `count="3" responsible-library="Foundation" address="0x1"/></node></trace-query-result>\n`;

  /** Foundation is a framework of this "Mac", whatever runs the test; other paths stay real. */
  function foundationOnThisMac() {
    const access = fs.access.bind(fs);
    return vi.spyOn(fs, "access").mockImplementation(async (p, mode) => {
      const file = String(p);
      if (!file.startsWith("/System/Library/")) return access(file, mode);
      if (file === "/System/Library/Frameworks/Foundation.framework") return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  }

  it("analyze and profiler-load rate a leak of Foundation as a leak of a system library", async () => {
    const spy = foundationOnThisMac();
    try {
      const api = await freshMacSession();
      api.traceFile = path.join(dir, "native-profiler-mac.trace");
      const leaks = path.join(dir, "raw_leaks.xml");
      await fs.writeFile(leaks, FOUNDATION_LEAK);
      api.exportedFiles = { cpu: null, hangs: null, leaks };
      const res = await analyzeNativeProfilerIos(api);
      expect(api.parsedData?.memoryLeaks[0]).toMatchObject({
        severity: "YELLOW",
        systemLibrary: true,
      });
      expect(res.report).toContain(
        "**1 leak group(s) from system libraries** (3 object(s); `Foundation`)"
      );

      await writeSavedIosSession(SESSION_ID, FOUNDATION_LEAK);
      const loaded = await freshMacSession();
      await loadNative(loaded);
      expect(loaded.parsedData?.memoryLeaks[0]).toMatchObject({
        severity: "YELLOW",
        systemLibrary: true,
      });

      // An iOS app: the frameworks of this Mac are not those of the simulator runtime.
      const ios = await freshIosSession();
      await loadNative(ios);
      expect(ios.parsedData?.memoryLeaks[0]).toMatchObject({ severity: "RED" });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a `(null)` leak of a recording with the bundled template", () => {
  // The bundled template has the Allocations instrument, so a `(null)` frame does not mean
  // that the template has none. Measured: a malloc_stack_logging recording on iOS whose only
  // unattributed group was one `(null)` "Malloc 32 Bytes".
  const NULL_LEAK =
    `<?xml version="1.0"?>\n<trace-query-result>\n` +
    `<node xpath='//trace-toc[1]/run[1]/tracks[1]/track[2]/details[1]/detail[1]'>` +
    `<row leaked-object="Malloc 32 Bytes" size="32" responsible-frame="(null)" count="1" ` +
    `responsible-library="(null)" address="0x1"/></node></trace-query-result>\n`;

  it("gets the usual note in analyze and leak_stacks, and the template is frozen with the data", async () => {
    const leaks = path.join(dir, "raw_leaks.xml");
    await fs.writeFile(leaks, NULL_LEAK);
    for (const customTemplate of [false, true]) {
      const api = await buildIosSession(leaks);
      api.mallocStackLogging = true;
      api.customTemplate = customTemplate;
      const res = await analyzeNativeProfilerIos(api);
      expect(api.parsedData?.customTemplate).toBe(customTemplate);
      // A later stop must not re-label the data that analyze parsed.
      api.customTemplate = !customTemplate;
      for (const text of [res.report, await leakStacks(api)]) {
        if (customTemplate) expect(text).toContain("no Allocations instrument");
        else expect(text).not.toContain("no Allocations instrument");
      }
    }
  });
});

describe("Android reports no leak data", () => {
  it("the combined report says leaks were not recorded instead of 0 leaks", async () => {
    await cacheReactSession(ANDROID_DEVICE);
    vi.mocked(loadAndroidCombinedData).mockResolvedValue({
      uiHangs: [{ ...hang, platform: "android", hangType: "jank" }],
    });

    const device = { id: ANDROID_DEVICE, platform: "android" as const, kind: "emulator" as const };
    const { api } = await nativeProfilerSessionBlueprint.factory({}, device, { device });
    const pftrace = path.join(dir, "native-profiler-android.pftrace");
    api.traceFile = pftrace;
    api.exportedFiles = { pftrace };
    api.appProcess = "com.example.app";
    api.wallClockStartMs = 1_000_000;

    const out = (await profilerCombinedReportTool.execute({ nativeSession: api } as never, {
      port: PORT,
      device_id: ANDROID_DEVICE,
    })) as string;

    expect(out).toContain("**Native Profiler:** 1 hangs, leaks not recorded");
    expect(out).not.toContain("0 leaks");
  });
});
