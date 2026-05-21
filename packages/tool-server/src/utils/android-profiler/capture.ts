import { spawn, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { resolveAndroidBinary } from "../android-binary";
import { runAdb, adbShell } from "../adb";

const ON_DEVICE_TRACE_DIR = "/data/misc/perfetto-traces";
const START_TIMEOUT_MS = 15_000;
const STOP_POLL_INTERVAL_MS = 200;
const STOP_TOTAL_TIMEOUT_MS = 30_000;

const BUNDLED_TRACECFG_PATH = path.resolve(__dirname, "argent.tracecfg.pbtxt");

/**
 * Substitute the TARGET_*_PLACEHOLDER tokens in the bundled tracecfg with the
 * resolved app package. `target_cmdline` and the `atrace_apps` entry both
 * take the package name (the process cmdline for an Android app is its
 * package, unless the manifest overrides `android:process=...`).
 */
export async function buildTraceConfig(
  appPackage: string,
  configTemplate: string | null = null
): Promise<string> {
  const tpl = configTemplate ?? (await fs.readFile(BUNDLED_TRACECFG_PATH, "utf8"));
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
 * Live-tested constraints (see plan §"Live-emulator findings"):
 *   - /data/misc/perfetto-traces/ is `drwxrwx-wx` but SELinux denies
 *     `shell:s0` writes, so we cannot push the config file there via
 *     `cat > /data/misc/...`. Pipe the config to perfetto on stdin instead
 *     (`perfetto --txt -c -`). `traced` (privileged) writes the .pftrace.
 *   - `--background-wait` blocks until all data sources are started AND
 *     prints the PID on stdout. The PID is the only line we need; tolerate
 *     warnings preceding it by taking the last non-empty stdout line.
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

  // `perfetto --txt -c - --background-wait -o <path>` reads the textproto config
  // from stdin and prints the on-device daemon's PID on stdout once data sources
  // are running. The host-side adb shell exits when stdin closes after the
  // --background-wait return; the daemon keeps running on the device.
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

  // Pipe the config via stdin and close — perfetto reads to EOF.
  child.stdin.write(cfgText);
  child.stdin.end();

  const pid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      reject(
        new Error(
          `perfetto did not return a PID within ${START_TIMEOUT_MS} ms. ` +
            `stdout: ${stdout.trim() || "<empty>"} | stderr: ${stderr.trim() || "<empty>"}`
        )
      );
    }, START_TIMEOUT_MS);

    const tryResolve = () => {
      const trimmed = stdout.trim();
      if (!trimmed) return;
      // Take the LAST non-empty line — perfetto may print warnings before the PID.
      const lastLine = trimmed.split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (!lastLine) return;
      const parsed = parseInt(lastLine, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      clearTimeout(timer);
      resolve(parsed);
    };

    child.stdout.on("data", tryResolve);
    child.once("exit", (code) => {
      clearTimeout(timer);
      // If perfetto exited before printing the PID, surface stderr.
      if (stdout.trim() === "") {
        reject(
          new Error(
            `perfetto exited (code=${code}) before printing a PID. ` +
              `stderr: ${stderr.trim() || "<empty>"}`
          )
        );
        return;
      }
      tryResolve();
    });
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
 * up the on-device file. SIGTERM → poll /proc/$pid → adb pull → rm.
 *
 * If /proc/$pid is already gone on the first poll (perfetto exited early —
 * the device-side daemon was killed, the trace_processor crashed, etc.) we
 * still attempt the pull and surface a partial-trace warning, mirroring the
 * iOS recordingExitedUnexpectedly path.
 */
export async function stopPerfetto(opts: StopPerfettoOptions): Promise<StopPerfettoResult> {
  // First-poll check: if the daemon is already gone, skip the SIGTERM and pull
  // whatever's on disk.
  let aliveBeforeSignal = false;
  try {
    const out = await adbShell(
      opts.serial,
      `[ -d /proc/${opts.pid} ] && echo alive || echo gone`
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
        await adbShell(opts.serial, `kill -TERM ${opts.pid}`);
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
          `[ -d /proc/${opts.pid} ] && echo alive || echo gone`
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
        await adbShell(opts.serial, `kill -KILL ${opts.pid}`);
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
