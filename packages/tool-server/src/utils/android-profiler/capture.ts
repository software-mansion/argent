import { spawn, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import { traceConfigPath } from "@argent/native-devtools-android";
import { resolveAndroidBinary } from "../android-binary";
import { runAdb, adbShell } from "../adb";

const ON_DEVICE_TRACE_DIR = "/data/misc/perfetto-traces";
const START_TIMEOUT_MS = 15_000;
const STOP_POLL_INTERVAL_MS = 200;
const STOP_TOTAL_TIMEOUT_MS = 30_000;
// Short per-call timeout for the stop-path liveness probes and kill signals.
// The default adb timeout is 30 s; on a dead/unplugged device the stop does
// several `adb shell` round-trips back-to-back, so the default makes a single
// stop block well over a minute before failing. A tight timeout (matching the
// device-enrichment probes in adb.ts) lets a dead device fail fast instead.
const STOP_PROBE_TIMEOUT_MS = 5_000;

/**
 * Fill the TARGET_*_PLACEHOLDER tokens in the bundled tracecfg with the app
 * package — the process cmdline is the package unless the manifest sets
 * `android:process=...`.
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

export interface StartPerfettoOptions {
  serial: string;
  appPackage: string;
  /** Timestamp slug for the on-device filename. */
  timestamp: string;
}

export interface StartPerfettoResult {
  pid: number;
  onDeviceTracePath: string;
  /** The host-side `adb shell` ChildProcess. Exits when stdin is closed after --background-wait returns. */
  child: ChildProcess;
}

/**
 * Start a perfetto recording on the target device.
 *
 * Two live-tested constraints drive the shape here: SELinux denies `shell:s0`
 * writes to /data/misc/perfetto-traces/, so the config is piped to perfetto on
 * stdin (`--txt -c -`) rather than pushed as a file; and `--background-wait`
 * prints the daemon PID on stdout once data sources start, so we take the last
 * non-empty stdout line (warnings may precede it).
 * rationale: utils/android-profiler/ANDROID_PROFILER_REFERENCE.md "2. Capture"
 */
export async function startPerfetto(
  opts: StartPerfettoOptions
): Promise<StartPerfettoResult> {
  const adbPath = await resolveAndroidBinary("adb");
  if (!adbPath) {
    throw new Error(
      "`adb` not found on PATH or under `$ANDROID_HOME/platform-tools`. " +
        "Install Android SDK Platform Tools or set `$ANDROID_HOME` to your SDK root."
    );
  }

  const cfgText = await buildTraceConfig(opts.appPackage);
  const onDeviceTracePath = `${ON_DEVICE_TRACE_DIR}/argent-${opts.timestamp}.pftrace`;

  // Config on stdin, PID on stdout (see JSDoc). The host adb shell exits when
  // stdin closes; the on-device daemon keeps running.
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
        new Error(
          `perfetto did not return a PID within ${START_TIMEOUT_MS} ms. ` +
            `stdout: ${stdout.trim() || "<empty>"} | stderr: ${stderr.trim() || "<empty>"}`
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

    // An exec failure (binary vanished after the resolve check, EACCES) makes
    // the child emit 'error', and writing to a broken stdin emits 'error' on
    // the stream. An 'error' event with no listener THROWS as an uncaught
    // exception that can take down the whole server — so reject the start
    // promise instead.
    child.on("error", (err) =>
      fail(new Error(`Failed to launch adb for perfetto: ${err.message}`))
    );
    child.stdin.on("error", (err) =>
      fail(new Error(`Failed to write perfetto config to adb stdin: ${err.message}`))
    );

    // `final` is true only from the exit handler: once the process has ended,
    // stdout is complete, so a trailing PID with no newline is safe to parse.
    const tryResolve = (final = false) => {
      const trimmed = stdout.trim();
      if (!trimmed) return;
      // While streaming, only parse once the buffer ends in a newline — i.e.
      // the last line is complete. A chunk split mid-number (`…\n123`) would
      // otherwise resolve a truncated PID, leaving the real daemon orphaned and
      // unstoppable.
      if (!final && !stdout.endsWith("\n")) return;
      // Take the LAST non-empty line — perfetto may print warnings before the PID.
      const lastLine = trimmed.split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (!lastLine) return;
      const parsed = parseInt(lastLine, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      succeed(parsed);
    };

    child.stdout.on("data", () => tryResolve());
    child.once("exit", (code) => {
      if (settled) return;
      // If perfetto exited before printing the PID, surface stderr.
      if (stdout.trim() === "") {
        fail(
          new Error(
            `perfetto exited (code=${code}) before printing a PID. ` +
              `stderr: ${stderr.trim() || "<empty>"}`
          )
        );
        return;
      }
      // Stream is final — parse the last line even without a trailing newline.
      tryResolve(true);
      // The process is gone; if no valid PID was found, fail now rather than
      // hanging until the start timeout fires.
      fail(
        new Error(
          `perfetto exited (code=${code}) without a valid PID on its last stdout line. ` +
            `stdout: ${stdout.trim()} | stderr: ${stderr.trim() || "<empty>"}`
        )
      );
    });

    // Pipe the config via stdin and close — perfetto reads to EOF. Inside the
    // executor so a synchronous throw rejects the promise rather than escaping.
    try {
      child.stdin.write(cfgText);
      child.stdin.end();
    } catch (err) {
      fail(
        new Error(
          `Failed to write perfetto config to adb stdin: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      );
    }
  });

  return { pid, onDeviceTracePath, child };
}

export interface StopPerfettoOptions {
  serial: string;
  pid: number;
  onDeviceTracePath: string;
  hostTracePath: string;
  /** True if the 10-min cap already fired and SIGTERM was already sent. */
  recordingTimedOut?: boolean;
}

export interface StopPerfettoResult {
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
  // First-poll check: if the daemon is already gone, skip the SIGTERM and pull
  // whatever's on disk.
  let aliveBeforeSignal = false;
  try {
    const out = await adbShell(
      opts.serial,
      `[ -d /proc/${opts.pid} ] && echo alive || echo gone`,
      { timeoutMs: STOP_PROBE_TIMEOUT_MS }
    );
    aliveBeforeSignal = out.trim() === "alive";
  } catch {
    // probe failed; assume alive so we still try SIGTERM
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
        // ignored — the next poll loop will surface the state
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
