import { FAILURE_CODES, FailureError } from "@argent/registry";
import { runVega } from "./vega-cli";
import { runAdb, parseAdbDevices } from "./adb";
import { listRunningVvdConsolePorts, listRunningVvdPids } from "./vega-process";

/**
 * VVD lifecycle — start / stop / liveness. Running-VVD console-port discovery lives
 * in `vega-process.ts`; this module wraps it and drives `vega virtual-device
 * start|stop`. argent never speaks QMP — all device I/O goes through `adb`.
 */

/**
 * Thrown when >1 VVD is running — v1 can't tell which one a call targets. Typed so
 * callers that otherwise swallow discovery failures (e.g. `describe`) re-throw it.
 */
export class MultipleVegaDevicesError extends FailureError {
  constructor(consolePorts: number[]) {
    super(
      `Multiple Vega Virtual Devices detected (console ports: ${consolePorts.join(", ")}). ` +
        "argent v1 targets a single running VVD and cannot tell which one a tool call " +
        "refers to — stop all but one VVD and retry.",
      {
        error_code: FAILURE_CODES.VEGA_MULTIPLE_DEVICES,
        failure_stage: "vega_resolve_console_port_multiple",
        failure_area: "tool_server",
        error_kind: "unsupported",
      }
    );
    this.name = "MultipleVegaDevicesError";
  }
}

const ADB_READY_POLL_MS = 400;

// A VVD registers on adb (`emulator-<port>`) a beat after its process appears, so a
// tool call right after boot can resolve a port whose adb transport isn't up yet.
// Poll `adb devices` (transport-only — the non-Android guest has no
// `getprop sys.boot_completed`, so `waitForBootCompleted` can't be reused) so callers
// get a drivable serial instead of a downstream "device not found".
async function waitForAdbDevice(serial: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { stdout } = await runAdb(["devices"], { timeoutMs: 5_000 }).catch(() => ({
      stdout: "",
    }));
    if (parseAdbDevices(stdout).some((d) => d.serial === serial && d.state === "device")) return;
    if (Date.now() >= deadline) {
      throw new FailureError(
        `Vega VVD is running (${serial}) but it has not registered with adb yet — its adb ` +
          "transport may still be coming up. Retry in a moment.",
        {
          error_code: FAILURE_CODES.VEGA_DEVICE_NOT_REGISTERED,
          failure_stage: "vega_adb_register",
          failure_area: "tool_server",
          // We polled until the deadline and adb never enumerated the transport,
          // so the failure is structurally a timeout. The distinct error_code
          // (vs VEGA_BOOT_TIMEOUT, the VVD never starting) already carries the
          // "registered vs started" distinction — error_kind reflects the true
          // nature (deadline expiry) rather than double-encoding that.
          error_kind: "timeout",
        }
      );
    }
    await new Promise((r) => setTimeout(r, ADB_READY_POLL_MS));
  }
}

/**
 * The single running VVD's console port → its `emulator-<port>` adb serial (the
 * target every Vega tool drives), once that serial is adb-ready (registration lags
 * VVD start). Throws if none runs / never registers; `MultipleVegaDevicesError` if >1.
 */
export async function discoverVegaConsolePort(
  opts: { adbReadyTimeoutMs?: number } = {}
): Promise<number> {
  const ports = await listRunningVvdConsolePorts();
  if (ports.size === 0) {
    throw new FailureError(
      "No running Vega Virtual Device found. Start one with `boot-device {vvdImage:...}` " +
        "(or `vega virtual-device start`) and retry.",
      {
        error_code: FAILURE_CODES.VEGA_DEVICE_NOT_FOUND,
        failure_stage: "vega_discover_console_port",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  if (ports.size > 1) throw new MultipleVegaDevicesError([...ports]);
  const port = [...ports][0]!;
  await waitForAdbDevice(`emulator-${port}`, opts.adbReadyTimeoutMs ?? 8_000);
  return port;
}

export async function isVvdRunning(): Promise<boolean> {
  // The OS process table is the authoritative running-VVD signal (a `vega`/`kepler`
  // `-virtual-device` QEMU process). `vega device list` is unreliable here: a stray
  // `adb connect` switches it to adb-form rows that report no VirtualDevice, so a
  // plainly-running VVD would read as stopped — and `boot-device` would then start a
  // second one. `listRunningVvdConsolePorts` is the same probe the adb channel uses.
  try {
    return (await listRunningVvdConsolePorts()).size > 0;
  } catch {
    return false;
  }
}

export async function startVvd(params: {
  timeoutSeconds: number;
  imagePath?: string;
}): Promise<void> {
  // `-p <package root>` selects which installed image to boot; without it the CLI
  // boots the SDK default, so a `vvdImage` selector would be silently ignored.
  const args = ["virtual-device", "start", "-t", String(params.timeoutSeconds)];
  if (params.imagePath) args.push("-p", params.imagePath);
  await runVega(args, {
    timeoutMs: params.timeoutSeconds * 1_000 + 15_000,
  });
}

const STOP_KILL_GRACE_MS = 4_000;
const STOP_VERIFY_POLL_MS = 300;

export async function stopVvd(
  options: { timeoutMs?: number; killGraceMs?: number; verifyPollMs?: number } = {}
): Promise<void> {
  // Graceful first — ask the CLI to stop the VVD it tracks — but best-effort: when
  // the CLI has lost track of a running VVD it exits non-zero with "virtual device
  // not running" (the same staleness that makes `vega virtual-device status`
  // misreport). An argent-booted VVD — started via `vega virtual-device start -t N`,
  // which returns once boot completes rather than staying foreground — is routinely
  // in this state, so a throwing stop must not abort the caller (e.g. a force reboot
  // in boot-device, which would otherwise fail outright and leave the VVD running).
  await runVega(["virtual-device", "stop"], { timeoutMs: options.timeoutMs ?? 60_000 }).catch(
    (err) => {
      // Tolerated (the ps probe below tears the device down regardless), but logged so a
      // genuine stop failure for a VVD the CLI *was* tracking is diagnosable, not silent.
      process.stderr.write(`[vega-vvd] \`vega virtual-device stop\` failed: ${String(err)}\n`);
    }
  );
  // Detection already trusts the OS process table over the CLI (see `isVvdRunning`);
  // make stop symmetric. Terminate any VVD emulator process the ps probe still
  // finds — SIGTERM, then SIGKILL the stragglers — so a stop the CLI no-oped (or
  // refused) still tears the device down instead of leaking the qemu process.
  await terminateStrayVvdProcesses(
    options.killGraceMs ?? STOP_KILL_GRACE_MS,
    options.verifyPollMs ?? STOP_VERIFY_POLL_MS
  );
}

async function terminateStrayVvdProcesses(graceMs: number, pollMs: number): Promise<void> {
  const pids = await listRunningVvdPids();
  if (pids.length === 0) return;
  for (const pid of pids) signalQuietly(pid, "SIGTERM");
  // Give SIGTERM a chance to bring the emulator down cleanly, then escalate.
  if (await waitForVvdGone(graceMs, pollMs)) return;
  for (const pid of await listRunningVvdPids()) signalQuietly(pid, "SIGKILL");
  // Mirror the post-SIGTERM grace poll: don't return while a just-killed qemu could still
  // be in the ps probe, or the next force-reboot's start would read it as a second VVD and
  // trip `MultipleVegaDevicesError`. (Orphaned qemu reparents to launchd and reaps fast.)
  await waitForVvdGone(graceMs, pollMs);
}

// Poll the ps probe until no VVD process is left, up to `graceMs`. Returns whether the VVD
// went away within the window.
async function waitForVvdGone(graceMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!(await isVvdRunning())) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !(await isVvdRunning());
}

// `process.kill` throws ESRCH if the pid already exited and EPERM if it isn't ours;
// either way there's nothing left to do for that pid, so swallow just those. Anything
// else (e.g. EINVAL from a bad signal) is a real bug — let it surface.
function signalQuietly(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw err;
    /* already gone or not ours */
  }
}

const VVD_RUNNING_POLL_INTERVAL_MS = 1_000;

export async function waitForVvdRunning(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isVvdRunning()) return;
    await new Promise((r) => setTimeout(r, VVD_RUNNING_POLL_INTERVAL_MS));
  }
  throw new FailureError(
    `Vega Virtual Device did not appear in \`vega device list\` within ` +
      `${Math.round(timeoutMs / 1000)}s of \`vega virtual-device start\`.`,
    {
      error_code: FAILURE_CODES.VEGA_BOOT_TIMEOUT,
      failure_stage: "vega_wait_running",
      failure_area: "tool_server",
      error_kind: "timeout",
    }
  );
}
