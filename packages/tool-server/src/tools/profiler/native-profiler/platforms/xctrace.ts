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
import { runningXctraceRecordings } from "../../../../utils/ios-profiler/xctrace-processes";
import { RECORDING_CAP_MS } from "../../../../utils/profiler-shared/types";
import {
  shutdownChild,
  waitForChildExit,
  type ShutdownResult,
} from "../../../../utils/profiler-shared/lifecycle";
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

/**
 * The `xctrace record` processes that this tool-server started, until they
 * exit, with the device that each one records.
 */
const xctraceRecordings = new Map<ChildProcess, { deviceId: string; sinceMs: number }>();

/**
 * The starts of this tool-server that passed the host check and have not
 * returned, with their device. Before it spawns xctrace, a start can restart its
 * Mac app or terminate its iOS app (malloc_stack_logging), so each other start,
 * of any device, is refused at its first check.
 */
const xctraceStarts = new Set<{ deviceId: string }>();

/**
 * macOS gives the kernel trace, which xctrace records CPU samples with, to one
 * recording at a time. Measured with Xcode 27.2: a second `xctrace record`
 * (attached to another process, or `--all-processes`, with the Time Profiler or
 * the Argent template) failed with "Failed to start the recording: _lockKPerf:
 * could not lock kperf", and the first one, which ended with no error, had no
 * CPU sample after the second one began.
 */
const ONE_KERNEL_TRACE =
  "macOS lets one recording at a time use the kernel trace that Instruments records CPU " +
  "samples with";
const ONE_RECORDING =
  `${ONE_KERNEL_TRACE}: a second recording fails to start, and the first one records no CPU ` +
  `samples from then on.`;

/** What to do about a recording of this tool-server, which can be another agent's. */
const STOP_IF_YOURS =
  "If that recording is yours, stop it with native-profiler-stop. Otherwise wait until it " +
  "ends, or ask the user. Then call native-profiler-start again.";

function hostRecordingRunning(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.NATIVE_PROFILER_HOST_RECORDING_RUNNING,
    failure_stage: "native_profiler_start_host_recording",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

function deviceName(api: NativeProfilerSessionApi, deviceId: string): string {
  return deviceId === api.deviceId ? "this device" : deviceId;
}

/**
 * Refuses while an xctrace of this tool-server runs, on any device: one that
 * records, or one that saves the trace after its SIGINT (a stop, or the cap).
 */
function assertNoOwnXctraceRecording(api: NativeProfilerSessionApi): void {
  for (const [child, { deviceId, sinceMs }] of xctraceRecordings) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const saving = xctraceStopping(child);
    throw hostRecordingRunning(
      `argent cannot record ${api.deviceId} now: xctrace (pid ${child.pid}) of this ` +
        `tool-server ${saving ? "saves a recording of" : "records"} ` +
        `${deviceName(api, deviceId)}, started ${Math.round((Date.now() - sinceMs) / 1000)} s ` +
        `ago. ${ONE_RECORDING} ` +
        (saving
          ? "If that recording is yours, native-profiler-stop returns it once xctrace has " +
            "saved it. Otherwise wait until xctrace has saved it, then call " +
            "native-profiler-start again."
          : STOP_IF_YOURS)
    );
  }
}

/** Refuses while another start of this tool-server runs, on any device. */
function assertNoOtherXctraceStart(api: NativeProfilerSessionApi): void {
  for (const { deviceId } of xctraceStarts) {
    throw hostRecordingRunning(
      `argent cannot record ${api.deviceId} now: this tool-server starts a recording of ` +
        `${deviceName(api, deviceId)}. ${ONE_RECORDING} Wait until that start has returned. ` +
        STOP_IF_YOURS
    );
  }
}

/**
 * Refuses while another process records with xctrace on this Mac: another
 * tool-server, or a hand-started xctrace. A recording in Instruments.app runs
 * no xctrace and is not seen.
 */
async function assertNoForeignXctraceRecording(api: NativeProfilerSessionApi): Promise<void> {
  const running = await runningXctraceRecordings();
  // Not the xctrace processes of this tool-server, which the own check reports.
  // ps can list one here: the first attempt of a cold-start retry, killed after
  // its readiness wait and not exited yet.
  const own = new Set([...xctraceRecordings.keys()].map((child) => child.pid));
  const other = running.find(({ pid }) => !own.has(pid));
  if (!other) return;
  throw hostRecordingRunning(
    `argent cannot record ${api.deviceId} now: another xctrace recording runs on this Mac ` +
      `(pid ${other.pid}, for ${other.elapsed}: ${other.command.slice(0, 200)}). ${ONE_RECORDING} ` +
      `Wait until it ends, or ask the user. Then call native-profiler-start again.`
  );
}

/**
 * Runs `start` as the one start of an xctrace recording on this Mac. It refuses
 * while an xctrace of this tool-server runs, or another start of it, on any
 * device, and while another process records with xctrace. Until `start` returns,
 * each other start of this tool-server is refused at its first check, before it
 * touches its app. spawnXctraceRecording checks the host again before it spawns.
 */
export async function startAloneOnHost<T>(
  api: NativeProfilerSessionApi,
  start: () => Promise<T>
): Promise<T> {
  assertNoOwnXctraceRecording(api);
  assertNoOtherXctraceStart(api);
  const reservation = { deviceId: api.deviceId };
  xctraceStarts.add(reservation);
  try {
    await assertNoForeignXctraceRecording(api);
    return await start();
  } finally {
    xctraceStarts.delete(reservation);
  }
}

/** Forgets the recordings and starts whose fake xctrace a test left running. */
export function __resetXctraceRecordingsForTesting(): void {
  xctraceRecordings.clear();
  xctraceStarts.clear();
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

/**
 * The end of each recording's xctrace output (the run issues come last), and
 * when xctrace printed "Starting recording", by the wall clock.
 */
const outputTails = new WeakMap<ChildProcess, { text: string; startingRecordingMs?: number }>();
const OUTPUT_TAIL_CHARS = 16_384;

/** Keeps the end of what `child` prints, for {@link xctraceOutput}. */
export function keepOutputTail(child: ChildProcess): void {
  const tail: { text: string; startingRecordingMs?: number } = { text: "" };
  const add = (data: Buffer) => {
    tail.text = (tail.text + data.toString()).slice(-OUTPUT_TAIL_CHARS);
    if (tail.startingRecordingMs === undefined && tail.text.includes("Starting recording")) {
      tail.startingRecordingMs = Date.now();
    }
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
function xctraceRunErrors(child: ChildProcess): string[] {
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

const KERNEL_TRACE = /kperf|ktrace|kernel trace/i;

/**
 * Why xctrace could not start a recording whose errors name the kernel trace,
 * as a sentence with a leading space; empty for other errors.
 */
export function kernelTraceBusyNote(errors: string): string {
  return KERNEL_TRACE.test(errors)
    ? ` ${ONE_KERNEL_TRACE}, and another recording on this Mac used it (Instruments, or an ` +
        `xctrace of another tool or tool-server).`
    : "";
}

/**
 * Resolves true once xctrace prints that tracing started, false when it exits
 * first or `timeoutMs` passes. "Starting recording", which can end the
 * readiness wait, comes before the helper creates the kernel trace: on a Mac
 * app, more than 1 s before.
 */
function whenTracingStarted(child: ChildProcess, timeoutMs?: number): Promise<boolean> {
  const started = () => xctraceOutput(child).includes("Ctrl-C to stop");
  if (started()) return Promise.resolve(true);
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (result: boolean) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      resolve(result);
    };
    // Runs after the listener that keeps the output, which is added first.
    const onData = () => {
      if (started()) done(true);
    };
    const onExit = () => done(started());
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => done(false), timeoutMs);
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
  try {
    // Again, as late as it can be: another process can have started xctrace
    // since the first check of the start. Two that both run this check before
    // either spawns xctrace still both record.
    await assertNoForeignXctraceRecording(api);
    // A teardown during the start's awaits, with none from here to the spawn: an
    // xctrace spawned now would record for a session that is gone.
    if (api.disposed) throw sessionTornDownError(api);
    assertNoOwnXctraceRecording(api);
  } catch (err) {
    notify?.cancel();
    throw err;
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
  xctraceRecordings.set(xctraceProcess, { deviceId: api.deviceId, sinceMs: Date.now() });
  // "close" also follows a spawn that failed, which emits no "exit".
  xctraceProcess.once("close", () => xctraceRecordings.delete(xctraceProcess));
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

/**
 * xctrace reports that tracing started before its instruments record: a hang
 * that began 0.65 s after that was missed in 4 of 4 runs, one that began 0.9 s
 * after it was found in 5 of 5. So the start returns only this long after
 * tracing started, and the caller can act on the app at once.
 */
const ARM_SETTLE_MS = 1_500;

/**
 * xctrace prints "Starting recording" when it begins to attach, and "Ctrl-C to
 * stop" when tracing starts, with the tracing-started notification: 0.9 to
 * 1.7 s later with Xcode 27.2 and 26.6. The readiness wait ends at the first
 * of the three, so after "Starting recording" the start waits for "Ctrl-C to
 * stop", at most this long.
 */
const TRACING_STARTED_TIMEOUT_MS = 10_000;

// Before the session takes the capture, so that a failure here leaves the
// previous capture as it was. A teardown in the wait is reported by the commit.
export async function settleAfterStart(
  api: NativeProfilerSessionApi,
  child: ChildProcess
): Promise<void> {
  if (xctraceOutput(child).includes("Starting recording")) {
    await whenTracingStarted(child, TRACING_STARTED_TIMEOUT_MS);
  }
  if (!(await waitForChildExit(child, ARM_SETTLE_MS)) || api.disposed) return;
  resetStartState(api);
  const errors = xctraceRunErrors(child);
  const said =
    errors.length > 0 ? errors.join(" ") : xctraceOutput(child).trim().slice(-500) || "<nothing>";
  const busy = kernelTraceBusyNote(errors.join(" "));
  throw new FailureError(
    `xctrace quit right after the recording started (code=${child.exitCode ?? "?"}, ` +
      `signal=${child.signalCode ?? "?"}), so nothing is recorded. xctrace said: ${said}` +
      (busy
        ? `${busy} Call native-profiler-start again.`
        : ` Check that the app still runs, then call native-profiler-start again.`),
    {
      error_code: FAILURE_CODES.NATIVE_PROFILER_XCTRACE_READY_EXITED,
      failure_stage: "native_profiler_xctrace_start",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "xctrace",
      ...(child.exitCode !== null ? { failure_exit_code: child.exitCode } : {}),
    }
  );
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
 * start, while the start waits at most 10 s for that.
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

  // A `stop-all-simulator-servers` that landed after the spawn (in the readiness
  // handshake, or in the wait after it) already destroyed this session:
  // `Registry._teardown` nulled the node's instance, so the owner's
  // `native-profiler-stop` would answer "call native-profiler-start first".
  // Reporting `status: "recording"` would hand back an unreachable session with a
  // trace file on disk. Reap what this attempt spawned instead.
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
  // Trace time 0 on the wall clock, until the stop reads the trace's own start.
  // Measured with Xcode 27.2 on an iOS simulator and a Mac app: the trace starts
  // 0.2 to 0.25 s after xctrace prints "Starting recording", and the start
  // returns about 2.4 s after it.
  api.startReturnedMs = Date.now();
  api.wallClockStartMs =
    outputTails.get(xctraceProcess)?.startingRecordingMs ?? api.startReturnedMs;
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
    // Not after a teardown, which cleared the capture. No newer recording can
    // be the capture: startAloneOnHost refuses one while this xctrace runs.
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
