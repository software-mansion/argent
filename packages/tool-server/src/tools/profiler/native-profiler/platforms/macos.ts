import type { ChildProcess } from "child_process";
import * as path from "path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { NativeProfilerSessionApi } from "../../../../blueprints/native-profiler-session";
import type { MacosAppApi } from "../../../../blueprints/macos-app";
import { InvalidToolInputError } from "../../../../utils/capability";
import { waitForChildExit } from "../../../../utils/profiler-shared/lifecycle";
import {
  getTrackedMacosApp,
  inBackgroundSession,
  readCodeSignature,
  runningTrackedApp,
} from "../../../../utils/macos-apps";
import {
  assertNoCaptureRunning,
  waitForStop,
  commitXctraceRecording,
  newTraceOutputPath,
  resolveDefaultTemplatePath,
  spawnXctraceRecording,
  xctraceOutput,
  xctraceRunErrors,
} from "./xctrace";

/**
 * A Mac app is an ordinary host process, so xctrace attaches to its pid with no
 * `--device`: the recording is scoped to the app, and the Xcode 26.4 `--device`
 * deadlock of the iOS path does not apply. malloc_stack_logging restarts the
 * app through argent with MallocStackLogging=1 and then attaches, so the app
 * keeps argent's library.
 */

interface MacosStartParams {
  device_id: string;
  app_process?: string;
  template_path?: string;
  malloc_stack_logging?: boolean;
}

/**
 * The pid of each app that argent last started with MallocStackLogging=1, by
 * bundle id: a later capture of that same process is told that its timings
 * carry the logging's overhead.
 */
const mallocStackLoggingPids = new Map<string, number>();

/**
 * Refuses an app whose signature has no get-task-allow. In the user's desktop
 * session, macOS asks for an administrator password before Instruments may
 * attach to such a process, and xctrace reports that it records while it waits
 * for the dialog. In a Background session (over SSH, for example) macOS shows
 * no dialog: the Time Profiler template records such an app there, but the Leaks
 * and Allocations instruments of the bundled template cannot attach to it. So
 * there only a recording with the bundled template is refused; with a template
 * the caller chose, the attach decides. `target` is the running app's pid, or
 * its bundle when it is not running. `startedNote` tells the caller that argent
 * started the process it refuses.
 */
async function assertDebuggable(
  bundleId: string,
  target: number | string,
  templatePath: string | undefined,
  startedNote?: string
): Promise<void> {
  const signature = await readCodeSignature(target);
  // No signature that codesign can read: the attach decides.
  if (!signature || signature.entitlements.getTaskAllow) return;
  const background = await inBackgroundSession();
  if (background && templatePath !== undefined) return;
  const why = background
    ? `In this session, which is not the user's desktop session (over SSH, for example), macOS ` +
      `lets Instruments sample such an app, but the Leaks and Allocations instruments of the ` +
      `default template cannot attach to it, so argent does not start the recording. Pass ` +
      `template_path: "Time Profiler" to record CPU samples and hangs without leaks, or profile ` +
      `a build that Xcode signed for development (Build or Run, Debug or Release), or sign the ` +
      `build you profile with com.apple.security.get-task-allow.`
    : `macOS lets Instruments record such an app only after an administrator types a password ` +
      `in a system dialog, and nothing is recorded while the dialog waits, so argent does not ` +
      `start the recording. Profile a build that Xcode signed for development (Build or Run, ` +
      `Debug or Release), or sign the build you profile with com.apple.security.get-task-allow.`;
  throw new FailureError(
    `${bundleId} is signed without the entitlement com.apple.security.get-task-allow, as an ` +
      `archived, notarized or App Store build is. ${why}` +
      (startedNote ? ` ${startedNote}` : ""),
    {
      error_code: FAILURE_CODES.NATIVE_PROFILER_APP_NOT_DEBUGGABLE,
      failure_stage: "native_profiler_check_signature",
      failure_area: "tool_server",
      error_kind: "unsupported",
    }
  );
}

export async function startNativeProfilerMacos(
  api: NativeProfilerSessionApi,
  macosApp: MacosAppApi,
  params: MacosStartParams
): Promise<{ status: "recording"; pid: number; traceFile: string; warning?: string }> {
  const bundleId = macosApp.bundleId;
  await waitForStop(api);
  assertNoCaptureRunning(api);
  if (params.app_process !== undefined) {
    throw new InvalidToolInputError(
      `app_process is not used for a Mac app: the device id ${params.device_id} already names ` +
        `the app (${bundleId}). Call native-profiler-start without app_process.`
    );
  }
  const templatePath = params.template_path ?? resolveDefaultTemplatePath();
  // Before the restart below: a failure here must not have quit the app.
  const outputFile = await newTraceOutputPath();
  const useMallocStackLogging = params.malloc_stack_logging === true;

  let pid: number;
  let stillLogs = false;
  const notes: string[] = [];
  if (useMallocStackLogging) {
    // Before the restart, which loses the app's state.
    const before =
      (await runningTrackedApp(bundleId))?.pid ?? getTrackedMacosApp(bundleId)?.appPath;
    if (before !== undefined) await assertDebuggable(bundleId, before, params.template_path);
    // Refuses before it quits anything when the app cannot be started again,
    // or a dialog of the app holds up the quit.
    const launched = await macosApp.launch({ restart: true, env: { MallocStackLogging: "1" } });
    pid = launched.pid;
    mallocStackLoggingPids.set(bundleId, pid);
    const restartNote =
      `argent restarted ${bundleId} (pid ${pid}) with MallocStackLogging=1, so its earlier ` +
      `state is gone. It keeps running with malloc stack logging, which slows it down, until ` +
      `restart-app starts it again without.`;
    // The bundle on disk, which the restart started, can differ from the process checked above.
    await assertDebuggable(bundleId, pid, params.template_path, restartNote);
    notes.push(restartNote);
    if (launched.note) notes.push(launched.note);
  } else {
    const app = await runningTrackedApp(bundleId);
    if (!app) {
      throw new FailureError(
        `${bundleId} is not running. Start it with boot-device (macosAppPath) or launch-app on ` +
          `the device ${params.device_id}, then call native-profiler-start again.`,
        {
          error_code: FAILURE_CODES.NATIVE_PROFILER_NO_RUNNING_APPS,
          failure_stage: "native_profiler_detect_running_processes",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      );
    }
    pid = app.pid;
    await assertDebuggable(bundleId, pid, params.template_path);
    if (mallocStackLoggingPids.get(bundleId) === pid) {
      stillLogs = true;
      notes.push(
        `${bundleId} still runs with MallocStackLogging=1 from an earlier malloc_stack_logging ` +
          `capture, which slows it down and shows in the timings. restart-app starts it without.`
      );
    }
  }

  const executable = getTrackedMacosApp(bundleId)?.executable;
  const appProcess = executable ? path.basename(executable) : bundleId;

  // Before xctrace attaches, which suspends the app for a moment too. Instruments
  // suspends the whole app at each leak check; while argent watches, a call
  // waits for the app instead of timing out, and analyze takes the suspensions
  // out of the hangs.
  const suspensionWatch = await macosApp.watchSuspensions(pid);
  let recording = false;
  try {
    const started = await spawnXctraceRecording(api, (notifyName) => {
      const args = [
        "record",
        "--template",
        templatePath,
        "--attach",
        String(pid),
        "--output",
        outputFile,
        "--no-prompt",
      ];
      if (notifyName) args.push("--notify-tracing-started", notifyName);
      return args;
    });

    await settleAfterStart(api, started.child);
    const result = commitXctraceRecording(api, started, {
      appProcess,
      traceFile: outputFile,
      mallocStackLogging: useMallocStackLogging || stillLogs,
      // Scoped to the app by --attach.
      cpuFilterPid: null,
      appPid: pid,
    });
    api.suspensionWatch = suspensionWatch;
    recording = true;
    return notes.length > 0 ? { ...result, warning: notes.join(" ") } : result;
  } finally {
    if (!recording) suspensionWatch?.end();
  }
}

/**
 * xctrace reports that tracing started before its instruments record: a hang
 * that began 0.65 s after that was missed in 4 of 4 runs, one that began 0.9 s
 * after it was found in 5 of 5. So the start returns only after this wait, and
 * the caller can act on the app at once.
 */
const ARM_SETTLE_MS = 1_500;

// Before the session takes the capture, so that a failure here leaves the
// previous capture as it was. A teardown in the wait is reported by the commit.
async function settleAfterStart(api: NativeProfilerSessionApi, child: ChildProcess): Promise<void> {
  if (!(await waitForChildExit(child, ARM_SETTLE_MS)) || api.disposed) return;
  api.capturePid = null;
  api.captureProcess = null;
  const errors = xctraceRunErrors(child);
  const said =
    errors.length > 0 ? errors.join(" ") : xctraceOutput(child).trim().slice(-500) || "<nothing>";
  throw new FailureError(
    `xctrace quit right after the recording started (code=${child.exitCode ?? "?"}, ` +
      `signal=${child.signalCode ?? "?"}), so nothing is recorded. xctrace said: ${said} ` +
      `Check that the app still runs, then call native-profiler-start again.`,
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
