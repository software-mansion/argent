import { FAILURE_CODES, FailureError } from "@argent/registry";
import { runVega } from "./vega-cli";
import { runAdb, parseAdbDevices } from "./adb";
import { listRunningVvdConsolePorts, listRunningVvdPids } from "./vega-process";

/**
 * VVD lifecycle (start / stop / liveness) over `vega virtual-device`; console-port
 * discovery lives in `vega-process.ts`. All device I/O goes through `adb`, never QMP.
 */

/** Typed so callers that otherwise swallow discovery failures (e.g. `describe`) re-throw it. */
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

// A VVD registers on adb (`emulator-<port>`) a beat after its process appears, so a port
// resolved right after boot can have no adb transport yet. `waitForBootCompleted` can't be
// reused: the non-Android guest has no `getprop sys.boot_completed`.
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
          // Deadline expiry, hence `timeout`; the error_code already separates this
          // from VEGA_BOOT_TIMEOUT (the VVD never starting).
          error_kind: "timeout",
        }
      );
    }
    await new Promise((r) => setTimeout(r, ADB_READY_POLL_MS));
  }
}

/**
 * Console port of the single running VVD, once its `emulator-<port>` adb serial is
 * registered (registration lags VVD start). `MultipleVegaDevicesError` if >1 runs.
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
  // The process table, not `vega device list`: a stray `adb connect` switches that list
  // to adb-form rows reporting no VirtualDevice, so a running VVD would read as stopped
  // and `boot-device` would start a second one.
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
  // `-p <package root>` selects which installed image to boot; without it the CLI boots
  // the SDK default and `vvdImage` would be silently ignored.
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
  // Best-effort: the CLI exits non-zero with "virtual device not running" once it has
  // lost track of a VVD — routine for one argent booted via `vega virtual-device start
  // -t N` — and a throwing stop must not abort callers like boot-device's force reboot.
  await runVega(["virtual-device", "stop"], { timeoutMs: options.timeoutMs ?? 60_000 }).catch(
    (err) => {
      // The ps probe below tears the device down regardless; logged so a genuine stop
      // failure for a VVD the CLI *was* tracking isn't silent.
      process.stderr.write(`[vega-vvd] \`vega virtual-device stop\` failed: ${String(err)}\n`);
    }
  );
  // Symmetric with `isVvdRunning`: trust the process table, so a stop the CLI no-oped
  // (or refused) still tears the device down instead of leaking the qemu process.
  await terminateStrayVvdProcesses(
    options.killGraceMs ?? STOP_KILL_GRACE_MS,
    options.verifyPollMs ?? STOP_VERIFY_POLL_MS
  );
}

async function terminateStrayVvdProcesses(graceMs: number, pollMs: number): Promise<void> {
  const pids = await listRunningVvdPids();
  if (pids.length === 0) return;
  for (const pid of pids) signalQuietly(pid, "SIGTERM");
  if (await waitForVvdGone(graceMs, pollMs)) return;
  for (const pid of await listRunningVvdPids()) signalQuietly(pid, "SIGKILL");
  // Don't return while a just-killed qemu can still show in the ps probe, or the next
  // force-reboot's start would read it as a second VVD and trip `MultipleVegaDevicesError`.
  await waitForVvdGone(graceMs, pollMs);
}

async function waitForVvdGone(graceMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!(await isVvdRunning())) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !(await isVvdRunning());
}

// ESRCH (pid already exited) and EPERM (not ours) leave nothing to do; anything else
// (e.g. EINVAL from a bad signal) is a real bug — let it surface.
function signalQuietly(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw err;
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
