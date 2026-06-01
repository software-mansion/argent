import * as net from "node:net";
import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { execFile, ChildProcess } from "node:child_process";
import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { axServiceBinaryPath } from "@argent/native-devtools-ios";
import { SIMCTL_SPAWN_TIMEOUT_MS } from "../utils/simctl-config";

const execFileAsync = promisify(execFile);

export const AX_SERVICE_NAMESPACE = "AXService";

// Same DeviceInfo-via-options pattern as the other iOS-only blueprints.
type AxServiceFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

/**
 * Build the `ServiceRef` for the AX service keyed by an already-resolved
 * `DeviceInfo`. The factory's iOS-only check uses the caller's classification
 * rather than running its own.
 */
export function axServiceRef(device: DeviceInfo): {
  urn: string;
  options: AxServiceFactoryOptions;
} {
  return {
    urn: `${AX_SERVICE_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

export interface AXDescribeElement {
  label?: string;
  frame?: { x: number; y: number; width: number; height: number };
  tapPoint?: { x: number; y: number };
  traits?: string[];
  value?: string;
}

export interface AXDescribeResponse {
  alertVisible: boolean;
  screenFrame?: { width: number; height: number };
  elements: AXDescribeElement[];
}

export interface AXServiceApi {
  /** True when AX prefs were written but SB hasn't picked them up yet (sim booted outside argent). */
  degraded: boolean;
  describe(): Promise<AXDescribeResponse>;
  alertCheck(): Promise<boolean>;
  ping(): Promise<boolean>;
}

function getSocketPath(udid: string): string {
  return `/tmp/ax-${udid.slice(0, 8)}.sock`;
}

function querySocket(socketPath: string, command: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        client.destroy();
        reject(new Error(`ax-service query timed out: ${command}`));
      }
    }, timeoutMs);

    const client = net.createConnection(socketPath, () => {
      client.write(command + "\n");
    });

    client.on("data", (chunk) => {
      data += chunk.toString();
    });

    client.on("end", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(data.trim());
      }
    });

    client.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

async function pingDaemon(socketPath: string): Promise<boolean> {
  try {
    const raw = await querySocket(socketPath, "ping", 2000);
    const parsed = JSON.parse(raw);
    return parsed.status === "ok";
  } catch {
    return false;
  }
}

export async function ensureAutomationEnabled(udid: string): Promise<void> {
  await execFileAsync(
    "xcrun",
    [
      "simctl",
      "spawn",
      udid,
      "defaults",
      "write",
      "com.apple.Accessibility",
      "AutomationEnabled",
      "-bool",
      "true",
    ],
    { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
  );
}

/**
 * Check whether `IgnoreAXServerEntitlements` is active on this sim.
 *
 * iOS 26.5+: SB's AX server rejects unentitled MIG clients with
 * kAXError -25215. The pref disables the check, but SB caches it at
 * init — writing it post-boot has no effect until the next restart.
 * The only effective path is the pre-boot plist write in boot-device.
 *
 * This read-only probe tells the caller whether the pre-boot write
 * happened so describe can surface a degraded-quality hint when it didn't.
 */
export async function isEntitlementBypassActive(udid: string): Promise<boolean> {
  return execFileAsync(
    "xcrun",
    [
      "simctl",
      "spawn",
      udid,
      "defaults",
      "read",
      "com.apple.Accessibility",
      "IgnoreAXServerEntitlements",
    ],
    { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
  )
    .then(({ stdout }) => stdout.trim() === "1")
    .catch(() => false);
}

/**
 * Host-side `com.apple.Accessibility` plist inside the sim's data container.
 * Writeable while Shutdown; in-sim cfprefsd overwrites it once Booted.
 */
function accessibilityPlistPath(udid: string): string {
  return path.join(
    os.homedir(),
    "Library/Developer/CoreSimulator/Devices",
    udid,
    "data/Library/Preferences/com.apple.Accessibility.plist"
  );
}

/**
 * Write the four AX prefs to the sim's host plist BEFORE `simctl boot` so SB
 * caches them at AX-server init and never needs the disruptive kickstart
 * (which kills the foreground app and dismisses in-flight system alerts).
 *
 * All four are required on a freshly-erased sim:
 * - `IgnoreAXServerEntitlements` bypasses the iOS 26.5+ kAXErrorNotEntitled check.
 * - `AutomationEnabled` opts the simctl-spawned ax-service in as an AX client.
 * - `AccessibilityEnabled` + `ApplicationAccessibilityEnabled` gate the AT
 *   subsystem bootstrap. Without them SB never spawns `AccessibilityUIServer`
 *   and describe returns an empty ROOT even though the entitlement check passes
 *   (reproduced on a wiped iPhone 17e: AccessibilityUIServer active count = 0
 *   without these two; auto-spawns at boot with them).
 *
 * Caller must ensure the sim is Shutdown — in-sim cfprefsd would otherwise
 * overwrite this file on flush.
 */
export async function setAccessibilityPrefsPreBoot(udid: string): Promise<void> {
  const plistPath = accessibilityPlistPath(udid);
  await fsAsync.mkdir(path.dirname(plistPath), { recursive: true });
  const exists = await fsAsync
    .access(plistPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await execFileAsync("plutil", ["-create", "binary1", plistPath]);
  }
  for (const key of [
    "AutomationEnabled",
    "IgnoreAXServerEntitlements",
    "AccessibilityEnabled",
    "ApplicationAccessibilityEnabled",
  ]) {
    await execFileAsync("plutil", ["-replace", key, "-bool", "true", plistPath]);
  }
}

async function killExistingDaemon(socketPath: string): Promise<void> {
  try {
    const raw = await querySocket(socketPath, "ping", 2000);
    const parsed = JSON.parse(raw);
    if (parsed.pid) process.kill(parsed.pid, "SIGTERM");
  } catch {}
  try {
    fs.unlinkSync(socketPath);
  } catch {}
}

function spawnDaemon(udid: string, socketPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    let binaryPath: string;
    try {
      binaryPath = axServiceBinaryPath();
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const proc = execFile(
      "xcrun",
      ["simctl", "spawn", udid, binaryPath, "--socket", socketPath, "--timeout", "3600"],
      { encoding: "utf8" }
    ) as ChildProcess;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("Timed out waiting for ax-service to become ready"));
      }
    }, 10_000);

    let stdoutBuf = "";
    proc.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());
          if (msg.status === "ready" && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve(proc);
            return;
          }
        } catch {
          // not JSON yet — accumulate
        }
      }
    });

    // Defense-in-depth: a missing udid here would crash the process —
    // throwing inside an async listener bypasses promise rejection and
    // bubbles up as `uncaughtException`, which the tool-server treats as
    // fatal. Tag with "?" instead of dereferencing.
    const udidTag = typeof udid === "string" && udid.length > 0 ? udid.slice(0, 8) : "?";
    proc.stderr?.on("data", (data: string) => {
      process.stderr.write(`[ax-service ${udidTag}] ${data}`);
    });

    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`ax-service exited with code ${code} before becoming ready`));
      }
    });

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

export const axServiceBlueprint: ServiceBlueprint<AXServiceApi, DeviceInfo> = {
  namespace: AX_SERVICE_NAMESPACE,

  getURN(device: DeviceInfo) {
    return `${AX_SERVICE_NAMESPACE}:${device.id}`;
  },

  async factory(_deps, _payload, options) {
    const opts = options as unknown as AxServiceFactoryOptions | undefined;
    if (!opts?.device) {
      throw new Error(
        `${AX_SERVICE_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use axServiceRef(device) when registering the service ref.`
      );
    }

    const { device } = opts;
    if (device.platform !== "ios") {
      throw new Error(
        `${AX_SERVICE_NAMESPACE} is iOS-only. The target '${device.id}' classifies as Android — describe falls back to uiautomator on Android, which does not need this service.`
      );
    }
    // Reject before spawning. An undefined `device.id` slips through when an
    // inner tool is invoked via a wrapper that doesn't re-validate the inner
    // schema. Without this guard `getSocketPath(undefined).slice` would crash
    // and `udid.slice` in the stderr handler below would later be fatal.
    if (typeof device.id !== "string" || device.id.length === 0) {
      throw new Error(
        `${AX_SERVICE_NAMESPACE}.factory requires a non-empty device.id; got ${JSON.stringify(device.id)}.`
      );
    }

    const udid = device.id;
    const socketPath = getSocketPath(udid);
    const events = new TypedEventEmitter<ServiceEvents>();

    await ensureAutomationEnabled(udid);
    const entitlementBypassActive = await isEntitlementBypassActive(udid);
    await killExistingDaemon(socketPath);

    const proc = await spawnDaemon(udid, socketPath);

    proc.on("exit", (code) => {
      events.emit("terminated", new Error(`ax-service exited with code ${code}`));
    });
    proc.on("error", (err) => {
      events.emit("terminated", err);
    });

    async function query(command: string): Promise<unknown> {
      try {
        const raw = await querySocket(socketPath, command);
        return JSON.parse(raw);
      } catch (err) {
        events.emit("terminated", err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    }

    const api: AXServiceApi = {
      degraded: !entitlementBypassActive,

      async describe(): Promise<AXDescribeResponse> {
        const result = (await query("describe")) as AXDescribeResponse & {
          error?: string;
        };
        if (result.error) throw new Error(`ax-service describe error: ${result.error}`);
        return {
          alertVisible: result.alertVisible ?? false,
          screenFrame: result.screenFrame,
          elements: result.elements ?? [],
        };
      },

      async alertCheck(): Promise<boolean> {
        const result = (await query("alert_check")) as { alertVisible?: boolean };
        return result.alertVisible ?? false;
      },

      async ping(): Promise<boolean> {
        return pingDaemon(socketPath);
      },
    };

    const instance: ServiceInstance<AXServiceApi> = {
      api,
      dispose: async () => {
        if (proc && !proc.killed) {
          proc.kill("SIGTERM");
        }
        try {
          fs.unlinkSync(socketPath);
        } catch {}
      },
      events,
    };

    return instance;
  },
};
