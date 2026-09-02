import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  withFailureSignal,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
  type ServiceInstance,
} from "@argent/registry";
import { ensureDeviceReady } from "../utils/ios-device/devicectl";
import {
  ensureRunnerArtifact,
  isProfileExpiredFailure,
  isProfileMissingDeviceFailure,
  killRunnerProcess,
  killStaleRunnersForDevice,
  launchRunner,
  resolveRunnerSigningConfig,
  waitForRunnerListeningPort,
  type LaunchedRunner,
  type RunnerArtifact,
  type RunnerSigningConfig,
} from "../utils/ios-device/runner-build";
import * as fs from "node:fs/promises";
import { createUsbmuxCommandSender } from "../utils/ios-device/runner-route";
import { isIosDeviceTransportError } from "../utils/ios-device/usbmux-protocol";
import { readRunnerCrashSummary } from "../utils/ios-device/runner-crash";
import {
  createRunnerClient,
  isRunnerWedgedError,
  waitForRunnerReady,
  type RunnerClient,
} from "../utils/ios-device/runner-client";

export const IOS_DEVICE_RUNNER_NAMESPACE = "IosDeviceRunner";

/** How long an app-scoped runner death stays in memory. */
const CRASH_MEMORY_MS = 10 * 60 * 1000;

/**
 * App-scoped runner deaths, keyed `udid|bundleId`.
 * Lives outside the service instance. A repeat across respawns can then escalate.
 */
const recentAppCrashes = new Map<string, number[]>();

/** Record an app-scoped death and return how many fall inside the window. */
function recordAppCrash(udid: string, bundleId: string): number {
  const key = `${udid}|${bundleId}`;
  const now = Date.now();
  const kept = (recentAppCrashes.get(key) ?? []).filter((t) => now - t < CRASH_MEMORY_MS);
  kept.push(now);
  recentAppCrashes.set(key, kept);
  return kept.length;
}

/** True for a transport error that can mean the runner died. */
function looksTransportDead(error: unknown): boolean {
  // device-unattached is a cable verdict. Keep its connect-the-cable hint even if the child also died.
  return isIosDeviceTransportError(error) && error.kind !== "device-unattached";
}

/**
 * True when the error is a synthesized runner-death.
 * `recoverable()` keys off this marker, not message text.
 */
function isRunnerExitedError(error: unknown): boolean {
  return (error as { runnerExited?: unknown } | null)?.runnerExited === true;
}

/**
 * If the runner died mid-command, replace the transport error with a post-mortem.
 * Otherwise return the original error.
 */
async function explainRunnerDeath(options: {
  error: unknown;
  command: Record<string, unknown>;
  udid: string;
  resultBundlePath: string;
  logPath: string;
  /** Resolves once the child has exited, or after `ms`, whichever first. */
  settleExit: (ms: number) => Promise<void>;
  /** `undefined` while the child still runs. The exit code (possibly null) once dead. */
  getExitCode: () => number | null | undefined;
}): Promise<unknown> {
  const { error, command, udid } = options;

  if (!looksTransportDead(error)) {
    return error;
  }

  // Wait briefly for a straggling exit. A dead transport does not prove the child exited.
  await options.settleExit(1_500);
  const exitCode = options.getExitCode();

  if (exitCode === undefined) {
    return error;
  }

  const bundleId = typeof command.appBundleId === "string" ? command.appBundleId : null;
  const deaths = bundleId ? recordAppCrash(udid, bundleId) : 0;
  const crash = await readRunnerCrashSummary(options.resultBundlePath);

  const recovery =
    deaths >= 2 && bundleId
      ? ` Runner death #${deaths} for ${bundleId} in the last ` +
        `${CRASH_MEMORY_MS / 60_000} minutes; the app's current screen is likely crashing ` +
        `XCTest. Run restart-app for ${bundleId}, then retry.`
      : ` The runner respawns on the next call; re-observe the screen and retry.`;

  // The marker keeps recoverable() matching. The registry tears the instance down.
  return Object.assign(
    withFailureSignal(
      new Error(
        `iOS device runner exited (code ${exitCode}) while executing '${String(command.command)}'` +
          (crash ? `; recorded crash: ${crash}.` : ".") +
          recovery +
          ` Log: ${options.logPath}`,
        { cause: error }
      ),
      {
        error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_EXITED,
        failure_stage: "ios_device_runner_exited",
        failure_area: "tool_server",
        error_kind: "subprocess",
        ...(typeof exitCode === "number" ? { failure_exit_code: exitCode } : {}),
      }
    ),
    { runnerExited: true }
  );
}

/** Per-device XCUITest runner for a physical iOS device. */
export interface IosDeviceRunnerApi {
  /** Send a raw runner command. */
  run(
    command: Record<string, unknown>,
    opts?: { readOnly?: boolean; timeoutMs?: number }
  ): Promise<unknown>;
  /** The device UDID this runner drives. */
  udid: string;
}

/** Registry ref for the runner on this device. */
export function iosDeviceRunnerRef(device: DeviceInfo): {
  urn: string;
  options: { device: DeviceInfo };
} {
  return {
    urn: `${IOS_DEVICE_RUNNER_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

/** Startup budget for install, launch, the runner's port line, and the first ready envelope. */
const RUNNER_READY_TIMEOUT_MS = 120_000;

/**
 * Launch the runner from a built artifact, read the port it bound from the
 * launch log, and wait for its first ready envelope. On failure the child is
 * killed and the error carries `runnerLogText` so the caller can inspect the
 * launch log.
 */
async function startRunner(
  udid: string,
  artifact: RunnerArtifact
): Promise<{ launched: LaunchedRunner; client: RunnerClient }> {
  const launched = await launchRunner({
    udid,
    xctestrunPath: artifact.xctestrunPath,
    derivedDataPath: artifact.derivedDataPath,
  });

  // The factory exit listener is not attached yet. Race ready against exit so a dead child does not burn the full ready budget.
  let onExit!: (code: number | null) => void;

  const exited = new Promise<never>((_resolve, reject) => {
    onExit = (code) =>
      reject(new Error(`xcodebuild exited (code ${code}) before the runner became ready`));
  });

  // Swallow the losing race. A post-kill exit on the timeout path still fires onExit.
  exited.catch(() => {});

  launched.child.once("exit", onExit);

  let client: RunnerClient;

  try {
    const expiresAt = Date.now() + RUNNER_READY_TIMEOUT_MS;

    // The runner binds a system-assigned loopback port on the device and logs it.
    // Nothing on the Mac can pick that port, so the client waits for the line.
    const port = await Promise.race([
      waitForRunnerListeningPort(launched.logPath, { timeoutMs: RUNNER_READY_TIMEOUT_MS }),
      exited,
    ]);

    client = createRunnerClient({
      udid,
      port,
      send: createUsbmuxCommandSender().sendCommand,
    });

    // The rest of the same budget goes to the first envelope.
    await Promise.race([
      waitForRunnerReady(client, { timeoutMs: Math.max(1, expiresAt - Date.now()) }),
      exited,
    ]);
  } catch (error) {
    killRunnerProcess(launched.child);

    const logText = await fs.readFile(launched.logPath, "utf8").catch(() => "");

    throw Object.assign(
      withFailureSignal(
        new Error(
          `The on-device runner did not become ready: ${String((error as Error).message)}. ` +
            `Check the log at ${launched.logPath}. If this is the first run, unlock the ` +
            `device and trust the developer app under Settings > General > VPN & Device ` +
            `Management.`,
          { cause: error }
        ),
        {
          error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
          failure_stage: "ios_device_runner_ready",
          failure_area: "tool_server",
          error_kind: "timeout",
        }
      ),
      { runnerExited: true, runnerLogText: logText }
    );
  } finally {
    // Drop this listener. The factory listener owns exits after ready. terminated then fires once.
    launched.child.removeListener("exit", onExit);
  }

  return {
    launched,
    client,
  };
}

/**
 * Build the runner artifact and start it. Retries once when the profile is
 * missing this device or has expired.
 */
async function buildAndStartRunner(
  udid: string,
  signing: RunnerSigningConfig
): Promise<{ launched: LaunchedRunner; client: RunnerClient }> {
  let artifact: RunnerArtifact;

  try {
    artifact = await ensureRunnerArtifact(signing);
  } catch (error) {
    // A new team cannot mint a profile from the generic build. Rebuild against this device to register it.
    const message = error instanceof Error ? error.message : String(error);
    if (!isProfileMissingDeviceFailure(message)) throw error;
    artifact = await ensureRunnerArtifact(signing, { destinationUdid: udid, force: true });
  }

  try {
    return await startRunner(udid, artifact);
  } catch (error) {
    const logText = (error as { runnerLogText?: string }).runnerLogText ?? "";
    if (!isProfileMissingDeviceFailure(logText) && !isProfileExpiredFailure(logText)) throw error;
    // The profile lacks this device or has expired. Rebuild against the device:
    // automatic signing registers it and mints a fresh profile. Retry once.
    return await startRunner(
      udid,
      await ensureRunnerArtifact(signing, { destinationUdid: udid, force: true })
    );
  }
}

/** Registry blueprint that builds, launches, and recycles the on-device runner. */
export const iosDeviceRunnerBlueprint: ServiceBlueprint<IosDeviceRunnerApi, DeviceInfo> = {
  namespace: IOS_DEVICE_RUNNER_NAMESPACE,
  getURN(device: DeviceInfo) {
    return `${IOS_DEVICE_RUNNER_NAMESPACE}:${device.id}`;
  },
  async factory(_deps, payload, options): Promise<ServiceInstance<IosDeviceRunnerApi>> {
    const deviceFromOpts = (options as { device?: DeviceInfo } | undefined)?.device;
    // URN payload is the udid string. options.device is the richer object iosDeviceRunnerRef fills.
    const udid = deviceFromOpts?.id ?? (typeof payload === "string" ? payload : undefined);

    if (!udid) {
      throw new FailureError(
        `${IOS_DEVICE_RUNNER_NAMESPACE}.factory could not determine the device; pass it via iosDeviceRunnerRef(device).`,
        {
          error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_FACTORY_OPTIONS_MISSING,
          failure_stage: "ios_device_runner_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    await ensureDeviceReady(udid);
    await killStaleRunnersForDevice(udid);

    const { launched, client } = await buildAndStartRunner(
      udid,
      await resolveRunnerSigningConfig()
    );

    const events = new TypedEventEmitter<ServiceEvents>();
    let disposed = false;
    // undefined while still running. The exit code (possibly null) once dead.
    let exitCode: number | null | undefined;
    const exitWaiters: Array<() => void> = [];

    launched.child.on("exit", (code) => {
      exitCode = code;

      for (const wake of exitWaiters.splice(0)) {
        wake();
      }

      if (!disposed) {
        events.emit(
          "terminated",
          new FailureError(`iOS device runner exited (code ${code}). Log: ${launched.logPath}`, {
            error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_TERMINATED,
            failure_stage: "ios_device_runner_process_exit",
            failure_area: "tool_server",
            error_kind: "subprocess",
          })
        );
      }
    });

    /** Resolves once the child has exited, or after `ms`, whichever first. */
    const settleExit = (ms: number): Promise<void> =>
      exitCode !== undefined
        ? Promise.resolve()
        : new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);

            exitWaiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });

    const api: IosDeviceRunnerApi = {
      udid,
      run: async (command, opts) => {
        try {
          return await client.run(command, opts);
        } catch (error) {
          throw await explainRunnerDeath({
            error,
            command,
            udid,
            resultBundlePath: launched.resultBundlePath,
            logPath: launched.logPath,
            settleExit,
            getExitCode: () => exitCode,
          });
        }
      },
    };

    return {
      api,
      events,
      dispose: async () => {
        disposed = true;

        try {
          // shutdown is mutating. Send it once. The child is killed below either way.
          await client.run({ command: "shutdown" }, { timeoutMs: 3_000 });
        } catch {
          /* best-effort graceful stop */
        }

        killRunnerProcess(launched.child);
      },
    };
  },
  recoverable(error: unknown): boolean {
    // A confirmed runner death, or a runner that answered only to report its
    // main thread stuck past recovery: both need a fresh runner, so the
    // registry disposes this one and retries the tool once. Any other answer
    // from a live runner, or a transport loss with a live child, is not
    // recoverable here.
    return isRunnerExitedError(error) || isRunnerWedgedError(error);
  },
};
