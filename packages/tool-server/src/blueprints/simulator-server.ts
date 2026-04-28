import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import {
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { simulatorServerBinaryPath, simulatorServerBinaryDir } from "@argent/native-devtools-ios";
import { ensureAutomationEnabled } from "./ax-service";

export const SIMULATOR_SERVER_NAMESPACE = "SimulatorServer";

const getPaths = () => {
  const BINARY_PATH = simulatorServerBinaryPath();
  const BINARY_DIR = simulatorServerBinaryDir();
  return { BINARY_PATH, BINARY_DIR };
};

const READY_TIMEOUT_MS = 30_000;

export interface SimulatorServerApi {
  apiUrl: string;
  streamUrl: string;
  /** Send a key Down or Up event by USB HID keycode (stdin `key <direction> <keyCode>` command). */
  pressKey(direction: "Down" | "Up", keyCode: number): void;
}

function spawnSimulatorServerProcess(udid: string): Promise<{
  proc: ChildProcess;
  apiUrl: string;
  streamUrl: string;
}> {
  const { BINARY_PATH, BINARY_DIR } = getPaths();
  return new Promise((resolve, reject) => {
    const args = ["ios", "--id", udid];

    const proc = spawn(BINARY_PATH, args, {
      cwd: BINARY_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let apiUrl: string | null = null;
    let streamUrl: string = "";
    let settled = false;
    // Grace window after api_ready to let stream_ready arrive. Server prints
    // stream_ready BEFORE api_ready when streaming is enabled, so this is only
    // a safety net for races on older/non-streaming builds.
    const STREAM_GRACE_MS = 500;
    let apiReadyTimer: NodeJS.Timeout | null = null;

    const rl = readline.createInterface({ input: proc.stdout! });

    const settle = (fn: () => void, cleanup?: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (apiReadyTimer) clearTimeout(apiReadyTimer);
      rl.close();
      cleanup?.();
      fn();
    };

    const resolveWhenReady = () => {
      if (apiUrl == null) return;
      settle(() => resolve({ proc, apiUrl: apiUrl!, streamUrl }));
    };

    rl.on("line", (rawLine: string) => {
      const line = rawLine.trim();
      if (line.startsWith("stream_ready ")) {
        const match = line.match(/(http:\/\/[^ ]+)/);
        if (match) streamUrl = match[1]!;
        // If api_ready already fired and we were waiting on streaming, resolve now.
        if (apiUrl != null) resolveWhenReady();
      } else if (line.startsWith("api_ready ")) {
        const match = line.match(/(http:\/\/[^ ]+)/);
        if (match) {
          apiUrl = match[1]!;
          if (streamUrl) {
            resolveWhenReady();
          } else {
            // Give stream_ready a short grace window; if it never comes (non-streaming
            // build), fall through and resolve without a stream URL.
            apiReadyTimer = setTimeout(() => resolveWhenReady(), STREAM_GRACE_MS);
          }
        }
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[sim ${udid.slice(0, 8)}] ${data}`);
    });

    proc.on("exit", () => {
      settle(() => reject(new Error(`simulator-server exited with code before becoming ready`)));
    });

    proc.on("error", (err) => {
      settle(() => reject(err));
    });

    const timer = setTimeout(() => {
      settle(
        () => reject(new Error("Timed out waiting for simulator-server to become ready")),
        () => proc.kill()
      );
    }, READY_TIMEOUT_MS);
  });
}

export const simulatorServerBlueprint: ServiceBlueprint<SimulatorServerApi, string> = {
  namespace: SIMULATOR_SERVER_NAMESPACE,
  getURN(udid: string) {
    return `${SIMULATOR_SERVER_NAMESPACE}:${udid}`;
  },
  async factory(_deps, payload) {
    const udid = payload;
    // Enable accessibility automation before any app is launched so that apps
    // start with their AX server running. If this is called after apps are already
    // running (e.g. a pre-booted simulator), those apps won't pick up the flag
    // until restarted — but new launches will work correctly.
    await ensureAutomationEnabled(udid).catch(() => {});
    const { proc, apiUrl, streamUrl } = await spawnSimulatorServerProcess(udid);

    const events = new TypedEventEmitter<ServiceEvents>();

    proc.on("exit", (code) => {
      events.emit("terminated", new Error(`Process exited with code ${code}`));
    });
    proc.on("error", (err) => {
      events.emit("terminated", err);
    });

    const instance: ServiceInstance<SimulatorServerApi> = {
      api: {
        apiUrl,
        streamUrl,
        pressKey: (direction: "Down" | "Up", keyCode: number) => {
          proc.stdin?.write(`key ${direction} ${keyCode}\n`);
        },
      },
      dispose: async () => {
        proc.kill();
      },
      events,
    };

    return instance;
  },
};
