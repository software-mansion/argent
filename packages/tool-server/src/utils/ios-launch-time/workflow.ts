import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { argentHomeDir } from "@argent/configuration-core";
import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  wrapFailure,
  type FailureKind,
} from "@argent/registry";
import {
  GENERIC_DEVICECTL_HINT,
  installedAppUrl,
  listIosPhysicalDevices,
  ensureDeviceReady,
  launchApp,
} from "../ios-device/devicectl";
import { listIosSimulators } from "../ios-devices";
import { simctlPrefix } from "../ios-device-sets";
import { resolveSigningHint } from "../ios-device/runner-signing";
import { xcodebuildFailureSummary } from "../ios-device/runner-artifact";
import { scheduleGroupSigkill, signalGroup } from "../process-kill";
import { withKeyedLock } from "../keyed-lock";
import { getDebugDir } from "../react-profiler/debug/dump";

const execFileAsync = promisify(execFile);
// Only catches a hung xcodebuild; callers cancel through the abort signal.
const BUILD_TIMEOUT_MS = 60 * 60_000;
const BOOTSTATUS_TIMEOUT_MS = 180_000;

/** DerivedData for builds of Argent's launch test runner. */
export function runnerBuildCacheDir(key: string): string {
  return path.join(argentHomeDir(), "build-cache", "ios-launch-time-runner", key);
}

// Concurrent builds into one DerivedData fail with "database is locked".
const runnerBuildLocks = new Map<string, Promise<unknown>>();

/**
 * A cancelled caller stops queueing, but once `fn` starts the call settles only
 * with it, so a device reservation never outlives its xcodebuild.
 */
export function withRunnerBuildLock<T>(
  derivedDataPath: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let started = false;
  const run = withKeyedLock(runnerBuildLocks, derivedDataPath, () => {
    started = true;
    signal?.throwIfAborted();
    return fn();
  });
  if (!signal) return run;
  const queuedAbort = new Promise<never>((_, reject) => {
    const onAbort = () => {
      if (!started) reject(signal.reason as Error);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([run, queuedAbort]);
}

/** A new run directory beside the other native-profiler traces. */
async function createRunDir(): Promise<string> {
  return fsp.mkdtemp(
    path.join(
      await getDebugDir(),
      `launch-analysis-${new Date().toISOString().replace(/[-:.]/g, "")}-`
    )
  );
}

interface LaunchRequest {
  bundleId: string;
  deviceId?: string;
  allowSimulator?: boolean;
  /** Runs once the device is selected, before the app is looked up; throw to stop early. */
  checkDevice?: (device: { id: string; simulator: boolean }) => void | Promise<void>;
}

interface LaunchContext {
  runDir: string;
  deviceId: string;
  deviceName: string;
  simulator: boolean;
  simulatorDeviceSet: string | null;
  destination: string;
  bundleId: string;
  /** The installed .app: a directory on a simulator, devicectl's file URL on an iPhone. */
  appPath: string;
  warning: string | null;
}

const FREE_PROFILE_LIMIT = "maximum number of installed apps using a free developer profile";

function isFreeProfileLimit(text: string): boolean {
  return text.toLowerCase().includes(FREE_PROFILE_LIMIT);
}

/**
 * The installed apps the free-profile cap error lists. Xcode prints them after
 * the cap text inside `{( ... )}`, each with its team prefix.
 */
function installedAppText(text: string): string {
  const blocks = [...text.matchAll(/free developer profile[^\n]*?\{\(([\s\S]*?)\)\}/gi)].map(
    (match) => match[1]!
  );
  if (blocks.length > 0) return blocks.join("\n");
  return text
    .split("\n")
    .filter((line) => isFreeProfileLimit(line))
    .join("\n");
}

/**
 * Pass the full xcodebuild log: the installed bundle IDs follow the cap line.
 * A `com.argent.runner.t<team>` other than `ownBundleIdPrefix` is likely a
 * leftover runner of a different team.
 */
export function freeProfileLimitMessage(
  text: string,
  options: { logPath: string; ownBundleIdPrefix: string }
): string | null {
  if (!isFreeProfileLimit(text)) return null;
  const own = options.ownBundleIdPrefix.toLowerCase();
  // The match drops the team prefix and the `.uitests.xctrunner` suffix.
  const leftover = (installedAppText(text).match(/com\.argent\.runner\.t[a-z0-9]+/gi) ?? [])
    .map((id) => id.toLowerCase())
    .find((id) => id !== own);
  return (
    "The iPhone's free developer profile has no slot for Argent's UI-test runner. " +
    "Remove an app you choose or use a paid team. Argent did not remove another app. " +
    (leftover
      ? `${leftover} looks like a leftover Argent runner from a different team; you can delete it. `
      : "") +
    `Log: ${options.logPath}`
  );
}

function errorText(output: string, logPath: string): string {
  // The free-profile cap is not a signing problem; keep its line instead of a signing hint.
  const freeProfileLines = isFreeProfileLimit(output)
    ? output.split("\n").filter((line) => isFreeProfileLimit(line))
    : [];
  const signingHint = freeProfileLines.length > 0 ? null : resolveSigningHint(output);
  return `${xcodebuildFailureSummary(output)}${freeProfileLines.length > 0 ? `\n${[...new Set(freeProfileLines)].join("\n")}` : ""}${signingHint ? `\n${signingHint}` : ""}\nFull log: ${logPath}`;
}

/** Thrown by {@link runLogged} when the command ran past its timeout and was killed. */
export class CommandTimeoutError extends Error {
  readonly timedOut = true;

  constructor(message: string) {
    super(message);
    this.name = "CommandTimeoutError";
  }
}

/** `code` and `signal` match the fields of an execFile error. */
export class CommandExitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null
  ) {
    super(message);
    this.name = "CommandExitError";
  }
}

// Exit codes a shell reports for a process killed by SIGABRT, SIGBUS or SIGSEGV (128 + signal).
const CRASH_EXIT_CODES = new Set([134, 138, 139]);
const CRASH_SIGNALS = new Set(["SIGABRT", "SIGBUS", "SIGSEGV"]);

/** True when a failed runLogged or execFile command crashed. */
export function isCrash(error: unknown): boolean {
  if (error instanceof CommandTimeoutError) return false;
  const { code, signal, name } = (error ?? {}) as {
    code?: unknown;
    signal?: unknown;
    name?: unknown;
  };
  if (name === "AbortError") return false;
  return (
    (typeof code === "number" && CRASH_EXIT_CODES.has(code)) ||
    (typeof signal === "string" && CRASH_SIGNALS.has(signal))
  );
}

/** The error_kind of a failed runLogged or execFile command. */
export function commandFailureKind(error: unknown): FailureKind {
  if (error instanceof CommandTimeoutError || (error as { killed?: unknown } | null)?.killed) {
    return "timeout";
  }
  return isCrash(error) ? "crash" : "subprocess";
}

export const XCTRACE_EXPORT_ATTEMPTS = 3;

/**
 * Xcode 26.4.1 xctrace intermittently segfaults loading a valid trace, and a
 * later attempt succeeds. For exports only, never a recording.
 */
export async function withXctraceCrashRetry<T>(
  run: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await run();
    } catch (error) {
      if (attempt >= XCTRACE_EXPORT_ATTEMPTS || !isCrash(error)) throw error;
    }
  }
}

// How long an aborted command gets to exit on SIGTERM before SIGKILL.
const ABORT_KILL_GRACE_MS = 5_000;

// Logged commands run detached; kill their groups if the tool-server exits mid-call.
const runningGroups = new Set<number>();
let exitHookInstalled = false;

function trackGroup(pid: number): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const group of runningGroups) signalGroup(group, "SIGKILL");
    });
  }
  runningGroups.add(pid);
}

export async function runLogged(
  command: string,
  args: string[],
  options: {
    cwd: string;
    logPath: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }
): Promise<void> {
  options.signal?.throwIfAborted();
  await fsp.mkdir(path.dirname(options.logPath), { recursive: true });
  options.signal?.throwIfAborted();
  const log = fs.createWriteStream(options.logPath);
  // Best effort: an unhandled stream error would crash the tool-server.
  log.on("error", () => undefined);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const pid = child.pid;
  if (pid) trackGroup(pid);
  let tail = "";
  const collect = (chunk: Buffer) => {
    const value = chunk.toString();
    log.write(value);
    tail = (tail + value).slice(-32_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const stop = () => {
    if (!child.pid) return;
    signalGroup(child.pid, "SIGTERM");
    // xctrace ignores SIGTERM and SIGINT while it is stalled.
    scheduleGroupSigkill(child.pid, ABORT_KILL_GRACE_MS, { gateOnGroupLiveness: true });
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const timeoutMs = options.timeoutMs ?? BUILD_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) signalGroup(child.pid, "SIGKILL");
  }, timeoutMs);
  try {
    const { code, signal } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) =>
        resolve({ code: exitCode, signal: exitSignal })
      );
    });
    options.signal?.throwIfAborted();
    if (timedOut) {
      throw new CommandTimeoutError(
        `${command} timed out after ${Math.round(timeoutMs / 1000)} s and was killed. Full log: ${options.logPath}`
      );
    }
    if (code !== 0) {
      throw new CommandExitError(
        `${command} ${signal ? `was killed by ${signal}` : `exited with ${code}`}:\n${errorText(tail, options.logPath)}`,
        code,
        signal
      );
    }
  } finally {
    if (pid) runningGroups.delete(pid);
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
    await new Promise<void>((resolve) => log.end(resolve));
  }
}

async function smallCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 60_000
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });
  return stdout;
}

async function waitForDeviceAction<T>(
  action: () => Promise<T>,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The fallback hint names unlock and trust for any devicectl failure, so
      // only the error itself says whether waiting can help.
      const generic = (error as { hint?: unknown }).hint === GENERIC_DEVICECTL_HINT;
      const cause = generic ? message.replace(GENERIC_DEVICECTL_HINT, "") : message;
      if (
        !/unlock|locked|trust|developer mode|tunnel is still connecting/i.test(cause) ||
        Date.now() >= deadline
      )
        throw error;
      onProgress?.(`Waiting for iPhone setup: ${message}`);
      await delay(5_000, undefined, { signal });
    }
  }
}

export async function ensureLaunchDeviceReady(
  context: LaunchContext,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!context.simulator) {
    await waitForDeviceAction(() => ensureDeviceReady(context.deviceId), onProgress, signal);
  }
}

function deviceUnavailable(message: string, error_kind: FailureKind): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.LAUNCH_ANALYSIS_DEVICE_UNAVAILABLE,
    failure_stage: "launch_analysis_select_device",
    failure_area: "tool_server",
    error_kind,
  });
}

async function selectDevice(
  request: LaunchRequest,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<{
  id: string;
  name: string;
  simulator: boolean;
  deviceSet: string | null;
  destination: string;
}> {
  const devices = await listIosPhysicalDevices();
  const selected = request.deviceId
    ? devices.find((device) => device.udid === request.deviceId)
    : undefined;
  // Matched before the cable filter, so a named iPhone that is off the cable
  // says so instead of reading as absent.
  if (selected && selected.transportType !== "wired") {
    throw deviceUnavailable(
      `iPhone ${selected.udid} is not connected by USB cable (transport: ${selected.transportType ?? "none"}). ` +
        "Launch measurement runs over the cable; connect it and retry.",
      "unsupported"
    );
  }
  const physical = devices.filter((device) => device.transportType === "wired");
  if (selected) {
    await waitForDeviceAction(() => ensureDeviceReady(selected.udid), onProgress, signal);
    return {
      id: selected.udid,
      name: selected.name,
      simulator: false,
      deviceSet: null,
      destination: `platform=iOS,id=${selected.udid}`,
    };
  }
  if (physical.length > 0 && !request.deviceId) {
    throw deviceUnavailable(
      `Connected iPhones: ${physical.map((d) => d.udid).join(", ")}. Pass device_id to select one.` +
        (request.allowSimulator
          ? " To use a booted simulator while an iPhone is connected, pass the simulator's UDID as device_id."
          : ""),
      "validation"
    );
  }
  if (!request.allowSimulator) {
    throw deviceUnavailable(
      "No selected connected iPhone is available. Connect and unlock one, pass device_id, or explicitly set allow_simulator. " +
        "Simulator launch timings reflect Mac hardware rather than a physical iPhone.",
      "not_found"
    );
  }
  const all = (await listIosSimulators()).filter((device) => device.runtimeKind !== "tv");
  const requested = request.deviceId
    ? all.find((device) => device.udid === request.deviceId)
    : undefined;
  if (requested && requested.state !== "Booted") {
    throw deviceUnavailable(
      `Simulator ${requested.udid} is not booted (state: ${requested.state}). Boot it with boot-device, then retry.`,
      "not_found"
    );
  }
  if (requested?.deviceSet) {
    throw deviceUnavailable(
      `Simulator ${requested.udid} is in the device set ${requested.deviceSet}. xcodebuild and xctrace ` +
        "see only Xcode's default device set; use a simulator from that set.",
      "unsupported"
    );
  }
  const simulators = all.filter((device) => device.state === "Booted" && !device.deviceSet);
  const simulator = request.deviceId
    ? simulators.find((device) => device.udid === request.deviceId)
    : simulators.length === 1
      ? simulators[0]
      : undefined;
  if (!simulator) {
    throw deviceUnavailable(
      request.deviceId
        ? `No connected iPhone or booted simulator has the UDID ${request.deviceId}.`
        : "Boot a single iOS simulator or select one with device_id.",
      request.deviceId || simulators.length === 0 ? "not_found" : "validation"
    );
  }
  return {
    id: simulator.udid,
    name: simulator.name,
    simulator: true,
    deviceSet: simulator.deviceSet ?? null,
    destination: `platform=iOS Simulator,id=${simulator.udid}`,
  };
}

/**
 * `xcodebuild -version` on one line, "unknown-xcode" when it fails. Not cached:
 * xcode-select can change while the tool-server runs.
 */
export function xcodeVersion(): Promise<string> {
  return execFileAsync("xcodebuild", ["-version"], { timeout: 20_000 }).then(
    ({ stdout }) => stdout.trim().replace(/\n/g, " "),
    () => "unknown-xcode"
  );
}

function appNotInstalled(
  bundleId: string,
  device: { id: string; simulator: boolean },
  cause?: unknown
): FailureError {
  const target = device.simulator ? "simulator" : "iPhone";
  return new FailureError(
    `${bundleId} is not installed on the ${target} ${device.id}. This tool does not build or ` +
      `install the app: build it in Release with the project's own build flow, install it on ` +
      `this ${target}, then retry.`,
    {
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_APP_NOT_INSTALLED,
      failure_stage: "launch_analysis_find_app",
      failure_area: "tool_server",
      error_kind: "not_found",
    },
    cause instanceof Error ? { cause } : undefined
  );
}

async function findInstalledApp(
  device: { id: string; simulator: boolean; deviceSet: string | null },
  bundleId: string,
  signal?: AbortSignal
): Promise<string> {
  if (!device.simulator) {
    const url = await installedAppUrl(device.id, bundleId);
    if (!url) throw appNotInstalled(bundleId, device);
    return url;
  }
  try {
    return (
      await smallCommand(
        "xcrun",
        [...simctlPrefix(device.deviceSet), "get_app_container", device.id, bundleId, "app"],
        signal
      )
    ).trim();
  } catch (error) {
    signal?.throwIfAborted();
    // simctl reports an app that is not installed as a missing file.
    if (/no such file or directory/i.test(error instanceof Error ? error.message : "")) {
      throw appNotInstalled(bundleId, device, error);
    }
    throw simctlFailure(error, "launch_analysis_find_app");
  }
}

export async function prepareLaunch(
  request: LaunchRequest,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<LaunchContext> {
  signal?.throwIfAborted();
  if (process.platform !== "darwin")
    throw new FailureError("iOS launch measurement requires macOS and Xcode.", {
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_UNSUPPORTED_HOST,
      failure_stage: "launch_analysis_host_platform",
      failure_area: "tool_server",
      error_kind: "unsupported",
    });
  const device = await selectDevice(request, onProgress, signal);
  await request.checkDevice?.(device);
  const simctl = simctlPrefix(device.deviceSet);
  // A simulator that is still booting fails the app lookup and launch.
  if (device.simulator) {
    await runSimctl(
      [...simctl, "bootstatus", device.id, "-b"],
      "launch_analysis_simulator_prelaunch",
      signal,
      BOOTSTATUS_TIMEOUT_MS
    );
  }
  const appPath = await findInstalledApp(device, request.bundleId, signal);
  // One launch before the measured ones, so they are warm.
  if (device.simulator) {
    await runSimctl(
      [...simctl, "launch", device.id, request.bundleId],
      "launch_analysis_simulator_prelaunch",
      signal
    );
  } else {
    await waitForDeviceAction(
      () => launchApp(device.id, request.bundleId, { terminateExisting: true }),
      onProgress,
      signal
    );
  }
  // Created only once the app runs, so an early failure leaves no empty run dir.
  const runDir = await createRunDir();
  const context: LaunchContext = {
    runDir,
    deviceId: device.id,
    deviceName: device.name,
    simulator: device.simulator,
    simulatorDeviceSet: device.deviceSet,
    destination: device.destination,
    bundleId: request.bundleId,
    appPath,
    warning: device.simulator
      ? "Simulator timings reflect Mac hardware; validate performance on a physical iPhone."
      : null,
  };
  await fsp.writeFile(
    path.join(runDir, "manifest.json"),
    JSON.stringify({ ...context, preparedAt: new Date().toISOString() }, null, 2)
  );
  return context;
}

/**
 * True when a devicectl process `executable` is the main executable of the app
 * installed at `appUrl`, not one of its extensions. devicectl reports both as
 * file URLs, which percent-encode spaces and non-ASCII names.
 */
export function isAppExecutable(executable: string, appUrl: string): boolean {
  const decode = (url: string) => {
    try {
      return decodeURI(url);
    } catch {
      // Not a valid URI escape sequence: compare the raw text.
      return url;
    }
  };
  // `<container UUID>/<Name>.app`, so a /var and a /private/var spelling still match.
  const bundle = decode(appUrl).replace(/\/+$/, "").split("/").slice(-2).join("/");
  const rest = decode(executable).split(`/${bundle}/`)[1];
  return Boolean(rest) && !rest!.includes("/");
}

/** Terminate a prelaunched app so the next activation starts a new, recently used process. */
export async function terminateForWarmLaunch(
  context: LaunchContext,
  signal?: AbortSignal
): Promise<void> {
  if (context.simulator) {
    await runSimctl(
      [
        ...simctlPrefix(context.simulatorDeviceSet),
        "terminate",
        context.deviceId,
        context.bundleId,
      ],
      "launch_analysis_warm_terminate",
      signal
    );
    return;
  }
  const devicectlFailure = (error: unknown) => {
    signal?.throwIfAborted();
    return wrapFailure(error, {
      error_code: FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED,
      failure_stage: "launch_analysis_warm_terminate",
      failure_area: "tool_server",
      error_kind: commandFailureKind(error),
      ...subprocessFailureMetadata(error, "devicectl"),
    });
  };
  let payload: {
    result?: { runningProcesses?: Array<{ executable?: string; processIdentifier?: number }> };
  };
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      [
        "devicectl",
        "device",
        "info",
        "processes",
        "--device",
        context.deviceId,
        "--json-output",
        "-",
      ],
      // All processes: the app is matched by its installed bundle URL below.
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal }
    );
    payload = JSON.parse(stdout.slice(stdout.indexOf("{"))) as typeof payload;
  } catch (error) {
    throw devicectlFailure(error);
  }
  const process = payload.result?.runningProcesses?.find(
    (entry) => entry.executable !== undefined && isAppExecutable(entry.executable, context.appPath)
  );
  if (!process?.processIdentifier) {
    throw new FailureError(
      `Could not verify that ${context.bundleId} was running before warm-launch capture.`,
      {
        error_code: FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED,
        failure_stage: "launch_analysis_warm_terminate",
        failure_area: "tool_server",
        error_kind: "not_found",
        failure_command: "devicectl",
      }
    );
  }
  try {
    await smallCommand(
      "xcrun",
      [
        "devicectl",
        "device",
        "process",
        "terminate",
        "--device",
        context.deviceId,
        "--pid",
        String(process.processIdentifier),
      ],
      signal
    );
  } catch (error) {
    throw devicectlFailure(error);
  }
}

/** A failed simctl step that finds, prepares or stops the app on a simulator. */
function simctlFailure(error: unknown, failure_stage: string): FailureError {
  return wrapFailure(error, {
    error_code: FAILURE_CODES.LAUNCH_ANALYSIS_SIMCTL_FAILED,
    failure_stage,
    failure_area: "tool_server",
    error_kind: commandFailureKind(error),
    ...subprocessFailureMetadata(error, "xcrun_simctl"),
  });
}

async function runSimctl(
  args: string[],
  failure_stage: string,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<string> {
  try {
    return await smallCommand("xcrun", args, signal, timeoutMs);
  } catch (error) {
    signal?.throwIfAborted();
    throw simctlFailure(error, failure_stage);
  }
}

// Bounds the cleanup, whose device path alone could otherwise take 90 s.
const TERMINATE_LAUNCHED_APP_TIMEOUT_MS = 15_000;

/** Best-effort; ignores the tool's abort signal so a cancelled recording is still cleaned up. */
export async function terminateLaunchedApp(context: LaunchContext): Promise<void> {
  await terminateForWarmLaunch(
    context,
    AbortSignal.timeout(TERMINATE_LAUNCHED_APP_TIMEOUT_MS)
  ).catch(() => undefined);
}
