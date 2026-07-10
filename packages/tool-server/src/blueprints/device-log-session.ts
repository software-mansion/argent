import { createWriteStream, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
  type ServiceInstance,
  type ServiceRef,
} from "@argent/registry";
import { getDebugDir } from "../utils/react-profiler/debug/dump";

export const DEVICE_LOG_SESSION_NAMESPACE = "DeviceLogSession";

type DeviceLogSessionFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

export interface DeviceLogStartOptions {
  process?: string;
}

export interface DeviceLogSessionApi {
  device: DeviceInfo;
  active: boolean;
  outputFile: string | null;
  startedAtMs: number | null;
  start(options: DeviceLogStartOptions): Promise<{ outputFile: string; startedAtMs: number }>;
  stop(): Promise<{ outputFile: string; lineCount: number; durationMs: number }>;
}

export function deviceLogSessionRef(device: DeviceInfo): ServiceRef {
  return { urn: `${DEVICE_LOG_SESSION_NAMESPACE}:${device.id}`, options: { device } };
}

function sessionFailure(
  message: string,
  code: (typeof FAILURE_CODES)[keyof typeof FAILURE_CODES],
  stage: string,
  cause?: unknown
): FailureError {
  return new FailureError(
    message,
    {
      error_code: code,
      failure_stage: stage,
      failure_area: "tool_server",
      error_kind: "subprocess",
    },
    cause == null ? undefined : { cause: cause instanceof Error ? cause : new Error(String(cause)) }
  );
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGINT");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
}

async function closeStream(stream: WriteStream | null): Promise<void> {
  if (!stream || stream.closed) return;
  await new Promise<void>((resolve) => stream.end(resolve));
}

function pymobiledevice3Path(): string {
  if (process.env.ARGENT_PYMOBILEDEVICE3) return process.env.ARGENT_PYMOBILEDEVICE3;
  for (const candidate of [
    join(homedir(), ".local", "bin", "pymobiledevice3"),
    "/opt/homebrew/bin/pymobiledevice3",
    "/usr/local/bin/pymobiledevice3",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "pymobiledevice3";
}

export const deviceLogSessionBlueprint: ServiceBlueprint<DeviceLogSessionApi, DeviceInfo> = {
  namespace: DEVICE_LOG_SESSION_NAMESPACE,
  getURN(device) {
    return `${DEVICE_LOG_SESSION_NAMESPACE}:${device.id}`;
  },
  async factory(_deps, _payload, options) {
    const opts = options as DeviceLogSessionFactoryOptions | undefined;
    if (!opts?.device) {
      throw sessionFailure(
        `${DEVICE_LOG_SESSION_NAMESPACE}.factory requires options.device.`,
        FAILURE_CODES.DEVICE_LOG_SESSION_FACTORY_OPTIONS_MISSING,
        "device_log_session_factory"
      );
    }
    const device = opts.device;
    let child: ChildProcess | null = null;
    let stream: WriteStream | null = null;
    let processFilter: string | undefined;
    let lineCount = 0;

    const api: DeviceLogSessionApi = {
      device,
      active: false,
      outputFile: null,
      startedAtMs: null,
      async start(startOptions) {
        if (api.active) {
          throw sessionFailure(
            `Device log capture is already active for ${device.id}.`,
            FAILURE_CODES.DEVICE_LOG_SESSION_ALREADY_ACTIVE,
            "device_log_start_state"
          );
        }
        const debugDir = await getDebugDir();
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        api.outputFile = join(debugDir, `device-logs-${device.id}-${stamp}.log`);
        api.startedAtMs = Date.now();
        processFilter = startOptions.process;
        lineCount = 0;

        try {
          stream = createWriteStream(api.outputFile, { flags: "w" });
          if (device.kind === "device") {
            const args = ["syslog", "live", "--udid", device.id];
            if (processFilter) args.push("--process-name", processFilter);
            child = spawn(pymobiledevice3Path(), args, { stdio: ["ignore", "pipe", "pipe"] });
          } else {
            const args = ["simctl", "spawn", device.id, "log", "stream", "--style", "compact"];
            if (processFilter) args.push("--predicate", `process == ${JSON.stringify(processFilter)}`);
            child = spawn("xcrun", args, { stdio: ["ignore", "pipe", "pipe"] });
          }
          const count = (chunk: Buffer) => {
            lineCount += chunk.toString("utf8").split("\n").length - 1;
            stream?.write(chunk);
          };
          child.stdout?.on("data", count);
          child.stderr?.on("data", count);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 350);
            child!.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child!.once("exit", (code) => {
              if (code != null && code !== 0) {
                clearTimeout(timer);
                reject(new Error(`log stream exited with code ${code}`));
              }
            });
          });
        } catch (error) {
          await stopChild(child);
          await closeStream(stream);
          child = null;
          stream = null;
          throw sessionFailure(
            `Could not start device log capture for ${device.id}.`,
            FAILURE_CODES.DEVICE_LOG_SESSION_START_FAILED,
            "device_log_start",
            error
          );
        }

        api.active = true;
        return { outputFile: api.outputFile, startedAtMs: api.startedAtMs };
      },
      async stop() {
        if (!api.active || !api.outputFile || api.startedAtMs == null) {
          throw sessionFailure(
            `No active device log capture exists for ${device.id}.`,
            FAILURE_CODES.DEVICE_LOG_SESSION_NOT_ACTIVE,
            "device_log_stop_state"
          );
        }
        const outputFile = api.outputFile;
        const startedAtMs = api.startedAtMs;
        await stopChild(child);
        await closeStream(stream);
        // Include a final count from disk if the stream delivered a partial
        // last line without a trailing newline.
        const text = await readFile(outputFile, "utf8").catch(() => "");
        lineCount = text.length === 0 ? 0 : text.split("\n").filter(Boolean).length;
        child = null;
        stream = null;
        api.active = false;
        return { outputFile, lineCount, durationMs: Date.now() - startedAtMs };
      },
    };

    const events = new TypedEventEmitter<ServiceEvents>();
    const instance: ServiceInstance<DeviceLogSessionApi> = {
      api,
      events,
      async dispose() {
        await stopChild(child);
        await closeStream(stream);
        api.active = false;
      },
    };
    return instance;
  },
};
