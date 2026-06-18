import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { simulatorServerBinaryPath, simulatorServerBinaryDir } from "@argent/native-devtools-ios";
import { ensureAutomationEnabled } from "./ax-service";
import { ensureDep } from "../utils/check-deps";

export const SIMULATOR_SERVER_NAMESPACE = "SimulatorServer";

// The registry's `ServiceRef.options` is typed as `Record<string, unknown>`,
// so the factory options must be assignable to it (intersection adds the
// implicit string index signature that an `interface { device: DeviceInfo }`
// alone wouldn't satisfy).
type SimulatorServerFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

/**
 * Build the `ServiceRef` for the simulator-server keyed by an already-resolved
 * `DeviceInfo`. Tool `services()` callbacks should call this rather than
 * hand-building the URN string, so the blueprint factory always receives the
 * device through the registry's `options` channel and never has to reclassify.
 */
export function simulatorServerRef(device: DeviceInfo): {
  urn: string;
  options: SimulatorServerFactoryOptions;
} {
  return {
    urn: `${SIMULATOR_SERVER_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

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

// iOS UDIDs and Android serials (e.g. "emulator-5554", "192.168.1.5:5555",
// alphanumeric hashes) all match this. It rejects a leading "-" (argv/flag
// injection into the simulator-server binary) and any shell/space/separator
// character — defence-in-depth at the spawn sink, independent of the
// per-tool zod schemas and the /preview device-list check.
const SAFE_SIMULATOR_DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * The simulator-server subcommand that drives a given device. iOS simulators and
 * Android emulators each have their own controller; a physical Android phone is
 * a third controller (`android_device`) that runs the screen-sharing agent over
 * adb and decodes its H264 stream, so it is selected by `kind === "device"`
 * rather than by platform alone.
 */
function subcommandForDevice(device: DeviceInfo): "ios" | "android" | "android_device" {
  if (device.platform === "ios") return "ios";
  return device.kind === "device" ? "android_device" : "android";
}

function spawnSimulatorServerProcess(
  udid: string,
  subcommand: "ios" | "android" | "android_device"
): Promise<{
  proc: ChildProcess;
  apiUrl: string;
  streamUrl: string;
}> {
  if (!SAFE_SIMULATOR_DEVICE_ID.test(udid)) {
    return Promise.reject(
      new Error(`Refusing to start simulator-server for unsafe device id "${udid}".`)
    );
  }
  const { BINARY_PATH, BINARY_DIR } = getPaths();
  return new Promise((resolve, reject) => {
    const args = [subcommand, "--id", udid];

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

    // Defense-in-depth: a missing udid here would crash the process —
    // throwing inside an async listener bypasses promise rejection and
    // bubbles up as `uncaughtException`, which the tool-server treats as
    // fatal. Tag with "?" instead of dereferencing.
    const udidTag = typeof udid === "string" && udid.length > 0 ? udid.slice(0, 8) : "?";
    proc.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[sim ${udidTag}] ${data}`);
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

export const simulatorServerBlueprint: ServiceBlueprint<SimulatorServerApi, DeviceInfo> = {
  namespace: SIMULATOR_SERVER_NAMESPACE,
  getURN(device: DeviceInfo) {
    return `${SIMULATOR_SERVER_NAMESPACE}:${device.id}`;
  },
  async factory(_deps, _payload, options) {
    const opts = options as unknown as SimulatorServerFactoryOptions | undefined;
    if (!opts?.device) {
      throw new Error(
        `${SIMULATOR_SERVER_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use simulatorServerRef(device) when registering the service ref, or pass { device } when calling resolveService directly.`
      );
    }

    const { device } = opts;
    if (typeof device.id !== "string" || device.id.length === 0) {
      throw new Error(
        `${SIMULATOR_SERVER_NAMESPACE}.factory requires a non-empty device.id; got ${JSON.stringify(device.id)}.`
      );
    }

    if (device.platform === "ios" && device.kind === "device") {
      // Physical iPhones are driven over CoreDevice (see core-device blueprint),
      // not the simulator-server. Only screenshot/gesture-tap/gesture-swipe/button
      // route physical iOS to that backend; any other tool lands here, so fail
      // with a clear message instead of spawning a simulator-server that can't
      // attach to a hardware UDID.
      throw new Error(
        `simulator-server cannot drive the physical iOS device ${device.id}. ` +
          `Physical iPhones support screenshot, gesture-tap, gesture-swipe, and button only.`
      );
    }

    if (device.platform === "ios") {
      await ensureAutomationEnabled(device.id).catch(() => {});
    } else if (device.platform === "android") {
      // Both the emulator and the physical-device controller talk to the target
      // through adb (gRPC bridge / screen-sharing agent respectively).
      await ensureDep("adb");
    } else {
      // The simulator-server binary only knows iOS and Android. Other platforms
      // (Chromium) have their own blueprints (chromium-cdp); reaching this
      // factory with one means a tool's services() wired the wrong ref.
      throw new Error(
        `${SIMULATOR_SERVER_NAMESPACE}.factory does not support platform "${device.platform}". Use the platform-specific service blueprint instead.`
      );
    }

    const { proc, apiUrl, streamUrl } = await spawnSimulatorServerProcess(
      device.id,
      subcommandForDevice(device)
    );

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
