import { runVega } from "./vega-cli";
import { runAdb, parseAdbDevices } from "./adb";
import { listRunningVvdConsolePorts } from "./vega-process";

/**
 * VVD lifecycle — start / stop / liveness. Running-VVD console-port discovery lives
 * in `vega-process.ts`; this module wraps it and drives `vega virtual-device
 * start|stop`. argent never speaks QMP — all device I/O goes through `adb`.
 */

/**
 * Thrown when >1 VVD is running — v1 can't tell which one a call targets. Typed so
 * callers that otherwise swallow discovery failures (e.g. `describe`) re-throw it.
 */
export class MultipleVegaDevicesError extends Error {
  constructor(consolePorts: number[]) {
    super(
      `Multiple Vega Virtual Devices detected (console ports: ${consolePorts.join(", ")}). ` +
        "argent v1 targets a single running VVD and cannot tell which one a tool call " +
        "refers to — stop all but one VVD and retry."
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
      throw new Error(
        `Vega VVD is running (${serial}) but it has not registered with adb yet — its adb ` +
          "transport may still be coming up. Retry in a moment."
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
    throw new Error(
      "No running Vega Virtual Device found. Start one with `boot-device {vvdImage:...}` " +
        "(or `vega virtual-device start`) and retry."
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

export async function stopVvd(options: { timeoutMs?: number } = {}): Promise<void> {
  await runVega(["virtual-device", "stop"], { timeoutMs: options.timeoutMs ?? 60_000 });
}

const VVD_RUNNING_POLL_INTERVAL_MS = 1_000;

export async function waitForVvdRunning(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isVvdRunning()) return;
    await new Promise((r) => setTimeout(r, VVD_RUNNING_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Vega Virtual Device did not appear in \`vega device list\` within ` +
      `${Math.round(timeoutMs / 1000)}s of \`vega virtual-device start\`.`
  );
}
