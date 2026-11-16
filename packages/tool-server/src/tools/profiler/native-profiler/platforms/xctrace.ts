import { execFile, spawn, type ChildProcess } from "child_process";
import { promises as fsp } from "node:fs";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { existsSync } from "node:fs";
import * as path from "path";
import type { NativeProfilerSessionApi } from "../../../../blueprints/native-profiler-session";
import { takeReapedSession } from "../../../../utils/reaped-sessions";
import { getDebugDir } from "../../../../utils/react-profiler/debug/dump";
import { startOldProfilerSessionCleanup } from "../../../../utils/profiler-shared/session-retention";
import {
  listenForDarwinNotification,
  type NotifyHandle,
} from "../../../../utils/ios-profiler/notify";
import { waitForXctraceReady } from "../../../../utils/ios-profiler/startup";
import { RECORDING_CAP_MS } from "../../../../utils/profiler-shared/types";

// The `xctrace record` lifecycle that iOS simulators and Mac apps share: what
// differs per platform is only how the target is found and the record arguments.

// Two candidates because __dirname differs by build: bundled it is argent/dist/
// (template copied to argent/assets/); in dev it is
// tool-server/dist/tools/profiler/native-profiler/platforms/, four levels below
// dist/, where the build copies the template to utils/ios-profiler/.
export function resolveDefaultTemplatePath(): string {
  const candidates = [
    path.resolve(__dirname, "..", "assets", "Argent.tracetemplate"),
    path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "utils",
      "ios-profiler",
      "Argent.tracetemplate"
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new FailureError(
    `Argent.tracetemplate not found. Looked in:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
      `Pass template_path explicitly, or rebuild so the template is copied into place.`,
    {
      // A missing bundled asset is a packaging/build problem, not a device or
      // subprocess failure.
      error_code: FAILURE_CODES.NATIVE_PROFILER_TRACE_TEMPLATE_MISSING,
      failure_stage: "ios_native_profiler_template_resolve",
      failure_area: "tool_server",
      error_kind: "dependency_missing",
    }
  );
}

const STARTUP_TIMEOUT_MS = 10_000;
const NOTIFY_REGISTER_TIMEOUT_MS = 2_000;

/**
 * Waits for a native-profiler-stop that is still exporting: until it ends, the
 * session pairs the previous recording's exports with the new trace. A failed
 * stop is that stop's caller's error; the session state says the rest.
 */
export async function waitForStop(api: NativeProfilerSessionApi): Promise<void> {
  await api.stopInProgress?.catch(() => undefined);
}

export function assertNoCaptureRunning(api: NativeProfilerSessionApi): void {
  if (api.profilingActive) {
    throw new FailureError(
      `A native profiling session is already running (PID: ${api.capturePid}).`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_SESSION_ALREADY_RUNNING,
        failure_stage: "native_profiler_start_session_state",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
}

/** A new `.trace` path in the debug directory, which getDebugDir creates. */
export async function newTraceOutputPath(): Promise<string> {
  const debugDir = await getDebugDir();
  startOldProfilerSessionCleanup(debugDir);
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
    .slice(0, 15);
  return path.join(debugDir, `native-profiler-${timestamp}.trace`);
}

async function registerStartupNotify(name: string): Promise<NotifyHandle | null> {
  let handle: NotifyHandle;
  try {
    handle = listenForDarwinNotification(name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[native-profiler] failed to spawn notifyutil (${msg}); falling back to stdout substring match.\n`
    );
    return null;
  }

  const ready = await Promise.race([
    handle.ready.then(() => true as const),
    new Promise<false>((r) => setTimeout(() => r(false), NOTIFY_REGISTER_TIMEOUT_MS)),
  ]);
  if (ready) return handle;

  handle.cancel();
  process.stderr.write(
    `[native-profiler] notifyutil did not register within ${NOTIFY_REGISTER_TIMEOUT_MS} ms; ` +
      `falling back to stdout substring match.\n`
  );
  return null;
}

// Per-capture descriptors (appProcess, traceFile, cpuFilterPid, capture mode) are
// stamped only after a SUCCESSFUL start, so a failed attempt has nothing to reset
// beyond the spawned process handles.
function resetStartState(api: NativeProfilerSessionApi): void {
  api.capturePid = null;
  api.captureProcess = null;
}

export function handleXctraceExit(
  api: NativeProfilerSessionApi,
  code: number | null,
  signal: string | null
): void {
  if (!api.profilingActive) return;
  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }
  api.capturePid = null;
  api.captureProcess = null;
  api.profilingActive = false;
  if (!api.recordingTimedOut) {
    api.recordingExitedUnexpectedly = true;
  }
  api.lastExitInfo = { code, signal };
  // Now, not at the stop: an app that quits after the recording did not quit during it.
  api.recordingAppEnded = appEnded(api);
}

/** Whether the Mac app the recording attached to is gone: false when there was none. */
export function appEnded(api: NativeProfilerSessionApi): boolean {
  if (api.recordingAppPid === null) return false;
  try {
    process.kill(api.recordingAppPid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** The end of each recording's xctrace output: the run issues come last. */
const outputTails = new WeakMap<ChildProcess, { text: string }>();
const OUTPUT_TAIL_CHARS = 16_384;

function keepOutputTail(child: ChildProcess): void {
  const tail = { text: "" };
  const add = (data: Buffer) => {
    tail.text = (tail.text + data.toString()).slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout?.on("data", add);
  child.stderr?.on("data", add);
  outputTails.set(child, tail);
}

/** The last 16 KB that xctrace printed, stdout and stderr together. */
export function xctraceOutput(child: ChildProcess): string {
  return outputTails.get(child)?.text ?? "";
}

/**
 * The `[Error]` lines that xctrace printed under "Run issues were detected" when
 * the recording ended, in order and without the marker.
 */
export function xctraceRunErrors(child: ChildProcess): string[] {
  const text = xctraceOutput(child);
  return [...text.matchAll(/^\s*\* \[Error\] (.+?)\s*$/gm)].map((m) => m[1]);
}

/**
 * Spawns `xctrace` with the arguments `buildArgs` returns and waits until it
 * records. `notifyName` is the Darwin notification to pass as
 * `--notify-tracing-started`, or undefined when notifyutil is unavailable and
 * readiness falls back to xctrace's stdout.
 */
export async function spawnXctraceRecording(
  api: NativeProfilerSessionApi,
  buildArgs: (notifyName: string | undefined) => string[]
): Promise<{ child: ChildProcess; pid: number }> {
  const notifyName = `com.argent.ios-profiler.started.${process.pid}.${Date.now()}`;
  const notify = await registerStartupNotify(notifyName);

  const xctraceProcess = spawn("xctrace", buildArgs(notify ? notifyName : undefined), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  keepOutputTail(xctraceProcess);
  api.capturePid = xctraceProcess.pid ?? null;
  api.captureProcess = xctraceProcess;

  try {
    await waitForXctraceReady(xctraceProcess, { notify, timeoutMs: STARTUP_TIMEOUT_MS });
  } catch (err) {
    resetStartState(api);
    throw err;
  }

  if (!xctraceProcess.pid) {
    try {
      xctraceProcess.kill("SIGKILL");
    } catch {
      // already dead
    }
    resetStartState(api);
    throw new FailureError("xctrace process has no pid; cannot resolve start.", {
      error_code: FAILURE_CODES.NATIVE_PROFILER_XCTRACE_NO_PID,
      failure_stage: "native_profiler_xctrace_start",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "xctrace",
    });
  }

  return { child: xctraceProcess, pid: xctraceProcess.pid };
}

/** How long a Mac app's xctrace may take to end after the recording cap's SIGINT. */
const CAPPED_XCTRACE_KILL_MS = 120_000;

export interface XctraceCapture {
  appProcess: string;
  traceFile: string;
  mallocStackLogging: boolean;
  /** The PID to keep CPU samples of, for a host-wide capture; null when xctrace scoped it. */
  cpuFilterPid: number | null;
  /** The app process xctrace attached to, when the stop should check that it still runs. */
  appPid?: number;
}

/**
 * Makes a started recording the session's capture: the per-capture fields, the
 * 10-minute cap and the exit handler. Reaps the recording instead when a
 * teardown destroyed the session while xctrace was starting.
 */
export function commitXctraceRecording(
  api: NativeProfilerSessionApi,
  started: { child: ChildProcess; pid: number },
  capture: XctraceCapture
): { status: "recording"; pid: number; traceFile: string } {
  const { child: xctraceProcess, pid: xctracePid } = started;

  // A `stop-all-simulator-servers` that landed inside the readiness handshake above
  // already destroyed this session — `Registry._teardown` nulled the node's instance,
  // so the owner's `native-profiler-stop` would answer "call native-profiler-start
  // first". Reporting `status: "recording"` would hand back an unreachable session
  // with a trace file on disk. Reap what this attempt spawned instead.
  if (api.disposed) {
    try {
      xctraceProcess.kill("SIGKILL");
    } catch {
      // already dead
    }
    resetStartState(api);
    throw new FailureError(
      `The native profiling session for ${api.deviceId} was torn down by a ` +
        `stop-all-simulator-servers while this start was waiting for xctrace to become ` +
        `ready, so nothing was recorded — one tool-server serves every agent using this ` +
        `argent install, so this may have been another agent ending its session. Call ` +
        `native-profiler-start again.`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_SESSION_TORN_DOWN,
        failure_stage: "native_profiler_xctrace_start",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }

  // Stamp the per-capture descriptors only on SUCCESS: a failed start must leave the
  // previous capture's still-loaded exports fully described for analyze. The stale
  // recovery flags reset here too — clearing them on a FAILED start would make stop's
  // partial-trace recovery for the previous abnormal capture unreachable.
  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.lastExitInfo = null;
  api.appProcess = capture.appProcess;
  api.traceFile = capture.traceFile;
  // The in-flight capture's mode; stop copies it into api.mallocStackLogging when it
  // writes exportedFiles. Stamping the report-facing flag here would re-label the
  // previous capture's still-loaded exports/parsedData.
  api.recordingMallocStackLogging = capture.mallocStackLogging;
  api.cpuFilterPid = capture.cpuFilterPid;
  api.recordingAppPid = capture.appPid ?? null;
  api.profilingActive = true;
  api.wallClockStartMs = Date.now();
  // See the Android twin: a live capture makes any earlier teardown breadcrumb
  // unconsumable, and therefore a future false accusation.
  takeReapedSession("native-profiler", api.deviceId);
  api.recordingTimeout = setTimeout(() => {
    // Now, not at the stop: an app that quits after the recording did not quit during it.
    api.recordingAppEnded = appEnded(api);
    try {
      xctraceProcess.kill("SIGINT");
    } catch {
      // already dead
    }
    api.profilingActive = false;
    api.capturePid = null;
    api.captureProcess = null;
    api.recordingTimeout = null;
    api.recordingTimedOut = true;
    // No stop waits for this xctrace, and on a Mac app it can hang after SIGINT
    // for good (see stopNativeProfilerIos).
    if (api.platform === "macos") {
      setTimeout(() => {
        if (xctraceProcess.exitCode === null && xctraceProcess.signalCode === null) {
          try {
            xctraceProcess.kill("SIGKILL");
          } catch {
            // already dead
          }
        }
      }, CAPPED_XCTRACE_KILL_MS).unref();
    }
  }, RECORDING_CAP_MS);

  xctraceProcess.on("exit", (code, signal) => handleXctraceExit(api, code, signal));

  return {
    status: "recording",
    pid: xctracePid,
    traceFile: capture.traceFile,
  };
}

const execFileAsync = promisify(execFile);

/**
 * A fingerprint of a stopping xctrace's progress for `shutdownChild`'s stall
 * watch: its CPU time and the bytes in the trace bundle. Null when the child
 * has no pid; rejects when `ps` or the bundle cannot be read, which the watch
 * treats as no reading.
 */
export function xctraceProgressProbe(
  child: ChildProcess,
  traceFile: string
): () => Promise<string | null> {
  return async () => {
    if (!child.pid) return null;
    const { stdout } = await execFileAsync("ps", ["-o", "time=", "-p", String(child.pid)], {
      timeout: 2_000,
    });
    const entries = await fsp.readdir(traceFile, { recursive: true, withFileTypes: true });
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      bytes += (await fsp.stat(path.join(entry.parentPath, entry.name))).size;
    }
    return `${stdout.trim()}|${bytes}`;
  };
}
