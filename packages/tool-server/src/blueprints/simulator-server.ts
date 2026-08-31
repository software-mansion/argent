import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  subprocessFailureMetadata,
  getFailureSignal,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { simulatorServerBinaryPath, simulatorServerRunDir } from "@argent/native-devtools-ios";
import { ensureAutomationEnabled } from "./ax-service";
import { ensureDep } from "../utils/check-deps";
import { isTvOsSimulator } from "../utils/ios-devices";
import { deviceSetForUdid } from "../utils/ios-device-sets";
import { UnsupportedOperationError } from "../utils/capability";
import { openMoqClient } from "../utils/moq-client";
import { createMoqTransport } from "../utils/simulator-client";
import { simctlPbcopy } from "../utils/sim-remote";
import { encodeKey } from "../utils/datachannel-proto";

export const SIMULATOR_SERVER_NAMESPACE = "SimulatorServer";

// `ServiceRef.options` is `Record<string, unknown>`; the intersection supplies
// the string index signature a plain interface wouldn't satisfy.
type SimulatorServerFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

/**
 * Tool `services()` callbacks should use this rather than hand-building the URN,
 * so the factory always receives the device through the registry's `options`
 * channel and never has to reclassify it.
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
  const RUN_DIR = simulatorServerRunDir();
  return { BINARY_PATH, RUN_DIR };
};

const READY_TIMEOUT_MS = 30_000;

export interface SimulatorServerApi {
  apiUrl: string;
  streamUrl: string;
  /** Send a key Down or Up event by USB HID keycode. */
  pressKey(direction: "Down" | "Up", keyCode: number): void;
  /**
   * Set for ios-remote so the shared `sendCommand` / `httpScreenshot` helpers in
   * `simulator-client.ts` route through MoQ instead of WebSocket + HTTP.
   * Undefined for local sims.
   */
  transport?: import("../utils/simulator-client").SimulatorServerTransport;
}

/**
 * The MoQ client reaches the remote simulator-server over WebTransport (endpoint
 * from `sim-remote moq-info`), and the attached transport routes
 * touch/screenshot/etc through MoQ instead of the local WS+HTTP path.
 */
async function buildRemoteInstance(
  device: DeviceInfo
): Promise<ServiceInstance<SimulatorServerApi>> {
  const moq = await openMoqClient(device.id);
  const events = new TypedEventEmitter<ServiceEvents>();

  const transport = createMoqTransport(moq, {
    pasteText: async (text: string) => {
      await simctlPbcopy(device.id, text);
      // USB HID usage ids: 0xE3 = Left GUI (Cmd), 0x19 = V. Cmd+V on the
      // remote sim is what actually fires the paste.
      const CMD = 0xe3;
      const V = 0x19;
      await moq.sendControl(encodeKey({ action: "Down", code: CMD }));
      await moq.sendControl(encodeKey({ action: "Down", code: V }));
      await moq.sendControl(encodeKey({ action: "Up", code: V }));
      await moq.sendControl(encodeKey({ action: "Up", code: CMD }));
    },
  });

  // No remote analogue of the local HTTP/WS endpoints exists — input, screenshot
  // and video all ride MoQ. A tagged stub makes the few readers log clearly
  // instead of silently dialing a nonexistent local port.
  const stubUrl = `moq+remote://${device.id}`;

  const api: SimulatorServerApi = {
    apiUrl: stubUrl,
    streamUrl: stubUrl,
    pressKey: (direction, keyCode) => {
      void moq.sendControl(encodeKey({ action: direction, code: keyCode }));
    },
    transport,
  };

  return {
    api,
    dispose: async () => {
      await moq.close();
    },
    events,
  };
}

// Matches iOS UDIDs and Android serials while rejecting a leading "-" (argv/flag
// injection into the simulator-server binary) and any shell/space/separator
// character — defence-in-depth at the spawn sink, independent of the per-tool
// zod schemas and the /preview device-list check.
const SAFE_SIMULATOR_DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * iOS simulators, Android emulators and physical Android phones each get their
 * own simulator-server controller; the phone one (`android_device`, screen-sharing
 * agent over adb) is picked by `kind`, not by platform alone.
 */
function subcommandForDevice(device: DeviceInfo): "ios" | "android" | "android_device" {
  if (device.platform === "ios") return "ios";
  return device.kind === "device" ? "android_device" : "android";
}

async function spawnSimulatorServerProcess(
  udid: string,
  subcommand: "ios" | "android" | "android_device"
): Promise<{
  proc: ChildProcess;
  apiUrl: string;
  streamUrl: string;
}> {
  if (!SAFE_SIMULATOR_DEVICE_ID.test(udid)) {
    throw new Error(`Refusing to start simulator-server for unsafe device id "${udid}".`);
  }
  // An iOS simulator in an additional CoreSimulator set is only reachable when
  // the binary is told which set to attach through; default-set devices keep the
  // bare argv.
  const deviceSet = subcommand === "ios" ? await deviceSetForUdid(udid) : null;
  const { BINARY_PATH, RUN_DIR } = getPaths();
  return new Promise((resolve, reject) => {
    const args = [subcommand, "--id", udid];
    if (deviceSet) args.push("--device-set", deviceSet);

    const proc = spawn(BINARY_PATH, args, {
      cwd: RUN_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let apiUrl: string | null = null;
    let streamUrl: string = "";
    let settled = false;
    // Grace window after api_ready for stream_ready. Streaming builds print
    // stream_ready first, so this only covers older/non-streaming builds.
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
        if (apiUrl != null) resolveWhenReady();
      } else if (line.startsWith("api_ready ")) {
        const match = line.match(/(http:\/\/[^ ]+)/);
        if (match) {
          apiUrl = match[1]!;
          if (streamUrl) {
            resolveWhenReady();
          } else {
            // Non-streaming builds never print stream_ready; resolve without one.
            apiReadyTimer = setTimeout(() => resolveWhenReady(), STREAM_GRACE_MS);
          }
        }
      }
    });

    const udidTag = typeof udid === "string" && udid.length > 0 ? udid.slice(0, 8) : "?";
    proc.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[sim ${udidTag}] ${data}`);
    });

    proc.on("exit", (code, signal) => {
      settle(() =>
        reject(
          new FailureError("simulator-server exited with code before becoming ready", {
            error_code: FAILURE_CODES.SIMULATOR_SERVER_READY_EXITED,
            failure_stage: "simulator_server_spawn_ready",
            failure_area: "tool_server",
            error_kind: "subprocess",
            failure_command: "simulator_server",
            ...(typeof code === "number" ? { failure_exit_code: code } : {}),
            ...(signal === "SIGABRT" ||
            signal === "SIGHUP" ||
            signal === "SIGINT" ||
            signal === "SIGKILL" ||
            signal === "SIGQUIT" ||
            signal === "SIGTERM"
              ? { failure_signal: signal }
              : {}),
          })
        )
      );
    });

    proc.on("error", (err) => {
      settle(() =>
        reject(
          new FailureError(
            err instanceof Error ? err.message : String(err),
            {
              error_code: FAILURE_CODES.SIMULATOR_SERVER_PROCESS_ERROR,
              failure_stage: "simulator_server_spawn_process",
              failure_area: "tool_server",
              error_kind: "subprocess",
              ...subprocessFailureMetadata(err, "simulator_server"),
            },
            { cause: err instanceof Error ? err : new Error(String(err)) }
          )
        )
      );
    });

    const timer = setTimeout(() => {
      settle(
        () =>
          reject(
            new FailureError("Timed out waiting for simulator-server to become ready", {
              error_code: FAILURE_CODES.SIMULATOR_SERVER_READY_TIMEOUT,
              failure_stage: "simulator_server_spawn_ready",
              failure_area: "tool_server",
              error_kind: "timeout",
              failure_command: "simulator_server",
              failure_signal: "SIGKILL",
            })
          ),
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
  /**
   * A wedged simulator-server (sim un-booted, native server crashed) can keep its
   * process alive while no longer listening, so it never emits `exit`, the
   * registry's teardown never fires, and every later call gets `ECONNREFUSED`
   * until a human runs `stop-simulator-server`. Calling that recoverable makes
   * the registry dispose the instance and re-spawn. Scoped to connection-refused
   * only: the request provably never reached the server, so a retry can't
   * double-apply a gesture, whereas a timeout or reset may have taken effect.
   */
  recoverable(error: unknown): boolean {
    return getFailureSignal(error)?.network_failure === "connection_refused";
  },
  async factory(_deps, _payload, options) {
    const opts = options as unknown as SimulatorServerFactoryOptions | undefined;
    if (!opts?.device) {
      throw new FailureError(
        `${SIMULATOR_SERVER_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use simulatorServerRef(device) when registering the service ref, or pass { device } when calling resolveService directly.`,
        {
          error_code: FAILURE_CODES.SIMULATOR_SERVER_FACTORY_OPTIONS_MISSING,
          failure_stage: "simulator_server_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const { device } = opts;
    if (typeof device.id !== "string" || device.id.length === 0) {
      throw new FailureError(
        `${SIMULATOR_SERVER_NAMESPACE}.factory requires a non-empty device.id; got ${JSON.stringify(device.id)}.`,
        {
          error_code: FAILURE_CODES.SIMULATOR_SERVER_DEVICE_ID_INVALID,
          failure_stage: "simulator_server_factory_device_id",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    if (device.platform === "ios-remote") {
      return buildRemoteInstance(device);
    }

    if (device.platform === "ios") {
      // A tvOS sim classifies as platform "ios" by UDID shape, but simulator-server
      // cannot drive the Apple TV focus engine, and `sendCommand` is
      // fire-and-forget, so a tvOS touch/key would silently no-op while the tool
      // reported success. Reject at this one chokepoint every gesture / keyboard /
      // paste / rotate tool resolves through; screenshot branches to `xcrun`
      // before it ever resolves this service.
      if (await isTvOsSimulator(device.id)) {
        throw new UnsupportedOperationError(
          SIMULATOR_SERVER_NAMESPACE,
          device,
          "this is an Apple TV (tvOS) simulator — touch, paste and rotate " +
            "input are not available. Use `describe` to read focus, `tv-remote` for remote " +
            "presses, and `keyboard` to type (see the argent-tv-interact skill)"
        );
      }
      await ensureAutomationEnabled(device.id).catch(() => {});
    } else if (device.platform === "android") {
      // Both the emulator and the physical-device controller talk to the target
      // through adb (gRPC bridge / screen-sharing agent respectively).
      await ensureDep("adb");
    } else {
      // The simulator-server binary only knows iOS and Android; other platforms
      // have their own blueprints (e.g. chromium-cdp), so reaching this factory
      // with one means a tool's services() wired the wrong ref.
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
      events.emit(
        "terminated",
        new FailureError(`Process exited with code ${code}`, {
          error_code: FAILURE_CODES.SIMULATOR_SERVER_TERMINATED,
          failure_stage: "simulator_server_process_exit",
          failure_area: "tool_server",
          error_kind: "subprocess",
        })
      );
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
