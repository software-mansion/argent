import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@radon-lite/registry";

export const SIMULATOR_SERVER_NAMESPACE = "SimulatorServer";

// Binary lives at workspace root (four levels up from dist/blueprints at runtime)
const getPaths = () => {
  const BINARY_DIR = path.join(__dirname, "..", "..", "..", "..");
  const BINARY_PATH = path.join(BINARY_DIR, "simulator-server");
  return { BINARY_PATH, BINARY_DIR };
};

const READY_TIMEOUT_MS = 30_000;

export interface SimulatorServerApi {
  apiUrl: string;
  streamUrl: string;
}

function spawnSimulatorServerProcess(
  udid: string,
  token: string | undefined
): Promise<{
  proc: ChildProcess;
  apiUrl: string;
  streamUrl: string;
}> {
  const { BINARY_PATH, BINARY_DIR } = getPaths();
  return new Promise((resolve, reject) => {
    const args = ["ios", "--id", udid];
    if (token) args.push("-t", token);

    const proc = spawn(BINARY_PATH, args, {
      cwd: BINARY_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let streamUrl: string | null = null;
    let apiUrl: string | null = null;
    let settled = false;

    const rl = readline.createInterface({ input: proc.stdout! });

    const settle = (fn: () => void, cleanup?: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      cleanup?.();
      fn();
    };

    const tryResolve = () => {
      if (streamUrl && apiUrl) {
        settle(() => {
          resolve({ proc, apiUrl: apiUrl!, streamUrl: streamUrl! });
        });
      }
    };

    rl.on("line", (rawLine: string) => {
      const line = rawLine.trim();
      if (line.startsWith("stream_ready ")) {
        const match = line.match(/(http:\/\/[^ ]+)/);
        if (match) {
          streamUrl = match[1]!;
          if (!apiUrl) {
            const u = new URL(streamUrl);
            apiUrl = `${u.protocol}//${u.host}`;
          }
          tryResolve();
        }
        return;
      }
      if (line.startsWith("api_ready ")) {
        const match = line.match(/(http:\/\/[^ ]+)/);
        if (match) {
          apiUrl = match[1]!;
          tryResolve();
        }
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[sim ${udid.slice(0, 8)}] ${data}`);
    });

    proc.on("exit", () => {
      settle(() =>
        reject(new Error(`simulator-server exited with code before becoming ready`))
      );
    });

    proc.on("error", (err) => {
      settle(() => reject(err));
    });

    const timer = setTimeout(() => {
      settle(
        () =>
          reject(new Error("Timed out waiting for simulator-server to become ready")),
        () => proc.kill()
      );
    }, READY_TIMEOUT_MS);
  });
}

export const simulatorServerBlueprint: ServiceBlueprint<
  SimulatorServerApi,
  string
> = {
  namespace: SIMULATOR_SERVER_NAMESPACE,
  getURN(udid: string) {
    return `${SIMULATOR_SERVER_NAMESPACE}:${udid}`;
  },
  async factory(_deps, payload, options?) {
    const udid = payload;
    const token = options?.token as string | undefined;
    const { proc, apiUrl, streamUrl } = await spawnSimulatorServerProcess(
      udid,
      token
    );

    const events = new TypedEventEmitter<ServiceEvents>();

    proc.on("exit", (code) => {
      events.emit("terminated", new Error(`Process exited with code ${code}`));
    });
    proc.on("error", (err) => {
      events.emit("terminated", err);
    });

    const instance: ServiceInstance<SimulatorServerApi> = {
      api: { apiUrl, streamUrl },
      dispose: async () => {
        proc.kill();
      },
      events,
    };

    return instance;
  },
};
