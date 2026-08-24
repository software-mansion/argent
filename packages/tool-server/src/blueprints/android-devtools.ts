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
   * Drop the helper's accessibility-node cache before capturing — it can serve
   * stale text (notably after the inspected app restarts under the helper's
   * connection). Opt in when asserting on changing text; default keeps the
   * cheaper cached read.
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

/**
 * Why a `setText` failure is a RESULT rather than a throw: every outcome below
 * is a device fact the caller acts on by falling back to `adb shell input`, not
 * an error. A broken RPC throws, and so does a `params.text` that is not a
 * string — a caller bug rather than a device fact, which the helper names
 * instead of coercing into the user's field.
 *
 * - `no_focused_input` — nothing holds input focus, so there is no field to set.
 * - `not_editable` — the focused node refused and does not claim to be editable.
 * - `action_refused` — an editable node refused the action.
 * - `action_threw` — the node died mid-call, or the connection was severed.
 * - `unverifiable` — the set was applied, but the node could not be re-read to
 *   confirm it. Treated as a miss by the caller: an unverified atomic write is
 *   worth less than a fallback that reports honestly. A PASSWORD field is
 *   always this for a non-empty write — it publishes one bullet per character
 *   rather than its value, so the read-back cannot confirm anything. Clearing
 *   one still verifies, because empty is empty whether or not it is masked.
 * - `value_mismatch` — the set was applied AND read back, and the field holds
 *   something else. Distinct from `action_refused` in the one way that matters
 *   downstream: the widget did not refuse, so the write may be sitting in the
 *   field already and the fallback is about to add a second one.
 *
 * The last two are the pair where `applied` is true. Everything else means
 * nothing was written.
 */
export type SetTextReason =
  | "no_focused_input"
  | "not_editable"
  | "action_refused"
  | "action_threw"
  | "unverifiable"
  | "value_mismatch";

export interface SetTextResult {
  /** The action was accepted by the widget. Not the same as it having taken. */
  applied: boolean;
  /**
   * The field was re-read after the write and holds exactly the requested value.
   * This is the only flag worth trusting: `applied` is the widget's own claim.
   */
  matched: boolean;
  reason?: SetTextReason;
}

/**
 * The `protocol` string {@link AndroidDevtoolsApi.setText} needs the helper to
 * report. A helper below it does not know the method and answers "Unknown
 * method", which the RPC surfaces as a rejection — so callers ask `ping` first
 * rather than reading a fallback out of an error path.
 *
 * A device provisioned before this method existed is moved onto the new helper
 * by the install path: the manifest's `versionCode` went to 2 alongside it, and
 * `ensureAndroidDevtoolsInstalled` pushes new bytes whenever the device reports
 * less than that. The two numbers have to move together — the APK is linked
 * with its code in argent-private's `build-native-binaries.yml`, and a bump
 * here without one there leaves the gate unsatisfiable, reinstalling on every
 * tool-server process.
 *
 * What can still answer with an older protocol is a helper that is not the one
 * this build ships. Not a race with a foreign install: `spawnHelper` always
 * starts a fresh `am instrument` and connects to the port THAT process announces
 * on its own stdout, so another install's helper is never on the other end of
 * our socket. Two routes are real. An APK whose `versionCode` satisfies the gate
 * while its code predates the method — the bytes and the manifest that stamps
 * them come from different repos. A local `build:android-binaries` can no longer
 * mint one: `native-devtools-android/scripts/build.sh` compares the submodule
 * source's own `PROTOCOL_VERSION` against the manifest's `protocolVersion` and
 * refuses to build when they disagree. A RELEASED APK still can, because
 * `download-native-binaries.sh` compares versionCode to versionCode and cannot
 * read a protocol out of the bytes. And an install-cache entry that outlived the
 * package it recorded, since the cache is keyed by serial and an emulator wipe
 * reuses one.
 */
export const SET_TEXT_MIN_PROTOCOL = 2;

export interface AndroidDevtoolsApi {
  isReady(): boolean;
  getHierarchy(options?: GetHierarchyOptions): Promise<HierarchyResult>;
  getScreenSize(): Promise<{ width: number; height: number; rotation: number }>;
  /**
   * Replace the focused field's whole contents in ONE edit, via the
   * accessibility `ACTION_SET_TEXT`.
   *
   * Requires helper protocol >= {@link SET_TEXT_MIN_PROTOCOL}; an older helper
   * answers "Unknown method" and the RPC rejects, which callers must treat as
   * "fall back", not as a fault.
   */
  setText(text: string): Promise<SetTextResult>;
  ping(): Promise<{ ok: boolean; idleMs: number; protocol: string }>;
}

const READY_TIMEOUT_MS = 30_000;
const HELPER_PORT_MARKER = /^INSTRUMENTATION_STATUS:\s*port=(\d+)/;
const ADB_FORWARD_PORT_MARKER = /^(\d+)\s*$/;

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
      "`adb` not found on PATH or under `$ANDROID_HOME/platform-tools` while spawning android-devtools helper.",
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

    const settle = (fn: () => void, cleanup?: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      cleanup?.();
      fn();
    };

    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on("line", async (rawLine: string) => {
      const line = rawLine.trim();
      const portMatch = HELPER_PORT_MARKER.exec(line);
      if (!portMatch || devicePort !== null) return;
      devicePort = parseInt(portMatch[1]!, 10);

      // `adb forward tcp:0 tcp:DEVICE_PORT` makes adb pick a free local port
      // and print it; saves the host-side `net.createServer(0)` dance.
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

    proc.on("exit", (code, signal) => {
      const detail = stderrBuf.trim() ? ` stderr=${stderrBuf.trim().slice(0, 400)}` : "";
      settle(() =>
        reject(
          new FailureError(
            `am instrument exited before becoming ready (code=${code} signal=${signal}).${detail}`,
            {
              error_code: FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_EXITED_BEFORE_READY,
              failure_stage: "android_devtools_helper_ready",
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
            }
          )
        )
      );
    });

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

async function removeAdbForward(serial: string, localPort: number): Promise<void> {
  try {
    await runAdb(["-s", serial, "forward", "--remove", `tcp:${localPort}`], { timeoutMs: 5_000 });
  } catch {
    // Best-effort: adb forward --remove can race with adb daemon restarts.
    // Leftover forwards are harmless; they'll be re-shadowed on next spawn.
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

    await ensureAndroidDevtoolsInstalled(serial);

    const spawned = await spawnHelper(serial);
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

    // Handshake — confirms the socket is talking to our helper, not stale state.
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
      setText(text: string) {
        return client.request<SetTextResult>("setText", { text });
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
        // Best-effort graceful shutdown — gives the helper a chance to call
        // `finish(0, ...)` so `am instrument` exits with code 0 and adb
        // doesn't log a noisy stack trace. Bounded by a tight timeout.
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
