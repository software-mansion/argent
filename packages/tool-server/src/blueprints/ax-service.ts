import * as net from "node:net";
import * as fs from "node:fs";
import { promisify } from "node:util";
import { execFile, ChildProcess } from "node:child_process";
import {
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { axServiceBinaryPath } from "@argent/native-devtools-ios";

const execFileAsync = promisify(execFile);

export const AX_SERVICE_NAMESPACE = "AXService";

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

async function ensureAutomationEnabled(udid: string): Promise<void> {
  await execFileAsync("xcrun", [
    "simctl", "spawn", udid,
    "defaults", "write", "com.apple.Accessibility",
    "AutomationEnabled", "-bool", "true",
  ]);
}

async function killExistingDaemon(socketPath: string): Promise<void> {
  try {
    const raw = await querySocket(socketPath, "ping", 2000);
    const parsed = JSON.parse(raw);
    if (parsed.pid) process.kill(parsed.pid, "SIGTERM");
  } catch {}
  try { fs.unlinkSync(socketPath); } catch {}
}

function spawnDaemon(
  udid: string,
  socketPath: string
): Promise<ChildProcess> {
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
      [
        "simctl",
        "spawn",
        udid,
        binaryPath,
        "--socket",
        socketPath,
        "--timeout",
        "3600",
      ],
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

    proc.stderr?.on("data", (data: string) => {
      process.stderr.write(`[ax-service ${udid.slice(0, 8)}] ${data}`);
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

export const axServiceBlueprint: ServiceBlueprint<AXServiceApi, string> = {
  namespace: AX_SERVICE_NAMESPACE,

  getURN(udid: string) {
    return `${AX_SERVICE_NAMESPACE}:${udid}`;
  },

  async factory(_deps, udid) {
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
        events.emit(
          "terminated",
          err instanceof Error ? err : new Error(String(err))
        );
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
