import * as net from "node:net";
import * as fs from "node:fs";
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
  await execFileAsync("xcrun", [
    "simctl",
    "spawn",
    udid,
    "defaults",
    "write",
    "com.apple.Accessibility",
    "AutomationEnabled",
    "-bool",
    "true",
  ]);
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
