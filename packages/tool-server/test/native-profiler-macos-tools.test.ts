/**
 * The native profiler tools on a native Mac app id, through the HTTP entry
 * point: the capability gate, the NativeProfilerSession factory, and the
 * xctrace branch of start, stop, analyze and profiler-stack-query. The process
 * boundaries are faked: the xctrace spawn and its readiness, the export, and
 * argent's record of the apps it started.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, FAILURE_CODES, getFailureSignal, Registry } from "@argent/registry";

class FakeXctrace extends EventEmitter {
  pid = 6262;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    queueMicrotask(() => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = signal;
      this.emit("exit", null, signal);
    });
    return true;
  });
}

const debugDir = vi.hoisted(() => ({ path: "" }));

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: vi.fn(() => new FakeXctrace()),
}));
vi.mock("../src/utils/react-profiler/debug/dump", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/react-profiler/debug/dump")>()),
  getDebugDir: vi.fn(async () => debugDir.path),
}));
vi.mock("../src/utils/ios-profiler/notify", () => ({
  listenForDarwinNotification: vi.fn(() => {
    throw new Error("notifyutil unavailable in this test");
  }),
}));
vi.mock("../src/utils/ios-profiler/startup", () => ({
  waitForXctraceReady: vi.fn(async () => ({ stderrBuffer: "" })),
}));
vi.mock("../src/utils/ios-profiler/export", () => ({
  exportIosTraceData: vi.fn(),
}));
vi.mock("../src/utils/macos-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/macos-apps")>()),
  runningTrackedApp: vi.fn(async () => undefined),
  getTrackedMacosApp: vi.fn(() => undefined),
  // Unread, as when codesign is missing: the start records.
  readCodeSignature: vi.fn(async () => null),
}));
// The helper that watches the app's suspensions: a stand-in, as spawn is the fake xctrace.
vi.mock("@argent/native-devtools-ios", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/native-devtools-ios")>()),
  macosArtifacts: () => ({
    bootstrap: "/stand-in/libArgentInjectionBootstrap.dylib",
    library: "/stand-in/libNativeDevtoolsMacos.dylib",
    helper: "/stand-in/argent-macos-helper",
  }),
}));
vi.mock("../src/utils/macos-suspension-watch", () => ({
  startSuspensionWatch: vi.fn(async () => null),
}));
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps: vi.fn(async () => {}),
  ensureDep: vi.fn(async () => {}),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell: vi.fn(async () => ""),
}));

import { spawn } from "child_process";
import { createHttpApp } from "../src/http";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../src/blueprints/native-profiler-session";
import { macosAppBlueprint } from "../src/blueprints/macos-app";
import { nativeProfilerStartTool } from "../src/tools/profiler/native-profiler/native-profiler-start";
import { nativeProfilerStopTool } from "../src/tools/profiler/native-profiler/native-profiler-stop";
import { nativeProfilerAnalyzeTool } from "../src/tools/profiler/native-profiler/native-profiler-analyze";
import { profilerStackQueryTool } from "../src/tools/profiler/query/profiler-stack-query";
import { profilerLoadTool } from "../src/tools/profiler/query/profiler-load";
import { resolveDevice } from "../src/utils/device-info";
import { exportIosTraceData } from "../src/utils/ios-profiler/export";
import { UNATTRIBUTED_WITHOUT_MALLOC_LOGGING } from "../src/utils/ios-profiler/render";
import { getTrackedMacosApp, runningTrackedApp } from "../src/utils/macos-apps";
import { ensureDeps } from "../src/utils/check-deps";
import { adbShell } from "../src/utils/adb";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";
import { startSuspensionWatch } from "../src/utils/macos-suspension-watch";

const flag = useMacosAppsFlag();

const BUNDLE_ID = "com.example.profiledtools";
const MAC = `macos-app-${BUNDLE_ID}`;
const FLAG_MESSAGE = "the macos-apps flag is off. Run: argent enable macos-apps";
const EXECUTABLE = "/Applications/Example.app/Contents/MacOS/ExampleExec";

type TrackedMacosApp = NonNullable<ReturnType<typeof getTrackedMacosApp>>;

const tracked: TrackedMacosApp = {
  bundleId: BUNDLE_ID,
  appPath: "/Applications/Example.app",
  executable: EXECUTABLE,
  name: "Example",
  // A live process: the stop checks that the app it attached to still runs.
  pid: process.pid,
  sandboxed: false,
  userSelectedReadOnly: false,
  listenSocket: null,
  logPath: "/tmp/example.log",
  args: [],
  startedAt: 0,
};

let registry: Registry;
let http: ReturnType<typeof createHttpApp>["app"];

beforeEach(() => {
  debugDir.path = mkdtempSync(join(tmpdir(), "argent-macos-profiler-"));
  vi.mocked(spawn).mockClear();
  vi.mocked(ensureDeps).mockClear();
  vi.mocked(adbShell).mockClear();
  vi.mocked(exportIosTraceData).mockReset();
  vi.mocked(runningTrackedApp).mockReset();
  vi.mocked(runningTrackedApp).mockResolvedValue(undefined);
  vi.mocked(getTrackedMacosApp).mockReset();
  vi.mocked(getTrackedMacosApp).mockReturnValue(undefined);
  registry = new Registry();
  registry.registerBlueprint(nativeProfilerSessionBlueprint);
  registry.registerBlueprint(macosAppBlueprint);
  registry.registerTool(nativeProfilerStartTool);
  registry.registerTool(nativeProfilerStopTool);
  registry.registerTool(nativeProfilerAnalyzeTool);
  registry.registerTool(profilerStackQueryTool);
  registry.registerTool(profilerLoadTool);
  http = createHttpApp(registry).app;
});

afterEach(async () => {
  await registry.dispose();
  rmSync(debugDir.path, { recursive: true, force: true });
});

function call(tool: string, body: Record<string, unknown>) {
  return request(http).post(`/tools/${tool}`).send(body);
}

/** The session the HTTP calls above used for the Mac app. */
function macSession(): Promise<NativeProfilerSessionApi> {
  const device = resolveDevice(MAC);
  return registry.resolveService<NativeProfilerSessionApi>(
    nativeProfilerSessionBlueprint.getURN(device),
    { device }
  );
}

describe("the native profiler tools on a Mac app id", () => {
  it("with the flag on, pass the capability gate and reach the xctrace branch", async () => {
    // No app is running and nothing was recorded, so each tool answers with
    // its own state error instead of the gate's 400.
    const cases = [
      ["native-profiler-start", {}, FAILURE_CODES.NATIVE_PROFILER_NO_RUNNING_APPS],
      ["native-profiler-stop", {}, FAILURE_CODES.NATIVE_PROFILER_NO_ACTIVE_SESSION],
      ["native-profiler-analyze", {}, FAILURE_CODES.NATIVE_PROFILER_NO_EXPORTED_TRACE],
      [
        "profiler-stack-query",
        { mode: "thread_breakdown" },
        FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
      ],
    ] as const;
    for (const [tool, extra, code] of cases) {
      const res = await call(tool, { device_id: MAC, ...extra });
      expect({ tool, code: res.body.error_code }).toEqual({ tool, code });
    }
    // Start, stop and analyze checked for xctrace, never for adb.
    expect(vi.mocked(ensureDeps).mock.calls).toEqual([[["xcrun"]], [["xcrun"]], [["xcrun"]]]);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("with the flag off, are refused by the gate with the flag message", async () => {
    flag.off();
    for (const tool of [
      "native-profiler-start",
      "native-profiler-stop",
      "native-profiler-analyze",
      "profiler-stack-query",
    ]) {
      const res = await call(tool, { device_id: MAC, mode: "thread_breakdown" });
      expect({ tool, status: res.status }).toEqual({ tool, status: 400 });
      expect(res.body.error).toContain(FLAG_MESSAGE);
    }
    expect(vi.mocked(ensureDeps)).not.toHaveBeenCalled();
  });

  it("record, export, analyze and drill into a Mac app's profile", async () => {
    vi.mocked(runningTrackedApp).mockResolvedValue(tracked);
    vi.mocked(getTrackedMacosApp).mockReturnValue(tracked);
    const files = writeExports(debugDir.path);
    vi.mocked(exportIosTraceData).mockResolvedValue({
      files,
      diagnostics: { tocSchemas: ["time-profile"], cpuSchemaUsed: "time-profile", errors: {} },
    } as never);

    const started = await call("native-profiler-start", {
      device_id: MAC,
      template_path: "/tmp/Custom.tracetemplate",
    });
    expect(started.body.data).toMatchObject({ status: "recording", pid: 6262 });
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args.slice(0, 5)).toEqual([
      "record",
      "--template",
      "/tmp/Custom.tracetemplate",
      "--attach",
      String(process.pid),
    ]);
    expect(args).not.toContain("--device");

    const stopped = await call("native-profiler-stop", { device_id: MAC });
    expect(stopped.status).toBe(200);
    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledWith(started.body.data.traceFile, false);
    expect(stopped.body.data.exportedFiles.cpu).toMatchObject({ kind: "native-profile-cpu" });
    expect(stopped.body.data.warning).toBeUndefined();

    const analyzed = await call("native-profiler-analyze", { device_id: MAC });
    expect(analyzed.status).toBe(200);
    const report: string = analyzed.body.data.report;
    expect(report).toContain("# macOS Instruments Analysis");
    expect(report).toContain("**Platform:** macOS");
    // 3 of the 10 ms were argent's library, 1 ms the Instruments recorder.
    expect(report).toContain("**CPU sampling:** Of the CPU samples, 3 ms (30%) were argent's own");
    expect(report).toContain("1 ms (10%) were the recorder that Instruments loads");
    expect(report).toContain("`SomeLibraryFunction` (argent's own library)");

    const parsed = (await macSession()).parsedData!;
    expect(parsed.cpuHotspots.map((h) => h.dominantFunction)).toEqual([
      "-[ExampleView layoutSubtreeIfNeeded]",
    ]);
    // The hotspots leave the tools out; the drill-down keeps every sample.
    expect(parsed.cpuSamples).toHaveLength(10);
    // The data keeps the plain name, which the drill-down matches; only the report labels it.
    expect(parsed.uiHangs[0]!.suspectedFunctions).toEqual(["SomeLibraryFunction"]);
    expect(parsed.uiHangs[0]!.toolingLabels).toEqual({
      SomeLibraryFunction: "argent's own library",
    });

    const stacks = await call("profiler-stack-query", {
      device_id: MAC,
      mode: "hang_stacks",
      hang_index: 0,
    });
    expect(stacks.status).toBe(200);
    expect(stacks.body.data).toContain("### Full Stack Samples");
    expect(stacks.body.data).toMatch(/\(\d+×\).*SomeLibraryFunction/);

    // The name the report lists is the one function_callers takes.
    const callers = await call("profiler-stack-query", {
      device_id: MAC,
      mode: "function_callers",
      function_name: "SomeLibraryFunction",
    });
    expect(callers.status).toBe(200);
    expect(callers.body.data).not.toContain("not found");

    // Without malloc stack logging, a Mac app's attributed leak does not prove it was on.
    expect(report).toContain(UNATTRIBUTED_WITHOUT_MALLOC_LOGGING);
    const leaks = await call("profiler-stack-query", { device_id: MAC, mode: "leak_stacks" });
    expect(leaks.status).toBe(200);
    expect(leaks.body.data).toContain("`ExampleNode`");
    expect(leaks.body.data).toContain(UNATTRIBUTED_WITHOUT_MALLOC_LOGGING);
    expect(leaks.body.data).not.toContain("malloc stack logging was active");
  });
});

describe("the app's suspensions during a recording", () => {
  it("are watched from the start, ended after xctrace, and put on the trace's timeline", async () => {
    vi.mocked(runningTrackedApp).mockResolvedValue(tracked);
    vi.mocked(getTrackedMacosApp).mockReturnValue(tracked);
    const traceStartMs = Date.now();
    const order: string[] = [];
    const end = vi.fn(() => {
      order.push("end");
      return [
        // Before the trace: left out.
        { startMs: traceStartMs - 3_000, endMs: traceStartMs - 1_000 },
        { startMs: traceStartMs + 1_000, endMs: traceStartMs + 3_500 },
      ];
    });
    vi.mocked(startSuspensionWatch).mockResolvedValueOnce({
      pid: process.pid,
      suspendedSince: () => null,
      suspendedMsBetween: () => 0,
      waitUntilRunning: async () => true,
      end,
    });
    vi.mocked(exportIosTraceData).mockImplementation(async () => {
      order.push("export");
      return {
        files: writeExports(debugDir.path),
        // The trace ends 3 s after its start: the second window is cut there.
        diagnostics: {
          tocSchemas: [],
          cpuSchemaUsed: null,
          errors: {},
          traceStartMs,
          traceDurationMs: 3_000,
        },
      } as never;
    });

    expect((await call("native-profiler-start", { device_id: MAC })).status).toBe(200);
    expect(vi.mocked(startSuspensionWatch)).toHaveBeenCalledWith(
      "/stand-in/argent-macos-helper",
      process.pid
    );
    // Watched from before the spawn of xctrace, whose attach suspends the app too.
    expect(vi.mocked(startSuspensionWatch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawn).mock.invocationCallOrder[0]!
    );
    const session = await macSession();
    expect(session.suspensionWatch).not.toBeNull();
    expect(end).not.toHaveBeenCalled();

    expect((await call("native-profiler-stop", { device_id: MAC })).status).toBe(200);
    expect(order).toEqual(["end", "export"]);
    expect(session.suspensionWatch).toBeNull();
    expect(session.appSuspensions).toEqual([{ startNs: 1_000_000_000, endNs: 3_000_000_000 }]);
  });

  it("are unknown when nothing watched or the trace's start is unknown", async () => {
    vi.mocked(runningTrackedApp).mockResolvedValue(tracked);
    vi.mocked(getTrackedMacosApp).mockReturnValue(tracked);
    vi.mocked(exportIosTraceData).mockResolvedValue({
      files: writeExports(debugDir.path),
      diagnostics: { tocSchemas: [], cpuSchemaUsed: null, errors: {} },
    } as never);
    const session = await macSession();

    // The helper cannot watch (startSuspensionWatch resolves null).
    expect((await call("native-profiler-start", { device_id: MAC })).status).toBe(200);
    expect(session.suspensionWatch).toBeNull();
    expect((await call("native-profiler-stop", { device_id: MAC })).status).toBe(200);
    expect(session.appSuspensions).toBeNull();

    // Watched, but the export found no start date.
    const end = vi.fn(() => [{ startMs: 1, endMs: 2 }]);
    vi.mocked(startSuspensionWatch).mockResolvedValueOnce({
      pid: process.pid,
      suspendedSince: () => null,
      suspendedMsBetween: () => 0,
      waitUntilRunning: async () => true,
      end,
    });
    expect((await call("native-profiler-start", { device_id: MAC })).status).toBe(200);
    expect((await call("native-profiler-stop", { device_id: MAC })).status).toBe(200);
    expect(end).toHaveBeenCalledTimes(1);
    expect(session.appSuspensions).toBeNull();
  });
});

describe("an app that ended during the recording", () => {
  it("makes the stop warn and the report say so at the top", async () => {
    // macOS pids stay below 100000, so no process has this one.
    const gone = { ...tracked, pid: 999_999 };
    vi.mocked(runningTrackedApp).mockResolvedValue(gone);
    vi.mocked(getTrackedMacosApp).mockReturnValue(gone);
    vi.mocked(exportIosTraceData).mockResolvedValue({
      files: writeExports(debugDir.path),
      diagnostics: { tocSchemas: ["time-profile"], cpuSchemaUsed: "time-profile", errors: {} },
    } as never);

    expect((await call("native-profiler-start", { device_id: MAC })).status).toBe(200);
    const stopped = await call("native-profiler-stop", { device_id: MAC });
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.warning).toContain(
      "The app quit, crashed or was restarted during the recording"
    );

    const analyzed = await call("native-profiler-analyze", { device_id: MAC });
    const report: string = analyzed.body.data.report;
    expect(report).toContain("**The app ended during the recording:**");
    // At the top, before the findings.
    expect(report.indexOf("The app ended during the recording")).toBeLessThan(
      report.indexOf("**CPU sampling:**")
    );
  });

  it("is not reported when the app still runs", async () => {
    vi.mocked(runningTrackedApp).mockResolvedValue(tracked);
    vi.mocked(getTrackedMacosApp).mockReturnValue(tracked);
    vi.mocked(exportIosTraceData).mockResolvedValue({
      files: writeExports(debugDir.path),
      diagnostics: { tocSchemas: ["time-profile"], cpuSchemaUsed: "time-profile", errors: {} },
    } as never);

    await call("native-profiler-start", { device_id: MAC });
    await call("native-profiler-stop", { device_id: MAC });
    const analyzed = await call("native-profiler-analyze", { device_id: MAC });
    expect(analyzed.body.data.report).not.toContain("The app ended during the recording");
  });
});

describe("profiler-load on a Mac app id", () => {
  const SESSION_ID = "20261112-120000";

  it("with the flag on, lists the saved sessions and restores a Mac app's xctrace session, which analyze reports as macOS", async () => {
    // What native-profiler-stop leaves in the debug directory.
    writeExports(debugDir.path, `native-profiler-${SESSION_ID}_raw_`);

    const listed = await call("profiler-load", { mode: "list", device_id: MAC });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toContain(`\`${SESSION_ID}\``);
    // As a stop of an earlier recording leaves them.
    (await macSession()).appSuspensions = [{ startNs: 0, endNs: 1_000_000_000 }];

    const loaded = await call("profiler-load", {
      mode: "load_native",
      session_id: SESSION_ID,
      device_id: MAC,
    });
    expect(loaded.status).toBe(200);
    expect(loaded.body.data).toContain(`Loaded native profiler session \`${SESSION_ID}\`.`);
    expect(loaded.body.data).toContain("- CPU samples: 10");
    expect(loaded.body.data).toContain("- UI hangs: 1");
    const api = await macSession();
    expect(api.platform).toBe("macos");
    // A loaded trace has no record of the app's suspensions.
    expect(api.appSuspensions).toBeNull();
    expect(api.exportedFiles).toEqual({
      cpu: join(debugDir.path, `native-profiler-${SESSION_ID}_raw_cpu.xml`),
      hangs: join(debugDir.path, `native-profiler-${SESSION_ID}_raw_hangs.xml`),
      leaks: join(debugDir.path, `native-profiler-${SESSION_ID}_raw_leaks.xml`),
    });

    const analyzed = await call("native-profiler-analyze", { device_id: MAC });
    expect(analyzed.status).toBe(200);
    expect(analyzed.body.data.report).toMatch(/^# macOS Instruments Analysis\n/);
    expect(analyzed.body.data.report).toContain("3 ms (30%) were argent's own work");
    expect(vi.mocked(ensureDeps).mock.calls).toEqual([[["xcrun"]]]);
  });

  it("does not take an Android .pftrace for a Mac app's session", async () => {
    writeFileSync(join(debugDir.path, `native-profiler-${SESSION_ID}.pftrace`), "");

    const res = await call("profiler-load", {
      mode: "load_native",
      session_id: SESSION_ID,
      device_id: MAC,
    });

    expect(res.body.error_code).toBe(FAILURE_CODES.PROFILER_NATIVE_TRACE_MISSING);
    expect(res.body.error).toContain(`native-profiler-${SESSION_ID}_raw_*.xml`);
  });

  it("refuses load_react for a Mac app, which has no React profiler sessions", async () => {
    const res = await call("profiler-load", {
      mode: "load_react",
      session_id: SESSION_ID,
      device_id: MAC,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("A Mac app has no React profiler sessions");
    expect(res.body.error).toContain("load_native");
  });

  it("with the flag off, is refused by the gate with the flag message", async () => {
    writeExports(debugDir.path, `native-profiler-${SESSION_ID}_raw_`);
    flag.off();
    for (const mode of ["list", "load_native"]) {
      const res = await call("profiler-load", { mode, session_id: SESSION_ID, device_id: MAC });
      expect({ mode, status: res.status }).toEqual({ mode, status: 400 });
      expect(res.body.error).toContain(FLAG_MESSAGE);
    }
  });
});

describe("a Mac app's NativeProfilerSession", () => {
  it("is made for a Mac app and still refused for a Chromium app", async () => {
    const mac = resolveDevice(MAC);
    const instance = await nativeProfilerSessionBlueprint.factory({}, mac, {
      device: mac,
    } as never);
    expect(instance.api.platform).toBe("macos");
    await instance.dispose();

    const chromium = resolveDevice("chromium-cdp-9222");
    const err = await nativeProfilerSessionBlueprint
      .factory({}, chromium, { device: chromium } as never)
      .catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_PROFILER_WRONG_PLATFORM);
  });

  it("a teardown SIGKILLs its xctrace and never reaches for adb", async () => {
    const mac = resolveDevice(MAC);
    const instance = await nativeProfilerSessionBlueprint.factory({}, mac, {
      device: mac,
    } as never);
    const child = new FakeXctrace();
    instance.api.captureProcess = child as unknown as ChildProcess;
    instance.api.capturePid = child.pid;
    instance.api.profilingActive = true;

    await instance.dispose();

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(instance.api.captureProcess).toBeNull();
    expect(vi.mocked(adbShell)).not.toHaveBeenCalled();
  });

  it("a stop after xctrace exited on its own names the Mac causes", async () => {
    const mac = resolveDevice(MAC);
    const instance = await nativeProfilerSessionBlueprint.factory({}, mac, {
      device: mac,
    } as never);
    const api = instance.api;
    api.traceFile = join(debugDir.path, "native-profiler-20260101-000000.trace");
    api.recordingExitedUnexpectedly = true;
    api.lastExitInfo = { code: null, signal: "SIGKILL" };
    vi.mocked(exportIosTraceData).mockResolvedValue({
      files: { cpu: null, hangs: null, leaks: null },
      diagnostics: { tocSchemas: [], cpuSchemaUsed: null, errors: {} },
    } as never);

    const result = await nativeProfilerStopTool.execute(
      { session: api },
      { device_id: MAC },
      { artifacts: new ArtifactStore() }
    );

    expect(result.warning).toContain("xctrace exited before stop was called");
    expect(result.warning).toContain(
      "restart-app or launch-app started the app again, or xctrace was ended from outside"
    );
    expect(result.warning).not.toContain("simulator");
    await instance.dispose();
  });
});

/**
 * An xctrace export of 10 one-millisecond main-thread samples: 6 in the app's
 * own code, 3 in argent's library (under a system leaf frame, as when the
 * library calls into AppKit, and called from the run loop), and 1 in the
 * recorder Instruments loads. A hang
 * covers the argent samples. `prefix` names the files, as stop names a saved session's.
 */
function writeExports(dir: string, prefix = ""): { cpu: string; hangs: string; leaks: string } {
  const thread = `<thread fmt="Main Thread 0x1 (ExampleExec, pid: 4321)"></thread>`;
  const row = (timeNs: number, backtrace: string) =>
    `<row><sample-time>${timeNs}</sample-time>${thread}<weight>1000000</weight>${backtrace}</row>`;
  const bin = (id: number, name: string, path: string) =>
    `<binary id="${id}" name="${name}" arch="arm64" load-addr="0x100000000" path="${path}"/>`;
  const appBacktrace =
    `<backtrace id="1">` +
    `<frame id="2" name="-[ExampleView layoutSubtreeIfNeeded]" addr="0x1">${bin(3, "ExampleExec", EXECUTABLE)}</frame>` +
    `<frame id="4" name="main" addr="0x2"><binary ref="3"/></frame>` +
    `</backtrace>`;
  const argentBacktrace =
    `<backtrace id="5">` +
    `<frame id="6" name="objc_msgSend" addr="0x3">${bin(7, "libobjc.A.dylib", "/usr/lib/libobjc.A.dylib")}</frame>` +
    `<frame id="8" name="SomeLibraryFunction" addr="0x4">${bin(9, "libNativeDevtoolsMacos.dylib", "/Users/dev/.argent/macos/lib/0123456789abcdef/libNativeDevtoolsMacos.dylib")}</frame>` +
    `<frame id="13" name="__CFRUNLOOP_IS_CALLING_OUT_TO_A_BLOCK__" addr="0x6">${bin(14, "CoreFoundation", "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation")}</frame>` +
    `<frame ref="4"/>` +
    `</backtrace>`;
  const recorderBacktrace =
    `<backtrace id="10">` +
    `<frame id="11" name="SomeRecorderFunction" addr="0x5">${bin(12, "liboainject.dylib", "/Applications/Xcode.app/Contents/SharedFrameworks/DVTInstrumentsFoundation.framework/Versions/A/Resources/liboainject.dylib")}</frame>` +
    `<frame ref="4"/>` +
    `</backtrace>`;
  const rows = [
    row(1_000_000, appBacktrace),
    ...[2, 3, 4, 5, 6].map((ms) => row(ms * 1_000_000, `<backtrace ref="1"/>`)),
    row(100_000_000, argentBacktrace),
    row(101_000_000, `<backtrace ref="5"/>`),
    row(102_000_000, `<backtrace ref="5"/>`),
    row(200_000_000, recorderBacktrace),
  ];
  const files = {
    cpu: join(dir, `${prefix}cpu.xml`),
    hangs: join(dir, `${prefix}hangs.xml`),
    leaks: join(dir, `${prefix}leaks.xml`),
  };
  writeFileSync(
    files.cpu,
    `<trace-query-result><node>${rows.join("")}</node></trace-query-result>`
  );
  writeFileSync(
    files.hangs,
    `<trace-query-result><node><row><start-time>99000000</start-time><duration>5000000</duration>` +
      `<hang-type>Hang</hang-type><thread fmt="Main Thread"></thread></row></node></trace-query-result>`
  );
  // A Mac app's plain capture: the object allocated after the start has a backtrace, the older one not.
  writeFileSync(
    files.leaks,
    `<trace-query-result><node>` +
      `<row leaked-object="ExampleNode" size="32" responsible-frame="swift::swift_slowAllocTyped(unsigned long, unsigned long, unsigned long long)" count="1" responsible-library="libswiftCore.dylib" address="0x77b3cdd680"/>` +
      `<row leaked-object="Malloc 32 Bytes" size="32" responsible-frame="&lt;Call stack limit reached&gt;" count="1" responsible-library="" address="0x7382020060"/>` +
      `</node></trace-query-result>`
  );
  return files;
}
