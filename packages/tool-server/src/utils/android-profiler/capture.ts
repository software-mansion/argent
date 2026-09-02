import { spawn, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { traceConfigPath } from "@argent/native-devtools-android";
import { resolveAndroidBinary } from "../android-binary";
import { runAdb, adbShell } from "../adb";

const ON_DEVICE_TRACE_DIR = "/data/misc/perfetto-traces";
const START_TIMEOUT_MS = 15_000;
const STOP_POLL_INTERVAL_MS = 200;
const STOP_TOTAL_TIMEOUT_MS = 30_000;
// The stop path makes several `adb shell` round-trips back-to-back, so adb's
// 30 s default would make one stop on a dead device block for minutes. Matches
// ENRICH_TIMEOUT_MS in adb.ts.
const STOP_PROBE_TIMEOUT_MS = 5_000;

// Perfetto can emit many warning lines, so failure messages carry only a tail —
// which is where the PID and the fatal error land.
function clip(s: string, max = 300): string {
  const t = s.trim();
  if (!t) return "<empty>";
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/**
 * Fill the TARGET_*_PLACEHOLDER tokens in the bundled tracecfg. The package
 * also serves as the cmdline, unless the manifest sets `android:process=...`.
 */
export async function buildTraceConfig(
  appPackage: string,
  configTemplate: string | null = null
): Promise<string> {
  const tpl = configTemplate ?? (await fs.readFile(traceConfigPath(), "utf8"));
  return tpl
    .replaceAll("TARGET_CMDLINE_PLACEHOLDER", appPackage)
    .replaceAll("TARGET_PACKAGE_PLACEHOLDER", appPackage);
}

interface StartPerfettoOptions {
  serial: string;
  appPackage: string;
  /** Timestamp slug for the on-device filename. */
  timestamp: string;
}

interface StartPerfettoResult {
  pid: number;
  onDeviceTracePath: string;
  /** The host-side `adb shell`; it exits while the on-device daemon keeps running. */
  child: ChildProcess;
}

/**
 * Start a perfetto recording on the target device.
 *
 * SELinux denies `shell:s0` writes to /data/misc/perfetto-traces/, so the
 * config is piped on stdin (`--txt -c -`) rather than pushed as a file;
 * `--background-wait` then prints the daemon PID on stdout once the data
 * sources are running.
 * @see ANDROID_PROFILER_REFERENCE.md "2. Capture"
 */
export async function startPerfetto(opts: StartPerfettoOptions): Promise<StartPerfettoResult> {
  const adbPath = await resolveAndroidBinary("adb");
  if (!adbPath) {
    throw new FailureError(
      "`adb` not found on PATH or under `$ANDROID_HOME/platform-tools`. " +
        "Install Android SDK Platform Tools or set `$ANDROID_HOME` to your SDK root.",
      {
        error_code: FAILURE_CODES.ANDROID_ADB_NOT_FOUND,
        failure_stage: "android_profiler_resolve_adb",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
        failure_command: "adb",
      }
    );
  }

  const cfgText = await buildTraceConfig(opts.appPackage);
  const onDeviceTracePath = `${ON_DEVICE_TRACE_DIR}/argent-${opts.timestamp}.pftrace`;

  const args = [
    "-s",
    opts.serial,
    "shell",
    "perfetto",
    "--txt",
    "-c",
    "-",
    "--background-wait",
    "-o",
    onDeviceTracePath,
  ];

  const child = spawn(adbPath, args, { stdio: ["pipe", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const pid = await new Promise<number>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      fail(
        new FailureError(
          `perfetto did not return a PID within ${START_TIMEOUT_MS} ms. ` +
            `stdout: ${clip(stdout)} | stderr: ${clip(stderr)}`,
          {
            error_code: FAILURE_CODES.NATIVE_PROFILER_PERFETTO_READY_TIMEOUT,
            failure_stage: "android_profiler_perfetto_ready",
            failure_area: "tool_server",
            error_kind: "timeout",
            failure_command: "adb",
          }
        )
      );
    }, START_TIMEOUT_MS);

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      reject(err);
    }

    function succeed(value: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    // An unlistened 'error' event throws as an uncaught exception that can take
    // down the whole server, so route both streams' failures into the promise.
    child.on("error", (err) =>
      fail(
        new FailureError(
          `Failed to launch adb for perfetto: ${err.message}`,
          {
            error_code: FAILURE_CODES.NATIVE_PROFILER_PERFETTO_PROCESS_ERROR,
            failure_stage: "android_profiler_perfetto_spawn",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "adb"),
          },
          { cause: err }
        )
      )
    );
    child.stdin.on("error", (err) =>
      fail(
        new FailureError(
          `Failed to write perfetto config to adb stdin: ${err.message}`,
          {
            error_code: FAILURE_CODES.NATIVE_PROFILER_PERFETTO_PROCESS_ERROR,
            failure_stage: "android_profiler_perfetto_stdin",
            failure_area: "tool_server",
            error_kind: "subprocess",
            failure_command: "adb",
          },
          { cause: err }
        )
      )
    );

    // `final` comes only from the exit handler, where stdout is complete and a
    // PID with no trailing newline is safe to parse.
    const tryResolve = (final = false) => {
      const trimmed = stdout.trim();
      if (!trimmed) return;
      // A chunk split mid-number would otherwise resolve a truncated PID,
      // leaving the real daemon orphaned and unstoppable.
      if (!final && !stdout.endsWith("\n")) return;
      // Perfetto may print warnings before the PID.
      const lastLine = trimmed
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      if (!lastLine) return;
      const parsed = parseInt(lastLine, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      succeed(parsed);
    };

    child.stdout.on("data", () => tryResolve());
    child.once("exit", (code, signal) => {
      if (settled) return;
      // A signal kill leaves code=null.
      const reason = signal ? `signal ${signal}` : `code ${code ?? "?"}`;
      if (stdout.trim() === "") {
        fail(
          new FailureError(
            `perfetto exited (${reason}) before printing a PID. ` + `stderr: ${clip(stderr)}`,
            {
              error_code: FAILURE_CODES.NATIVE_PROFILER_PERFETTO_READY_EXITED,
              failure_stage: "android_profiler_perfetto_exited",
              failure_area: "tool_server",
              error_kind: "subprocess",
              ...subprocessFailureMetadata({ code, signal }, "adb"),
            }
          )
        );
        return;
      }
      tryResolve(true);
      // A no-op once tryResolve settled; otherwise fail now instead of hanging
      // until the start timeout fires.
      fail(
        new FailureError(
          `perfetto exited (${reason}) without a valid PID on its last stdout line. ` +
            `stdout: ${clip(stdout)} | stderr: ${clip(stderr)}`,
          {
            error_code: FAILURE_CODES.NATIVE_PROFILER_PERFETTO_READY_EXITED,
            failure_stage: "android_profiler_perfetto_exited",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata({ code, signal }, "adb"),
          }
        )
      );
    });

    // Inside the executor so a synchronous throw rejects the promise rather
    // than escaping.
    try {
      child.stdin.write(cfgText);
      child.stdin.end();
    } catch (err) {
      fail(
        new FailureError(
          `Failed to write perfetto config to adb stdin: ${
            err instanceof Error ? err.message : String(err)
          }`,
          {
            error_code: FAILURE_CODES.NATIVE_PROFILER_PERFETTO_PROCESS_ERROR,
            failure_stage: "android_profiler_perfetto_stdin",
            failure_area: "tool_server",
            error_kind: "subprocess",
            failure_command: "adb",
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        )
      );
    }
  });

  return { pid, onDeviceTracePath, child };
}

interface StopPerfettoOptions {
  serial: string;
  pid: number;
  onDeviceTracePath: string;
  hostTracePath: string;
  /** True if the 10-min cap already fired and SIGTERM was already sent. */
  recordingTimedOut?: boolean;
}

interface StopPerfettoResult {
  hostTracePath: string;
  warning?: string;
}

/**
 * Stop a running perfetto recording, pull the .pftrace to the host, and clean
 * up the on-device file (SIGTERM → poll /proc/$pid → adb pull → rm). If the
 * daemon is already gone on the first poll, still pull and surface a
 * partial-trace warning (mirrors the iOS recordingExitedUnexpectedly path).
 */
export async function stopPerfetto(opts: StopPerfettoOptions): Promise<StopPerfettoResult> {
  let aliveBeforeSignal: boolean;
  try {
    const out = await adbShell(opts.serial, `[ -d /proc/${opts.pid} ] && echo alive || echo gone`, {
      timeoutMs: STOP_PROBE_TIMEOUT_MS,
    });
    aliveBeforeSignal = out.trim() === "alive";
  } catch {
    // probe failed — try SIGTERM anyway
    aliveBeforeSignal = true;
  }

  let warning: string | undefined;

  if (aliveBeforeSignal) {
    if (!opts.recordingTimedOut) {
      try {
        await adbShell(opts.serial, `kill -TERM ${opts.pid}`, {
          timeoutMs: STOP_PROBE_TIMEOUT_MS,
        });
      } catch {
        // the poll loop below surfaces the state
      }
    }
    const deadline = Date.now() + STOP_TOTAL_TIMEOUT_MS;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        const out = await adbShell(
          opts.serial,
          `[ -d /proc/${opts.pid} ] && echo alive || echo gone`,
          { timeoutMs: STOP_PROBE_TIMEOUT_MS }
        );
        if (out.trim() === "gone") {
          gone = true;
          break;
        }
      } catch {
        // keep polling
      }
      await new Promise((r) => setTimeout(r, STOP_POLL_INTERVAL_MS));
    }
    if (!gone) {
      try {
        await adbShell(opts.serial, `kill -KILL ${opts.pid}`, {
          timeoutMs: STOP_PROBE_TIMEOUT_MS,
        });
      } catch {
        // best-effort escalation
      }
      warning =
        `perfetto did not exit after SIGTERM within ${STOP_TOTAL_TIMEOUT_MS} ms; ` +
        `escalated to SIGKILL. Trace may be truncated.`;
    } else if (opts.recordingTimedOut) {
      warning =
        "Recording timed out at 10 min cap; pulled the partial trace. " +
        "Call native-profiler-start again for a fresh recording.";
    }
  } else {
    warning =
      "perfetto exited before stop was called; pulled the partial trace. " +
      "Common causes: target app crashed, traced daemon restart, device hibernate.";
  }

  await runAdb(["-s", opts.serial, "pull", opts.onDeviceTracePath, opts.hostTracePath]);
  await adbShell(opts.serial, `rm -f ${opts.onDeviceTracePath}`).catch(() => {});

  return { hostTracePath: opts.hostTracePath, ...(warning ? { warning } : {}) };
}
