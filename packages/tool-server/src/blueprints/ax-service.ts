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

  // iOS 26.5+: SpringBoard's AX server rejects MIG queries from non-UIApplication clients
  // (this `simctl spawn`-launched CLI) with kAXError -25215, so `describe` sees an empty
  // ROOT for any SB-hosted dialog (TCC prompts etc.). The debug pref
  // `com.apple.Accessibility/IgnoreAXServerEntitlements` disables the check, but SB caches
  // it at AX-server init — so we must restart SB after setting it. boot-device's iOS path
  // writes the pref directly to the host plist BEFORE `simctl boot`, so SB starts with
  // the bypass already cached and never needs the kickstart. This function is the
  // post-boot fallback: a simulator that was already booted when argent first touched it
  // (e.g. started by Xcode) won't have the pref cached, and the only way to enable
  // describe for SB-hosted dialogs on it is to kickstart SB now — losing the foreground
  // app and any in-flight system alert in the process.
  const isAlreadySet = await execFileAsync(
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

  if (!isAlreadySet) {
    await execFileAsync(
      "xcrun",
      [
        "simctl",
        "spawn",
        udid,
        "defaults",
        "write",
        "com.apple.Accessibility",
        "IgnoreAXServerEntitlements",
        "-bool",
        "true",
      ],
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
    );
    // Loud, single line so the calling agent sees in its tool output that SB is being
    // restarted — any foreground app launched between boot and this point is gone.
    process.stderr.write(
      `[ax ${udid.slice(0, 8)}] restarting SpringBoard to enable describe ` +
        `for SB-hosted dialogs (TCC prompts etc.). This dismisses any foreground app ` +
        `or in-flight system alert. boot-device avoids this by setting the pref ` +
        `pre-boot — reaching this path means the simulator was already booted ` +
        `outside of argent.\n`
    );
    // launchctl warns ("Please switch to user/foreground/...") but still restarts SB;
    // tolerate the non-zero exit.
    await execFileAsync(
      "xcrun",
      ["simctl", "spawn", udid, "launchctl", "kickstart", "-k", "system/com.apple.SpringBoard"],
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
    ).catch(() => undefined);
    // Block until SB has finished respawning so a subsequent tool call doesn't race
    // the kickstart and observe a half-up system UI.
    await execFileAsync("xcrun", ["simctl", "bootstatus", udid, "-b"], {
      timeout: SIMCTL_SPAWN_TIMEOUT_MS,
    }).catch(() => undefined);
  }
}

/**
 * Path of the simulator's host-side `com.apple.Accessibility` preference plist.
 * Lives inside the device's data container — writeable while the sim is
 * Shutdown, but overwritten by cfprefsd once the sim is Booted.
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
 * Set the four Accessibility prefs SpringBoard needs at boot directly on the
 * simulator's host-side preference plist BEFORE `simctl boot`. SpringBoard's
 * AX server reads these at first init and caches them for the lifetime of
 * the SB process — by setting them on disk pre-boot, SB starts with the
 * bypass already cached and no `launchctl kickstart -k system/com.apple.SpringBoard`
 * is ever needed. That kickstart kills any foreground app (e.g. a Maps launch
 * in flight) and dismisses any in-flight system alert (e.g. TCC prompts), so
 * eliminating it makes describe usable mid-launch without disrupting the agent.
 *
 * All four keys are required for the path to work on a freshly-erased sim:
 * - `IgnoreAXServerEntitlements` — bypasses the iOS 26.5+ kAXErrorNotEntitled
 *   check that rejects non-Apple-internal AX clients.
 * - `AutomationEnabled` — opt-in for the simctl-spawned ax-service binary
 *   to act as an accessibility client at all.
 * - `AccessibilityEnabled` + `ApplicationAccessibilityEnabled` — gate the
 *   AT subsystem bootstrap. Without them, SpringBoard never spawns
 *   `AccessibilityUIServer` (the LaunchAngel that owns the on-screen
 *   hierarchy), and describe queries return an empty ROOT even though the
 *   entitlement check passes. Hands-on confirmed on a wiped iPhone 17e
 *   sim: with only the first two prefs set, `AccessibilityUIServer`'s
 *   `active count` stayed at 0 and describe returned 0 elements; with all
 *   four set the daemon spawned automatically at boot and describe
 *   returned the full hierarchy.
 *
 * Caller must ensure the sim is currently Shutdown — cfprefsd inside a
 * booted sim caches preference values in memory and rewrites this file on
 * flush, which would silently undo this write.
 */
export async function setAccessibilityPrefsPreBoot(udid: string): Promise<void> {
  const plistPath = accessibilityPlistPath(udid);
  await fsAsync.mkdir(path.dirname(plistPath), { recursive: true });
  const exists = await fsAsync
    .access(plistPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    // `plutil -create binary1` produces an empty dict in the same binary format
    // SpringBoard reads at boot. -replace below adds each key regardless of
    // whether the file already had it.
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
