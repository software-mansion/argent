import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import {
  TypedEventEmitter,
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
  type FailureSignal,
} from "@argent/registry";
import { helperManifest } from "@argent/native-devtools-android";
import { runAdb } from "../utils/adb";
import { resolveAndroidBinary } from "../utils/android-binary";
import { ensureAndroidDevtoolsInstalled } from "../utils/android-helper-install";
import {
  connectAndroidDevtoolsClient,
  type AndroidDevtoolsClient,
} from "../utils/android-devtools-client";

export const ANDROID_DEVTOOLS_NAMESPACE = "AndroidDevtools";

type AndroidDevtoolsFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

export function androidDevtoolsRef(device: DeviceInfo): {
  urn: string;
  options: AndroidDevtoolsFactoryOptions;
} {
  return {
    urn: `${ANDROID_DEVTOOLS_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

export interface GetHierarchyOptions {
  waitForIdleMs?: number;
  maxDepth?: number;
  maxNodes?: number;
  /**
   * Drop the helper's accessibility-node cache before capturing — cached reads
   * can serve stale text. Defaults to the cheaper cached read.
   */
  clearCache?: boolean;
}

export interface HierarchyResult {
  xml: string;
  captureMode: string;
  windowCount: number;
  nodeCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface AndroidDevtoolsApi {
  isReady(): boolean;
  getHierarchy(options?: GetHierarchyOptions): Promise<HierarchyResult>;
  getScreenSize(): Promise<{ width: number; height: number; rotation: number }>;
  ping(): Promise<{ ok: boolean; idleMs: number; protocol: string }>;
}

const READY_TIMEOUT_MS = 30_000;
/** How long `close` gets to follow `exit` before the exit alone is the verdict. */
const EXIT_GRACE_MS = 200;
const HELPER_PORT_MARKER = /^INSTRUMENTATION_STATUS:\s*port=(\d+)/;
const ADB_FORWARD_PORT_MARKER = /^(\d+)\s*$/;

/**
 * `am instrument` reports why it refused on STDOUT — the `Error=` line of its
 * status block — and writes nothing to stderr but a stack, so a report built
 * from the stderr tail alone says `code=1` and nothing else. The status code
 * beside it is always -1 and names nothing.
 */
const HELPER_STATUS_MARKER = /^INSTRUMENTATION_STATUS:\s*Error=/;
const HELPER_STATUS_MAX_CHARS = 400;

type HelperSpawnFault = "instrumentation-missing" | "unknown";

/**
 * Whether the device says the helper package is not installed. Every `am
 * instrument` failure exits 1, so the status text is the only thing separating
 * "reinstall the helper" from a fault reinstalling cannot fix.
 */
export function classifyHelperSpawnFault(text: string): HelperSpawnFault {
  return /Unable to find instrumentation (?:info|target package)/i.test(text)
    ? "instrumentation-missing"
    : "unknown";
}

/** Carries the fault from {@link spawnHelper} to the repair path. */
class HelperSpawnError extends FailureError {
  readonly fault: HelperSpawnFault;

  constructor(message: string, signal: FailureSignal, fault: HelperSpawnFault) {
    super(message, signal);
    this.name = "HelperSpawnError";
    this.fault = fault;
  }
}

interface SpawnedHelper {
  proc: ChildProcess;
  devicePort: number;
  localPort: number;
}

async function spawnHelper(serial: string): Promise<SpawnedHelper> {
  const manifest = helperManifest();
  const adbPath = await resolveAndroidBinary("adb");
  if (!adbPath) {
    throw new FailureError(
      "`adb` not found on PATH or under `$ANDROID_HOME/platform-tools` while spawning the argent android helper.",
      {
        error_code: FAILURE_CODES.ANDROID_DEVTOOLS_ADB_NOT_FOUND,
        failure_stage: "android_devtools_spawn_helper",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
      }
    );
  }

  const proc = spawn(
    adbPath,
    ["-s", serial, "shell", "am", "instrument", "-w", manifest.instrumentationRunner],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  return new Promise<SpawnedHelper>((resolve, reject) => {
    let devicePort: number | null = null;
    let localPort: number | null = null;
    let settled = false;
    let stderrBuf = "";
    let statusBuf = "";
    let exitGrace: NodeJS.Timeout | undefined;

    const settle = (fn: () => void, cleanup?: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitGrace);
      // Closing the reader flushes what it has already read, so a verdict built
      // from `statusBuf` sees every line the pipe delivered.
      rl.close();
      cleanup?.();
      fn();
    };

    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on("line", async (rawLine: string) => {
      const line = rawLine.trim();
      // Keep the first lines, not the last: the reason leads the status block
      // and the exception stack that follows would push it out of the cap.
      if (statusBuf.length < HELPER_STATUS_MAX_CHARS && HELPER_STATUS_MARKER.test(line)) {
        statusBuf = (statusBuf ? `${statusBuf} ${line}` : line).slice(0, HELPER_STATUS_MAX_CHARS);
      }
      const portMatch = HELPER_PORT_MARKER.exec(line);
      if (!portMatch || devicePort !== null) return;
      devicePort = parseInt(portMatch[1]!, 10);

      // `tcp:0` makes adb pick a free local port and print it on stdout.
      try {
        const { stdout } = await runAdb(["-s", serial, "forward", "tcp:0", `tcp:${devicePort}`], {
          timeoutMs: 5_000,
        });
        const lpMatch = ADB_FORWARD_PORT_MARKER.exec(stdout.trim());
        if (!lpMatch) {
          throw new FailureError(`adb forward returned unexpected output: ${stdout.trim()}`, {
            error_code: FAILURE_CODES.ANDROID_DEVTOOLS_ADB_FORWARD_UNEXPECTED,
            failure_stage: "android_devtools_adb_forward",
            failure_area: "tool_server",
            error_kind: "subprocess",
          });
        }
        localPort = parseInt(lpMatch[1]!, 10);
        settle(() => resolve({ proc, devicePort: devicePort!, localPort: localPort! }));
      } catch (err) {
        settle(
          () => reject(err instanceof Error ? err : new Error(String(err))),
          () => proc.kill()
        );
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderrBuf += data.toString("utf-8");
      if (stderrBuf.length > 4 * 1024) stderrBuf = stderrBuf.slice(-4 * 1024);
    });

    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const rejectExited = () => {
      // The device's own reason where there is one; the exit status only where
      // there is not, since `code=1` is what every refusal exits with.
      const detail = statusBuf
        ? statusBuf
        : stderrBuf.trim()
          ? `code=${exitCode} signal=${exitSignal}. stderr=${stderrBuf.trim().slice(0, 200)}`
          : `code=${exitCode} signal=${exitSignal}`;
      reject(
        new HelperSpawnError(
          `am instrument exited before becoming ready: ${detail}`,
          {
            error_code: FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_EXITED_BEFORE_READY,
            failure_stage: "android_devtools_helper_ready",
            failure_area: "tool_server",
            error_kind: "subprocess",
            failure_command: "android_devtools",
            ...(typeof exitCode === "number" ? { failure_exit_code: exitCode } : {}),
            ...(exitSignal === "SIGABRT" ||
            exitSignal === "SIGHUP" ||
            exitSignal === "SIGINT" ||
            exitSignal === "SIGKILL" ||
            exitSignal === "SIGQUIT" ||
            exitSignal === "SIGTERM"
              ? { failure_signal: exitSignal }
              : {}),
          },
          classifyHelperSpawnFault(statusBuf)
        )
      );
    };

    proc.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // `close` is the verdict to wait for — it means the pipes drained, so the
      // status block naming the reason has reached the reader, which `exit`
      // alone does not promise. But the adb server adb forks on first use can
      // inherit stdout and hold it open after the child is gone, and then
      // `close` never arrives: without this grace that run would wait out the
      // ready timeout and reject as a timeout, which the repair path cannot
      // classify and would never repair.
      exitGrace = setTimeout(() => settle(rejectExited), EXIT_GRACE_MS);
    });

    proc.on("close", () => settle(rejectExited));

    proc.on("error", (err) => {
      settle(() =>
        reject(
          new FailureError(
            "android-devtools helper process error.",
            {
              error_code: FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_PROCESS_ERROR,
              failure_stage: "android_devtools_helper_process",
              failure_area: "tool_server",
              error_kind: "subprocess",
              ...subprocessFailureMetadata(err, "android_devtools"),
            },
            { cause: err }
          )
        )
      );
    });

    const timer = setTimeout(() => {
      settle(
        () =>
          reject(
            new FailureError("Timed out waiting for android-devtools helper to become ready", {
              error_code: FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_READY_TIMEOUT,
              failure_stage: "android_devtools_helper_ready",
              failure_area: "tool_server",
              error_kind: "timeout",
              failure_command: "android_devtools",
              failure_signal: "SIGTERM",
            })
          ),
        () => proc.kill()
      );
    }, READY_TIMEOUT_MS);
  });
}

async function installHelper(serial: string, options: { force?: boolean }): Promise<void> {
  try {
    await ensureAndroidDevtoolsInstalled(serial, options);
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err));
    // runAdb prefixes the whole argv — including the bundled APK's absolute
    // path — so capping the raw message cuts the `Failure [INSTALL_FAILED_…]`
    // code off the end. Drop the prefix first; the cap is for a device that
    // answers with more than adb's usual one line.
    const reason = cause.message
      .replace(/^.*? failed: /s, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    throw new FailureError(
      `the argent android helper is not installed on ${serial} and could not be installed: ${reason}`,
      {
        error_code: FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_INSTALL_FAILED,
        failure_stage: "android_devtools_helper_install",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "adb",
      },
      { cause }
    );
  }
}

/**
 * Install the helper, start it, and — when the device answers that the
 * instrumentation is not there — reinstall it once and start it again.
 *
 * The install probe cannot see that case coming: it accepts any build at the
 * manifest's versionCode, which is pinned at 1, so a wiped or snapshot-restored
 * emulator and a foreign same-version APK both read as installed. `am
 * instrument` is what finds out, and by then only a forced reinstall helps.
 *
 * Only that fault is repaired. A missing `adb`, a ready timeout or an
 * unexpected `adb forward` reply are all reported as they were.
 */
async function spawnHelperWithRepair(serial: string): Promise<SpawnedHelper> {
  await installHelper(serial, {});
  try {
    return await spawnHelper(serial);
  } catch (err) {
    if (!(err instanceof HelperSpawnError) || err.fault !== "instrumentation-missing") throw err;

    await installHelper(serial, { force: true });
    try {
      return await spawnHelper(serial);
    } catch (repairErr) {
      if (!(repairErr instanceof HelperSpawnError)) throw repairErr;
      throw new FailureError(
        `the argent android helper could not start on ${serial} even after reinstalling it: ${repairErr.message}`,
        {
          error_code: FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_REPAIR_FAILED,
          failure_stage: "android_devtools_helper_repair",
          failure_area: "tool_server",
          error_kind: "subprocess",
          failure_command: "android_devtools",
        },
        { cause: repairErr }
      );
    }
  }
}

async function removeAdbForward(serial: string, localPort: number): Promise<void> {
  try {
    await runAdb(["-s", serial, "forward", "--remove", `tcp:${localPort}`], { timeoutMs: 5_000 });
  } catch {
    /* best-effort */
  }
}

export const androidDevtoolsBlueprint: ServiceBlueprint<AndroidDevtoolsApi, DeviceInfo> = {
  namespace: ANDROID_DEVTOOLS_NAMESPACE,

  getURN(device: DeviceInfo) {
    return `${ANDROID_DEVTOOLS_NAMESPACE}:${device.id}`;
  },

  async factory(_deps, _payload, options) {
    const opts = options as unknown as AndroidDevtoolsFactoryOptions | undefined;
    if (!opts?.device) {
      throw new FailureError(
        `${ANDROID_DEVTOOLS_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use androidDevtoolsRef(device) when registering the service ref, or pass { device } when calling resolveService directly.`,
        {
          error_code: FAILURE_CODES.ANDROID_DEVTOOLS_FACTORY_OPTIONS_MISSING,
          failure_stage: "android_devtools_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const { device } = opts;
    if (device.platform !== "android") {
      throw new FailureError(
        `${ANDROID_DEVTOOLS_NAMESPACE} is Android-only. The target '${device.id}' classifies as iOS — use the iOS describe path instead.`,
        {
          error_code: FAILURE_CODES.ANDROID_DEVTOOLS_WRONG_PLATFORM,
          failure_stage: "android_devtools_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    if (typeof device.id !== "string" || device.id.length === 0) {
      throw new FailureError(
        `${ANDROID_DEVTOOLS_NAMESPACE}.factory requires a non-empty device.id; got ${JSON.stringify(device.id)}.`,
        {
          error_code: FAILURE_CODES.ANDROID_DEVTOOLS_DEVICE_ID_INVALID,
          failure_stage: "android_devtools_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const serial = device.id;
    const events = new TypedEventEmitter<ServiceEvents>();

    const spawned = await spawnHelperWithRepair(serial);
    let ready = false;
    let disposed = false;

    let client: AndroidDevtoolsClient;
    try {
      client = await connectAndroidDevtoolsClient(spawned.localPort, (err) => {
        if (!disposed) {
          events.emit("terminated", err);
        }
      });
    } catch (err) {
      try {
        spawned.proc.kill();
      } catch {
        /* ignore */
      }
      await removeAdbForward(serial, spawned.localPort);
      throw err;
    }

    // A connected socket doesn't prove the helper answers; ping is the gate.
    try {
      await client.request("ping");
      ready = true;
    } catch (err) {
      client.close();
      try {
        spawned.proc.kill();
      } catch {
        /* ignore */
      }
      await removeAdbForward(serial, spawned.localPort);
      throw err;
    }

    spawned.proc.on("exit", (code, signal) => {
      if (!disposed) {
        events.emit(
          "terminated",
          new FailureError(`android-devtools helper exited (code=${code} signal=${signal})`, {
            error_code: FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_TERMINATED,
            failure_stage: "android_devtools_helper_lifecycle",
            failure_area: "tool_server",
            error_kind: "subprocess",
            failure_command: "android_devtools",
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
        );
      }
    });
    spawned.proc.on("error", (err) => {
      if (!disposed) events.emit("terminated", err);
    });

    const api: AndroidDevtoolsApi = {
      isReady: () => ready && !disposed,
      getHierarchy(getOpts: GetHierarchyOptions = {}) {
        return client.request<HierarchyResult>("getHierarchy", {
          waitForIdleMs: getOpts.waitForIdleMs ?? 500,
          maxDepth: getOpts.maxDepth ?? 128,
          maxNodes: getOpts.maxNodes ?? 5000,
          clearCache: getOpts.clearCache ?? false,
        });
      },
      getScreenSize() {
        return client.request<{ width: number; height: number; rotation: number }>("getScreenSize");
      },
      ping() {
        return client.request<{ ok: boolean; idleMs: number; protocol: string }>("ping");
      },
    };

    const instance: ServiceInstance<AndroidDevtoolsApi> = {
      api,
      dispose: async () => {
        disposed = true;
        ready = false;
        // Ask the helper to exit on its own so `am instrument` ends cleanly.
        try {
          await Promise.race([
            client.request("shutdown"),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("shutdown timeout")), 1_000)
            ),
          ]);
        } catch {
          /* fall through to force-kill */
        }
        client.close();
        try {
          spawned.proc.kill();
        } catch {
          /* ignore */
        }
        await removeAdbForward(serial, spawned.localPort);
      },
      events,
    };

    return instance;
  },
};
