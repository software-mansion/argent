import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { FAILURE_CODES, subprocessFailureMetadata, withFailureSignal } from "@argent/registry";
import { appendHintToMessage } from "./usbmux-protocol";

/**
 * Wrappers around `xcrun devicectl` for discovery, app lifecycle, and connection readiness.
 */

const execFileAsync = promisify(execFile);

const DEVICECTL_TIMEOUT_MS = 20_000;
const DEVICECTL_INSTALL_TIMEOUT_MS = 120_000;
const DEVICECTL_LIST_TIMEOUT_MS = 8_000;
const DEVICECTL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface IosPhysicalDevice {
  /** Dashed hardware UDID (e.g. `00008110-000978540290401E`). */
  udid: string;
  name: string;
  /** Marketing name when available (e.g. "iPhone 13"). */
  model: string | null;
  osVersion: string | null;
  developerModeEnabled: boolean | null;
  /** CoreDevice pairing state, e.g. "paired". */
  pairingState: string | null;
  /**
   * How CoreDevice currently reaches the device. "wired" while cabled, "localNetwork" once unplugged.
   */
  transportType: string | null;
  tunnelState: string | null;
}

class IosDeviceControlError extends Error {
  /** Callers may branch on this. The message already includes the same text. */
  readonly hint: string | null;

  constructor(message: string, opts?: { hint?: string; cause?: unknown }) {
    super(appendHintToMessage(message, opts?.hint));

    this.name = "IosDeviceControlError";
    this.hint = opts?.hint ?? null;

    if (opts?.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

/** Map devicectl failure output to an actionable hint. */
function resolveDevicectlHint(output: string): string {
  const lower = output.toLowerCase();

  // CoreDeviceError 10002 covers any failed preflight check: a locked screen
  // is the common cause, but a pending system prompt blocks launches too.
  if (lower.includes("failed to launch") || lower.includes("10002")) {
    return "Unlock the device and keep the screen awake, then retry; if it is already unlocked, check the phone's screen: a pending system prompt (for example a default-app choice) also blocks launches.";
  }

  if (lower.includes("developer disk image") || lower.includes("developer mode is disabled")) {
    return (
      "Enable Developer Mode on the device (Settings > Privacy & Security > " +
      "Developer Mode), restart it when prompted, then retry."
    );
  }

  if (lower.includes("must be paired") || lower.includes("pairing")) {
    return "Connect the device by cable, accept the Trust prompt, enter the device passcode, then retry.";
  }

  if (lower.includes("device is busy") || lower.includes("connecting")) {
    return "Keep the device unlocked and connected until it shows as available in Xcode > Devices, then retry.";
  }

  if (lower.includes("timed out")) {
    return "Reconnect the cable, unlock the device, and retry; restarting Xcode's device services can help.";
  }

  return "Ensure the device is unlocked, trusted, and visible in Xcode > Devices, then retry.";
}

interface RunDevicectlOptions {
  timeoutMs?: number;
  /** When set, appends `--json-output <tmpfile>` and returns the parsed JSON. */
  json?: boolean;
}

async function runDevicectl(
  args: string[],
  action: string,
  opts: RunDevicectlOptions = {}
): Promise<{ stdout: string; stderr: string; json: unknown | null }> {
  const timeoutMs = opts.timeoutMs ?? DEVICECTL_TIMEOUT_MS;
  let jsonPath: string | null = null;
  const argv = ["devicectl", ...args];

  if (opts.json) {
    // devicectl writes JSON to a file. stdout and stderr are only for error-hint matching.
    jsonPath = path.join(os.tmpdir(), `argent-devicectl-${process.pid}-${randomUUID()}.json`);
    argv.push("--json-output", jsonPath);
  }

  try {
    const { stdout, stderr } = await execFileAsync("xcrun", argv, {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: DEVICECTL_MAX_OUTPUT_BYTES,
    });

    let json: unknown | null = null;

    if (jsonPath) {
      try {
        json = JSON.parse(await fs.readFile(jsonPath, "utf8"));
      } catch {
        json = null;
      }
    }

    return { stdout, stderr, json };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout ?? "", e.stderr ?? "", e.message ?? ""].join("\n");

    // Error payloads are still written to --json-output. Keep them for callers.
    let errorJson: unknown | null = null;

    if (jsonPath) {
      try {
        errorJson = JSON.parse(await fs.readFile(jsonPath, "utf8"));
      } catch {
        errorJson = null;
      }
    }

    throw withFailureSignal(
      new IosDeviceControlError(`Failed to ${action}: ${firstLine(e.stderr || e.message)}`, {
        hint: resolveDevicectlHint(output),
        cause: Object.assign(error as Error, { devicectlJson: errorJson }),
      }),
      {
        error_code: FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED,
        failure_stage: "ios_devicectl_command",
        failure_area: "tool_server",
        error_kind: "subprocess",
        ...subprocessFailureMetadata(error, "devicectl"),
      }
    );
  } finally {
    if (jsonPath) await fs.rm(jsonPath, { force: true }).catch(() => {});
  }
}

function firstLine(text: string | undefined): string {
  return (text ?? "").trim().split("\n")[0] ?? "";
}

interface DevicectlListPayload {
  result?: {
    devices?: Array<{
      identifier?: string;
      hardwareProperties?: {
        udid?: string;
        platform?: string;
        productType?: string;
        marketingName?: string;
        reality?: string;
      };
      deviceProperties?: {
        name?: string;
        osVersionNumber?: string;
        developerModeStatus?: string;
      };
      connectionProperties?: {
        pairingState?: string;
        transportType?: string;
        tunnelState?: string;
      };
    }>;
  };
}

/**
 * List physical iOS-family devices CoreDevice can currently see.
 * Returns an empty list when devicectl is missing or fails.
 */
export async function listIosPhysicalDevices(): Promise<IosPhysicalDevice[]> {
  if (process.platform !== "darwin") {
    return [];
  }

  try {
    const { json } = await runDevicectl(["list", "devices"], "list devices", {
      json: true,
      timeoutMs: DEVICECTL_LIST_TIMEOUT_MS,
    });

    const payload = json as DevicectlListPayload | null;
    const devices = payload?.result?.devices ?? [];
    const out: IosPhysicalDevice[] = [];

    for (const d of devices) {
      const hardwareProperties = d.hardwareProperties ?? {};
      const udid = hardwareProperties.udid ?? d.identifier;

      if (!udid) {
        continue;
      }

      const platform = (hardwareProperties.platform ?? "").toLowerCase();
      const productType = hardwareProperties.productType ?? null;

      const isSupportedProductType = /^(iphone|ipad)/i.test(productType ?? "");

      if (platform !== "ios" && !isSupportedProductType) {
        continue;
      }

      // Physical hardware only. Real phones report reality "physical". Simulators report "simulated".
      // The field is absent on older toolchains. Only an explicit non-physical value skips the row.
      if (hardwareProperties.reality != null && hardwareProperties.reality !== "physical") {
        continue;
      }

      out.push({
        udid,
        name: d.deviceProperties?.name ?? productType ?? udid,
        model: hardwareProperties.marketingName ?? productType ?? null,
        osVersion: d.deviceProperties?.osVersionNumber ?? null,
        developerModeEnabled:
          d.deviceProperties?.developerModeStatus == null
            ? null
            : d.deviceProperties.developerModeStatus === "enabled",
        pairingState: d.connectionProperties?.pairingState ?? null,
        transportType: d.connectionProperties?.transportType ?? null,
        tunnelState: d.connectionProperties?.tunnelState ?? null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Install a .app / .ipa onto the device. */
export async function installApp(udid: string, installablePath: string): Promise<void> {
  await runDevicectl(
    ["device", "install", "app", "--device", udid, installablePath],
    "install app",
    {
      timeoutMs: DEVICECTL_INSTALL_TIMEOUT_MS,
    }
  );
}

/** Uninstall by bundle id. Missing apps count as success. */
export async function uninstallApp(udid: string, bundleId: string): Promise<void> {
  try {
    await runDevicectl(["device", "uninstall", "app", "--device", udid, bundleId], "uninstall app");
  } catch (error) {
    const text = String((error as Error & { cause?: { stderr?: string } }).cause?.stderr ?? error);

    if (/not installed|not found|no such file/i.test(text)) {
      return;
    }

    throw error;
  }
}

interface LaunchAppOptions {
  terminateExisting?: boolean;
}

/**
 * Launch an installed app by bundle id.
 *
 * @param opts.terminateExisting kill an already-running instance first.
 */
export async function launchApp(
  udid: string,
  bundleId: string,
  opts: LaunchAppOptions = {}
): Promise<void> {
  const args = ["device", "process", "launch", "--device", udid];

  if (opts.terminateExisting) {
    args.push("--terminate-existing");
  }

  args.push(bundleId);
  await runDevicectl(args, `launch ${bundleId}`);
}

interface DeviceConnectionInfo {
  transportType: string | null;
  tunnelState: string | null;
}

interface DevicectlDetailsPayload {
  result?: {
    connectionProperties?: { transportType?: string; tunnelState?: string };
    device?: { connectionProperties?: { transportType?: string; tunnelState?: string } };
  };
}

/**
 * Read the device's CoreDevice connection details.
 */
async function deviceInfoDetails(
  udid: string,
  opts: { timeoutSeconds?: number } = {}
): Promise<DeviceConnectionInfo> {
  const timeoutSeconds = opts.timeoutSeconds ?? 10;

  const { json } = await runDevicectl(
    ["device", "info", "details", "--device", udid, "--timeout", String(timeoutSeconds)],
    "read device details",
    { json: true, timeoutMs: (timeoutSeconds + 5) * 1000 }
  );

  const payload = json as DevicectlDetailsPayload | null;

  const conn =
    payload?.result?.connectionProperties ?? payload?.result?.device?.connectionProperties;

  return {
    transportType: conn?.transportType ?? null,
    tunnelState: conn?.tunnelState ?? null,
  };
}

const READY_MEMO_TTL_MS = 5_000;
const readyMemo = new Map<string, number>();

/**
 * Ensure the device is on USB and its CoreDevice tunnel is ready.
 */
export async function ensureDeviceReady(udid: string): Promise<void> {
  // Memoized for 5s. Callers hit this on the hot path.
  const at = readyMemo.get(udid);

  if (at != null && Date.now() - at < READY_MEMO_TTL_MS) {
    return;
  }

  // An unplugged paired device can keep a network tunnel. usbmux still needs the cable.
  const info = await deviceInfoDetails(udid, { timeoutSeconds: 15 });

  // Older toolchains omit transportType. Only an explicit non-wired value rejects.
  if (info.transportType != null && info.transportType !== "wired") {
    throw new IosDeviceControlError(`Device transport is ${info.transportType}, not wired`, {
      hint: "Connect the device by USB cable and unlock it, then retry.",
    });
  }

  if (info.tunnelState === "connecting") {
    throw new IosDeviceControlError("Device tunnel is still connecting", {
      hint: "Keep the device unlocked and connected; retry in a few seconds.",
    });
  }

  readyMemo.set(udid, Date.now());
}
