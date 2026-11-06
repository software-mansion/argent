import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { traceConfigPath } from "@argent/native-devtools-android";
import { resolveAndroidBinary } from "../android-binary";
import { runAdb, adbArgv, adbShell } from "../adb";

const ON_DEVICE_TRACE_DIR = "/data/misc/perfetto-traces";
// `shell` can write here on every Android version. perfetto cannot read it, so
// the shell reads the file and pipes it in.
const ON_DEVICE_CONFIG_DIR = "/data/local/tmp";
const START_TIMEOUT_MS = 15_000;
const STOP_POLL_INTERVAL_MS = 200;
const STOP_TOTAL_TIMEOUT_MS = 30_000;
// The stop path makes several `adb shell` round-trips back-to-back, so adb's
// 30 s default would make one stop on a dead device block for minutes. Matches
// ENRICH_TIMEOUT_MS in adb.ts.
const BACKGROUND_LIVENESS_DELAY_MS = 500;
const CPU_SAMPLING_BEGIN = "# ARGENT_CPU_SAMPLING_BEGIN";
const CPU_SAMPLING_END = "# ARGENT_CPU_SAMPLING_END";
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
  /** False when the device's perfetto rejected the config's CPU sampling section. */
  cpuSampling: boolean;
  pid: number;
  onDeviceTracePath: string;
  /** The host-side `adb shell`; it exits while the on-device daemon keeps running. */
  child: ChildProcess;
}

/** Push the config to {@link ON_DEVICE_CONFIG_DIR} for the on-device shell to read. */
async function pushTraceConfig(
  serial: string,
  cfgText: string,
  onDevicePath: string
): Promise<void> {
  const hostDir = await fs.mkdtemp(path.join(tmpdir(), "argent-perfetto-config-"));
  try {
    const hostPath = path.join(hostDir, path.posix.basename(onDevicePath));
    await fs.writeFile(hostPath, cfgText, "utf8");
    await runAdb(["-s", serial, "push", hostPath, onDevicePath]);
  } catch (err) {
    throw new FailureError(
      `Failed to push the perfetto config to ${onDevicePath}: ${clip(
        err instanceof Error ? err.message : String(err)
      )}`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_PERFETTO_PROCESS_ERROR,
        failure_stage: "android_profiler_perfetto_push",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "adb",
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  } finally {
    await fs.rm(hostDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Pick the flag that sends perfetto to the background. `--background-wait` also
 * waits for the data sources to start, but Android 11 and older only have
 * `--background`. Below Android 10 perfetto cannot read a text config at all.
 * Empty output says nothing about the device, so it does not count as a refusal.
 */
async function perfettoBackgroundFlag(serial: string): Promise<string> {
  const help = await adbShell(serial, "perfetto --help 2>&1 || true", {
    timeoutMs: START_TIMEOUT_MS,
  });
  if (help.trim() && !help.includes("--txt")) {
    throw new FailureError(
      "Native profiling on Android needs Android 10 or newer: perfetto on this device is " +
        "missing or cannot read a text trace config.",
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_PERFETTO_UNSUPPORTED,
        failure_stage: "android_profiler_perfetto_support",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
        failure_command: "adb",
      }
    );
  }
  return help.includes("--background") && !help.includes("--background-wait")
    ? "--background"
    : "--background-wait";
}

/**
 * Remove the section of the config between {@link CPU_SAMPLING_BEGIN} and
 * {@link CPU_SAMPLING_END}. Android 11 and older reject the fields of the
 * `linux.perf` data source, and one unknown field fails the whole config, so
 * such a trace has no CPU callstacks but keeps the rest.
 */
export function withoutCpuSampling(cfgText: string): string {
  const start = cfgText.indexOf(CPU_SAMPLING_BEGIN);
  const end = cfgText.indexOf(CPU_SAMPLING_END);
  if (start < 0 || end < start) return cfgText;
  return cfgText.slice(0, start) + cfgText.slice(end + CPU_SAMPLING_END.length);
}

/**
 * `--background` prints the PID before the forked daemon has reached `traced`,
 * so unlike `--background-wait` the PID does not prove that tracing started.
 * A daemon that cannot start exits at once, for example when `traced` is
 * disabled, so check that it is still there a moment later.
 */
async function assertBackgroundedPerfettoAlive(serial: string, pid: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, BACKGROUND_LIVENESS_DELAY_MS));
  const state = await adbShell(serial, `[ -d /proc/${pid} ] && echo alive || echo gone`, {
    timeoutMs: STOP_PROBE_TIMEOUT_MS,
  }).catch(() => "");
  if (state.includes("gone")) {
    throw new FailureError(
      "perfetto stopped right after it started, so nothing is being recorded. " +
        "Check that the tracing service is enabled: `adb shell setprop persist.traced.enable 1`.",
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_PERFETTO_READY_EXITED,
        failure_stage: "android_profiler_perfetto_exited",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "adb",
      }
    );
  }
}

/**
 * Start a perfetto recording on the target device.
 *
 * The config is pushed to the device and piped in there: `cat <file> | perfetto
 * --txt -c -`. Piping it through `adb shell` from this side would need adb to
 * deliver end of input, which only the shell v2 protocol can do, so over a
 * transport without `shell_v2` perfetto would wait for more config forever.
 * perfetto cannot open the file itself: SELinux denies it /data/local/tmp, and
 * /data/misc/perfetto-configs only exists from Android 12.
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

  const backgroundFlag = await perfettoBackgroundFlag(opts.serial);
  const cfgText = await buildTraceConfig(opts.appPackage);
  const onDeviceTracePath = `${ON_DEVICE_TRACE_DIR}/argent-${opts.timestamp}.pftrace`;

  const attempt = async (config: string): Promise<{ pid: number; child: ChildProcess }> => {
    // Unique per attempt, so concurrent starts on one device never share a file.
    const onDeviceConfigPath = `${ON_DEVICE_CONFIG_DIR}/argent-${opts.timestamp}-${randomBytes(4).toString("hex")}.pbtxt`;
    await pushTraceConfig(opts.serial, config, onDeviceConfigPath);
    try {
      const started = await spawnPerfetto(adbPath, [
        "-s",
        opts.serial,
        "shell",
        `cat ${onDeviceConfigPath} | perfetto --txt -c - ${backgroundFlag} -o ${onDeviceTracePath}`,
      ]);
      if (backgroundFlag === "--background") {
        await assertBackgroundedPerfettoAlive(opts.serial, started.pid);
      }
      return started;
    } catch (err) {
      // Killing adb on a timeout need not end the on-device process. Nothing
      // else knows its PID, and it would keep writing the trace. The bracket
      // stops the pattern from matching this shell's own command line.
      await adbShell(opts.serial, `pkill -f '[a]rgent-${opts.timestamp}.pftrace'`, {
        timeoutMs: STOP_PROBE_TIMEOUT_MS,
      }).catch(() => {});
      throw err;
    } finally {
      // perfetto has parsed the config before it forks the daemon, so the file
      // is no longer needed once the PID is out, or once the start has failed.
      await adbShell(opts.serial, `rm -f ${onDeviceConfigPath}`, {
        timeoutMs: STOP_PROBE_TIMEOUT_MS,
      }).catch(() => {});
    }
  };

  try {
    const { pid, child } = await attempt(cfgText);
    return { pid, onDeviceTracePath, child, cpuSampling: true };
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("No field named")) throw err;
  }
  const { pid, child } = await attempt(withoutCpuSampling(cfgText));
  return { pid, onDeviceTracePath, child, cpuSampling: false };
}

/** Run `adb shell ... | perfetto ...` and resolve with the PID it prints. */
async function spawnPerfetto(
  adbPath: string,
  args: string[]
): Promise<{ pid: number; child: ChildProcess }> {
  /**
   * Spawned rather than routed through `runAdb`, because the PID comes back on
   * stdout while the daemon keeps running, so the argv substitution `runAdb`
   * would have applied has to be applied here.
   */
  const child = spawn(adbPath, adbArgv(args), { stdio: ["ignore", "pipe", "pipe"] });

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
  });

  return { pid, child };
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
