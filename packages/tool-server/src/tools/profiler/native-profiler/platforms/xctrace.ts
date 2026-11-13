import { spawn, type ChildProcess } from "child_process";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { existsSync } from "node:fs";
import * as path from "path";
import type { NativeProfilerSessionApi } from "../../../../blueprints/native-profiler-session";
import { takeReapedSession } from "../../../../utils/reaped-sessions";
import { getDebugDir } from "../../../../utils/react-profiler/debug/dump";
import {
  listenForDarwinNotification,
  type NotifyHandle,
} from "../../../../utils/ios-profiler/notify";
import { waitForXctraceReady } from "../../../../utils/ios-profiler/startup";
import { RECORDING_CAP_MS } from "../../../../utils/profiler-shared/types";
import { shutdownChild, type ShutdownResult } from "../../../../utils/profiler-shared/lifecycle";
import { xctraceProgressProbe } from "../../../../utils/ios-profiler/xctrace-progress";
import {
  kernelTraceDir,
  listKernelTraces,
  newKernelTrace,
  removeKernelTraceWhenIdle,
} from "../../../../utils/ios-profiler/kernel-trace";

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
  signal: string | null,
  runErrors: string[] = []
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
  api.lastExitInfo = runErrors.length > 0 ? { code, signal, runErrors } : { code, signal };
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

/** Keeps the end of what `child` prints, for {@link xctraceOutput}. */
export function keepOutputTail(child: ChildProcess): void {
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
 * Deletes the raw kernel trace of this xctrace's recording once xctrace has
 * exited, by any path: stop, the 10-minute cap, its own exit or a teardown.
 * Nothing else deletes it. See kernel-trace.ts.
 *
 * An xctrace that reported an error can have no file of its own: one that lost
 * the kernel trace to another recording says that tracing started and then
 * that it could not start the recording. The one new file is then the other
 * recording's, so it stays. The run issues come last, so they are read when
 * the file would be deleted, 2 s or more after the exit.
 */
function removeKernelTraceAfterExit(child: ChildProcess, file: Promise<string | null>): void {
  const ours = () => xctraceRunErrors(child).length === 0;
  const remove = () =>
    void file.then((found) => (found ? removeKernelTraceWhenIdle(found, ours) : undefined));
  if (child.exitCode !== null || child.signalCode !== null) remove();
  else child.once("exit", remove);
}

/**
 * Resolves true once xctrace prints that tracing started, false when it exits
 * first. "Starting recording", which can end the readiness wait, comes before
 * the helper creates the kernel trace: on a Mac app, more than 1 s before.
 */
function whenTracingStarted(child: ChildProcess): Promise<boolean> {
  const started = () => xctraceOutput(child).includes("Ctrl-C to stop");
  if (started()) return Promise.resolve(true);
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (result: boolean) => {
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      resolve(result);
    };
    // Runs after the listener that keeps the output, which is added first.
    const onData = () => {
      if (started()) done(true);
    };
    const onExit = () => done(started());
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
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
  // A teardown during the start's awaits, with none from here to the spawn: an
  // xctrace spawned now would record for a session that is gone.
  if (api.disposed) {
    notify?.cancel();
    throw sessionTornDownError(api);
  }
  // Not awaited, here and below: the helper creates the file seconds after the
  // spawn, and the start does not wait for a listing of the folder.
  const kernelTraces = kernelTraceDir();
  const kernelTracesBefore = listKernelTraces(kernelTraces);
  const ownKernelTrace = () =>
    kernelTracesBefore.then((before) => newKernelTrace(kernelTraces, before));

  const xctraceProcess = spawn("xctrace", buildArgs(notify ? notifyName : undefined), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  keepOutputTail(xctraceProcess);
  api.capturePid = xctraceProcess.pid ?? null;
  api.captureProcess = xctraceProcess;

  // Before the readiness wait, which cancels the notification when it ends at stdout.
  const notified = notify?.fired.then(() => true);
  try {
    await waitForXctraceReady(xctraceProcess, { notify, timeoutMs: STARTUP_TIMEOUT_MS });
  } catch (err) {
    resetStartState(api);
    // The teardown killed the xctrace that this wait watched.
    throw api.disposed ? sessionTornDownError(api) : err;
  }
  // The helper creates it about 1 s before xctrace says that tracing started.
  // When xctrace never says so, as after a start that failed, the file stays:
  // the one new file can be the file of another recording.
  const tracing = whenTracingStarted(xctraceProcess);
  removeKernelTraceAfterExit(
    xctraceProcess,
    (notified ? Promise.race([notified, tracing]) : tracing).then((started) =>
      started ? ownKernelTrace() : null
    )
  );

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

function sessionTornDownError(api: NativeProfilerSessionApi): FailureError {
  return new FailureError(
    `The native profiling session for ${api.deviceId} was torn down by a ` +
      `stop-all-simulator-servers while this start ran, so nothing was recorded. One ` +
      `tool-server serves every agent using this argent install, so this may have been ` +
      `another agent ending its session. Call native-profiler-start again.`,
    {
      error_code: FAILURE_CODES.NATIVE_PROFILER_SESSION_TORN_DOWN,
      failure_stage: "native_profiler_xctrace_start",
      failure_area: "tool_server",
      error_kind: "not_found",
    }
  );
}

// Ceiling, not a fixed wait: 30 s SIGTERM'd xctrace mid-package.
const STOP_GRACE_MS = 300_000;
const STOP_TERM_MS = 5_000;
const STOP_KILL_MS = 5_000;
/**
 * How long a stopping xctrace may make no progress before the stop ends it: a
 * fifth of the recording, within 30 s to 2 min. A healthy stop starts with a
 * wait that grows with the recording: after a 5 min recording of a Mac app,
 * 23 s in which xctrace's CPU time or the trace bundle changed at least every
 * 11 s.
 */
function stallIdleMs(recordedMs: number): number {
  return Math.min(120_000, Math.max(30_000, Math.round(recordedMs / 5)));
}

/** How a recording's xctrace ended, with the stall watch's limit. */
export interface XctraceEnd {
  result: ShutdownResult;
  idleMs: number;
  /** xctrace said neither that tracing started nor that it stops the recording. */
  neverTraced: boolean;
  /** The run errors that xctrace printed when it ended. */
  runErrors: string[];
}

/**
 * How often the stop sends SIGINT again while xctrace has not said that it
 * stops. xctrace ignores a SIGINT that comes before it starts to trace, and then
 * records until it is killed. On a busy Mac it started to trace 24 s after its
 * start, while the start of a Mac app waits at most 10 s for that.
 */
const SIGINT_REPEAT_MS = 5_000;

/** True once xctrace has printed that it stops the recording, after a SIGINT it took. */
function xctraceStopping(child: ChildProcess): boolean {
  return xctraceOutput(child).includes("Stopping recording");
}

/**
 * Ends a recording's xctrace: SIGINT, then SIGTERM and SIGKILL when it does not
 * end in 5 minutes. SIGINT goes again every {@link SIGINT_REPEAT_MS} until
 * xctrace says that it stops. xctrace sometimes hangs after SIGINT for good,
 * also with no argent in the app: idle, and writing nothing. So the ladder goes
 * on earlier when it makes no progress for {@link stallIdleMs} of the recording.
 */
export async function endXctrace(
  child: ChildProcess,
  traceFile: string,
  recordedMs: number
): Promise<XctraceEnd> {
  const idleMs = stallIdleMs(recordedMs);
  const stopping = () => xctraceStopping(child);
  let repeat: NodeJS.Timeout | undefined;
  let repeated = false;
  const repeatSigint = () => {
    repeat = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null || stopping()) return;
      if (!repeated) {
        repeated = true;
        process.stderr.write(
          `[native-profiler] xctrace (pid ${child.pid}) did not take SIGINT; sending it again ` +
            `every ${SIGINT_REPEAT_MS / 1000} s.\n`
        );
      }
      try {
        child.kill("SIGINT");
      } catch {
        // gone
      }
      repeatSigint();
    }, SIGINT_REPEAT_MS);
  };
  repeatSigint();
  try {
    const result = await shutdownChild(child, {
      graceMs: STOP_GRACE_MS,
      termMs: STOP_TERM_MS,
      killMs: STOP_KILL_MS,
      stall: {
        probe: xctraceProgressProbe(child, traceFile, { idleMs, stopping }),
        idleMs,
        pollMs: 2_000,
      },
    });
    const neverTraced = !stopping() && !xctraceOutput(child).includes("Ctrl-C to stop");
    return { result, idleMs, neverTraced, runErrors: xctraceRunErrors(child) };
  } finally {
    clearTimeout(repeat);
  }
}

/** What the stop says when xctrace did not end on its SIGINT. */
export function xctraceEndWarning({ result, idleMs, neverTraced }: XctraceEnd): string | undefined {
  if (result.stalled && neverTraced) {
    return (
      `xctrace had not started to trace: it did not say that tracing started, did not take ` +
      `the SIGINT that ends the recording, and for ${Math.round(idleMs / 1000)} s used almost ` +
      `no CPU and wrote nothing to the trace. argent ended it with ${result.signalUsed}, so ` +
      `nothing was recorded. Call native-profiler-start again for a new recording.`
    );
  }
  if (result.stalled) {
    return (
      `xctrace hung while it ended the recording: for ${Math.round(idleMs / 1000)} s it used ` +
      `almost no CPU and wrote nothing to the trace. This is a fault of xctrace, which also ` +
      `happens without argent. argent ended it with ${result.signalUsed}, so the exported data ` +
      `may be incomplete or missing. Call native-profiler-start again for a new recording.`
    );
  }
  if (!result.clean) {
    return (
      `xctrace did not respond to SIGINT${result.signalUsed === "SIGKILL" ? "/SIGTERM" : ""}; ` +
      `${result.signalUsed} was used. Trace bundle may be incomplete. Call ` +
      `native-profiler-start again for a new recording.`
    );
  }
  return undefined;
}

/**
 * Why the trace can lack its tables, for analyze: xctrace was ended before it
 * finished the recording. Null when it ended on SIGINT.
 */
export function unfinishedRecordingReason({ result }: XctraceEnd): string | null {
  return result.clean
    ? null
    : `xctrace did not end on SIGINT, so argent ended it with ${result.signalUsed}, and the ` +
        `recording was not finished.`;
}

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
    throw sessionTornDownError(api);
  }

  // Stamp the per-capture descriptors only on SUCCESS: a failed start must leave the
  // previous capture's still-loaded exports fully described for analyze. The stale
  // recovery flags reset here too — clearing them on a FAILED start would make stop's
  // partial-trace recovery for the previous abnormal capture unreachable.
  api.recordingTimedOut = false;
  api.cappedEnd = null;
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
    api.profilingActive = false;
    api.recordingTimeout = null;
    api.recordingTimedOut = true;
    // As a stop does: xctrace saves the trace after the SIGINT, which can take
    // minutes, and can hang there for good. The stop after the cap waits for
    // this end before it exports, and a teardown still reaches the process.
    api.cappedEnd = endXctrace(xctraceProcess, capture.traceFile, RECORDING_CAP_MS);
  }, RECORDING_CAP_MS);

  xctraceProcess.on("exit", (code, signal) => {
    // A newer recording's xctrace can be the capture by then.
    if (api.captureProcess !== xctraceProcess) return;
    handleXctraceExit(api, code, signal, xctraceRunErrors(xctraceProcess));
    // After the cap, which keeps the process until it ends.
    api.capturePid = null;
    api.captureProcess = null;
  });

  return {
    status: "recording",
    pid: xctracePid,
    traceFile: capture.traceFile,
  };
}
