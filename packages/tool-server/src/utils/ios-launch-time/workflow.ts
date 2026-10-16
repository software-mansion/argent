import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { argentHomeDir } from "@argent/configuration-core";
import {
  listIosPhysicalDevices,
  ensureDeviceReady,
  installApp,
  launchApp,
} from "../ios-device/devicectl";
import { listIosSimulators } from "../ios-devices";
import { simctlPrefix } from "../ios-device-sets";
import { resolveRunnerSigningConfig, resolveSigningHint } from "../ios-device/runner-signing";
import { detectSigningTeams } from "../ios-device/team-detect";
import { xcodebuildFailureSummary } from "../ios-device/runner-artifact";
import { scheduleGroupSigkill, signalGroup } from "../process-kill";

const execFileAsync = promisify(execFile);
// A clean Release build of a large app (many pods, Hermes bytecode) can pass
// 15 minutes. The tools are long running and cancel through the abort signal,
// so this only catches a hung xcodebuild.
const BUILD_TIMEOUT_MS = 60 * 60_000;
// `simctl bootstatus -b` boots the simulator if it is not booted, then waits
// until it has finished booting.
const BOOTSTATUS_TIMEOUT_MS = 180_000;

/**
 * DerivedData for launch builds, outside the app project so it never lands in
 * the project's git status or under Metro's watcher.
 */
export function launchBuildCacheDir(kind: "app" | "runner", key: string): string {
  return path.join(
    argentHomeDir(),
    "build-cache",
    kind === "app" ? "ios-launch-time" : "ios-launch-time-runner",
    key
  );
}

interface LaunchRequest {
  workspacePath: string;
  deviceId?: string;
  scheme?: string;
  xcodeContainer?: string;
  allowSimulator?: boolean;
  /** Xcode configuration for the app. Defaults to "Release". */
  configuration?: string;
  /** Runs once the device is selected, before the build; throw to stop early. */
  checkDevice?: (device: { simulator: boolean }) => Promise<void>;
}

interface LaunchContext {
  runDir: string;
  deviceId: string;
  deviceName: string;
  simulator: boolean;
  simulatorDeviceSet: string | null;
  destination: string;
  bundleId: string;
  executableName: string;
  appPath: string;
  scheme: string;
  container: string;
  teamId: string | null;
  warning: string | null;
}

const FREE_PROFILE_LIMIT = "maximum number of installed apps using a free developer profile";

/** True when the text reports the free developer profile's installed-app cap. */
function isFreeProfileLimit(text: string): boolean {
  return text.toLowerCase().includes(FREE_PROFILE_LIMIT);
}

/**
 * Bundle IDs that the free-profile cap error lists as installed. Xcode and
 * devicectl print them on the lines after the cap text, inside `{( ... )}`,
 * each with its team prefix ("5W6H93822S.com.argent.runner.t5w6h93822s...").
 * Without that block, the cap lines themselves are scanned.
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
 * The friendly error for the free-profile app cap, or null for other text.
 * `text` should be the full failure output, so the installed bundle IDs that
 * follow the cap line are in it. `ownBundleIdPrefix` is this setup's Argent
 * runner bundle ID; when it is known, another `com.argent.runner.t<team>` among
 * the installed apps is a likely leftover of a different team.
 */
export function freeProfileLimitMessage(
  text: string,
  options: { subject: string; logPath?: string; ownBundleIdPrefix?: string }
): string | null {
  if (!isFreeProfileLimit(text)) return null;
  const own = options.ownBundleIdPrefix?.toLowerCase();
  // The match drops the team prefix and the `.uitests.xctrunner` suffix.
  const runners = [
    ...new Set(
      (installedAppText(text).match(/com\.argent\.runner\.t[a-z0-9]+/gi) ?? []).map((id) =>
        id.toLowerCase()
      )
    ),
  ];
  const leftover = runners.find((id) => id !== own);
  const leftoverHint = !leftover
    ? ""
    : own
      ? `${leftover} looks like a leftover Argent runner from a different team; you can delete it. `
      : `${leftover} is an installed Argent runner; delete it if no Argent setup on this Mac still uses it. `;
  return (
    `The iPhone's free developer profile has no slot for ${options.subject}. ` +
    "Remove an app you choose or use a paid team. Argent did not remove another app. " +
    leftoverHint +
    (options.logPath ? `Log: ${options.logPath}` : "")
  ).trim();
}

/**
 * The full text of a devicectl failure. The error message holds only the first
 * stderr line; the rest, such as the bundle IDs of the free-profile cap, is in
 * the stderr of the underlying execFile error.
 */
export function deviceErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = (error as { cause?: { stderr?: unknown } } | null)?.cause?.stderr;
  return typeof stderr === "string" && stderr ? `${message}\n${stderr}` : message;
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

/**
 * Thrown by {@link runLogged} when the command exits with a non-zero code or is
 * killed by a signal. `code` and `signal` match the fields of an execFile error.
 */
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

/**
 * True when a failed runLogged or execFile command crashed, not when it timed
 * out, was cancelled or exited with an ordinary error code.
 */
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

export const XCTRACE_EXPORT_ATTEMPTS = 3;

/**
 * Runs an `xctrace export` again when xctrace crashes. Xcode 26.4.1 xctrace
 * intermittently segfaults while it loads a valid trace, and a later attempt
 * on the same trace succeeds. Use it for exports only, never for a recording.
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
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
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
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
    await new Promise<void>((resolve) => log.end(resolve));
  }
}

async function smallCommand(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 60_000
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
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
      if (
        !/unlock|locked|trust|developer mode|tunnel is still connecting/i.test(message) ||
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
    throw new Error(
      `iPhone ${selected.udid} is not connected by USB cable (transport: ${selected.transportType ?? "none"}). ` +
        "Launch measurement runs over the cable; connect it and retry."
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
    throw new Error(
      `Connected iPhones: ${physical.map((d) => d.udid).join(", ")}. Pass device_id to select one.`
    );
  }
  if (!request.allowSimulator) {
    throw new Error(
      "No selected connected iPhone is available. Connect and unlock one, pass device_id, or explicitly set allow_simulator. " +
        "Simulator launch timings reflect Mac hardware rather than a physical iPhone."
    );
  }
  const simulators = (await listIosSimulators()).filter(
    (device) => device.state === "Booted" && device.runtimeKind !== "tv"
  );
  const simulator = request.deviceId
    ? simulators.find((device) => device.udid === request.deviceId)
    : simulators.length === 1
      ? simulators[0]
      : undefined;
  if (!simulator) {
    throw new Error("Boot a single iOS simulator or select one with device_id.");
  }
  return {
    id: simulator.udid,
    name: simulator.name,
    simulator: true,
    deviceSet: simulator.deviceSet ?? null,
    destination: `platform=iOS Simulator,id=${simulator.udid}`,
  };
}

async function findContainer(root: string, explicit?: string): Promise<string> {
  if (explicit) {
    const candidate = path.resolve(root, explicit);
    if (!candidate.startsWith(`${root}${path.sep}`))
      throw new Error("xcode_container must be inside workspace_path.");
    if (!fs.existsSync(candidate)) throw new Error(`Xcode container does not exist: ${candidate}`);
    return candidate;
  }
  const candidates: string[] = [];
  for (const directory of [root, path.join(root, "ios")]) {
    const entries = await fsp.readdir(directory).catch(() => []);
    for (const entry of entries) {
      if (entry.endsWith(".xcworkspace") || entry.endsWith(".xcodeproj")) {
        candidates.push(path.join(directory, entry));
      }
    }
  }
  const workspaces = candidates.filter((entry) => entry.endsWith(".xcworkspace"));
  const preferred = workspaces.length > 0 ? workspaces : candidates;
  if (preferred.length !== 1) {
    throw new Error(
      `Expected one Xcode workspace or project, found ${preferred.length}. Pass xcode_container. ` +
        preferred.join(", ")
    );
  }
  return preferred[0]!;
}

function containerArgs(container: string): string[] {
  return [container.endsWith(".xcworkspace") ? "-workspace" : "-project", container];
}

async function selectScheme(
  container: string,
  root: string,
  requested?: string,
  signal?: AbortSignal
): Promise<string> {
  const json = JSON.parse(
    await smallCommand("xcodebuild", ["-list", "-json", ...containerArgs(container)], root, signal)
  ) as {
    workspace?: { schemes?: string[] };
    project?: { schemes?: string[] };
  };
  const schemes = json.workspace?.schemes ?? json.project?.schemes ?? [];
  if (requested) {
    if (!schemes.includes(requested))
      throw new Error(`Scheme ${requested} not found in ${container}.`);
    return requested;
  }
  const podSchemes = await podSchemeNames(container);
  const picked = pickScheme(schemes, container, podSchemes);
  if (picked) return picked;
  const own = schemes.filter((scheme) => !podSchemes.has(scheme));
  const shown = own.slice(0, MAX_LISTED_SCHEMES).join(", ");
  const more =
    own.length > MAX_LISTED_SCHEMES ? ` and ${own.length - MAX_LISTED_SCHEMES} more` : "";
  throw new Error(`Select a scheme explicitly. Available schemes: ${shown}${more}`);
}

// Keeps the error short; the full list is one `xcodebuild -list` away.
const MAX_LISTED_SCHEMES = 15;

/** Schemes CocoaPods writes for each pod; `xcodebuild -list` mixes them into the workspace's. */
async function podSchemeNames(container: string): Promise<Set<string>> {
  const pods = path.join(path.dirname(container), "Pods", "Pods.xcodeproj");
  const directories = [path.join(pods, "xcshareddata", "xcschemes")];
  for (const user of await fsp.readdir(path.join(pods, "xcuserdata")).catch(() => [])) {
    directories.push(path.join(pods, "xcuserdata", user, "xcschemes"));
  }
  const names = new Set<string>();
  for (const directory of directories) {
    for (const entry of await fsp.readdir(directory).catch(() => [])) {
      if (entry.endsWith(".xcscheme")) names.add(entry.slice(0, -".xcscheme".length));
    }
  }
  return names;
}

/**
 * The only scheme, else the only non-pod scheme, else the one named after the
 * workspace or project (React Native, Expo and Flutter all name it so).
 */
export function pickScheme(
  schemes: string[],
  container: string,
  podSchemes: ReadonlySet<string>
): string | null {
  if (schemes.length === 1) return schemes[0]!;
  const own = schemes.filter((scheme) => !podSchemes.has(scheme));
  if (own.length === 1) return own[0]!;
  const named = path.basename(container).replace(/\.(xcworkspace|xcodeproj)$/, "");
  return own.includes(named) ? named : null;
}

interface XcodeSettings {
  target: string;
  buildSettings: Record<string, string>;
}

export function showBuildSettingsArgs(
  container: string,
  scheme: string,
  configuration: string,
  destination: string,
  derivedDataPath: string
): string[] {
  return [
    "-showBuildSettings",
    "-json",
    ...containerArgs(container),
    "-scheme",
    scheme,
    "-configuration",
    configuration,
    "-destination",
    destination,
    "-derivedDataPath",
    derivedDataPath,
  ];
}

const IOS_PLATFORMS = new Set(["iphoneos", "iphonesimulator"]);

/**
 * The iOS app targets of a scheme. Embedded watchOS apps and App Clips also
 * have the `.app` extension, so match the plain application product type on an
 * iOS platform; fall back to any `.app` for project types this does not know.
 */
export function iosAppTargets(settings: XcodeSettings[]): XcodeSettings[] {
  const apps = settings.filter((entry) => entry.buildSettings.WRAPPER_EXTENSION === "app");
  const iosApps = apps.filter(
    ({ buildSettings }) =>
      buildSettings.PRODUCT_TYPE === "com.apple.product-type.application" &&
      IOS_PLATFORMS.has(buildSettings.PLATFORM_NAME ?? "")
  );
  return iosApps.length > 0 ? iosApps : apps;
}

export function assertResolvedConfiguration(
  app: Record<string, string>,
  configuration: string
): void {
  if (app.CONFIGURATION !== configuration) {
    throw new Error(`Xcode did not resolve the app to ${configuration}.`);
  }
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

// A build made by another Xcode must not be reused, so the version is in the key.
export function appBuildKey(
  container: string,
  scheme: string,
  destination: string,
  configuration: string,
  xcodeVersionText: string
): string {
  return createHash("sha256")
    .update([container, scheme, destination, configuration, xcodeVersionText].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

async function appSettings(
  root: string,
  container: string,
  scheme: string,
  configuration: string,
  destination: string,
  derivedDataPath: string,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const args = showBuildSettingsArgs(
    container,
    scheme,
    configuration,
    destination,
    derivedDataPath
  );
  const settings = JSON.parse(
    await smallCommand("xcodebuild", args, root, signal)
  ) as XcodeSettings[];
  const apps = iosAppTargets(settings);
  if (apps.length !== 1) {
    throw new Error(
      `Scheme ${scheme} resolves to ${apps.length} app targets; select an unambiguous app scheme.`
    );
  }
  const app = apps[0]!.buildSettings;
  assertResolvedConfiguration(app, configuration);
  if (
    !app.PRODUCT_BUNDLE_IDENTIFIER ||
    !app.TARGET_BUILD_DIR ||
    !app.FULL_PRODUCT_NAME ||
    !app.EXECUTABLE_NAME
  ) {
    throw new Error("Xcode did not provide app bundle ID or build product path.");
  }
  return app;
}

export function appBuildArgs(
  container: string,
  scheme: string,
  configuration: string,
  destination: string,
  derivedDataPath: string,
  extra: string[] = []
): string[] {
  return [
    "build",
    ...containerArgs(container),
    "-scheme",
    scheme,
    "-configuration",
    configuration,
    "-destination",
    destination,
    "-derivedDataPath",
    derivedDataPath,
    "-allowProvisioningUpdates",
    "-allowProvisioningDeviceRegistration",
    ...extra,
  ];
}

/**
 * Team for an app project that sets none: ARGENT_IOS_TEAM_ID, else the newest
 * team in this Mac's keychain. Null leaves signing to xcodebuild, whose failure
 * carries a signing hint.
 */
async function detectAppTeam(): Promise<string | null> {
  const envTeamId = process.env.ARGENT_IOS_TEAM_ID?.trim();
  if (envTeamId) return envTeamId;
  return (await detectSigningTeams())[0]?.teamId ?? null;
}

export async function prepareLaunch(
  request: LaunchRequest,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<LaunchContext> {
  signal?.throwIfAborted();
  if (process.platform !== "darwin")
    throw new Error("iOS launch measurement requires macOS and Xcode.");
  const root = path.resolve(request.workspacePath);
  if (!(await fsp.stat(root).catch(() => null))?.isDirectory()) {
    throw new Error(`workspace_path is not a directory: ${root}`);
  }
  const device = await selectDevice(request, onProgress, signal);
  await request.checkDevice?.(device);
  const container = await findContainer(root, request.xcodeContainer);
  const scheme = await selectScheme(container, root, request.scheme, signal);
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const runDir = path.join(root, ".argent", "traces", timestamp);
  await fsp.mkdir(path.dirname(runDir), { recursive: true });
  await fsp.mkdir(runDir);
  const configuration = request.configuration ?? "Release";
  const buildKey = appBuildKey(
    container,
    scheme,
    device.destination,
    configuration,
    await xcodeVersion()
  );
  const derivedDataPath = launchBuildCacheDir("app", buildKey);
  const settings = await appSettings(
    root,
    container,
    scheme,
    configuration,
    device.destination,
    derivedDataPath,
    signal
  );
  const configuredTeamId = settings.DEVELOPMENT_TEAM?.trim() || null;
  const manuallySigned = settings.CODE_SIGN_STYLE === "Manual";
  const detectedTeam =
    device.simulator || configuredTeamId || manuallySigned ? null : await detectAppTeam();
  if (detectedTeam) onProgress?.(`Signing the app with team ${detectedTeam}`);
  const appTeamId = configuredTeamId ?? detectedTeam;
  const args = appBuildArgs(container, scheme, configuration, device.destination, derivedDataPath, [
    ...(device.simulator
      ? ["CODE_SIGNING_ALLOWED=NO"]
      : !manuallySigned && appTeamId
        ? [`DEVELOPMENT_TEAM=${appTeamId}`]
        : []),
  ]);
  try {
    await runLogged("xcodebuild", args, {
      cwd: root,
      logPath: path.join(runDir, "app-build.log"),
      signal,
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      `${configuration} build failed for the app's original bundle ID ${settings.PRODUCT_BUNDLE_IDENTIFIER}. ` +
        `If signing failed, set up this exact bundle ID for your Apple team in Xcode and retry. ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error }
    );
  }
  const appPath = path.join(settings.TARGET_BUILD_DIR!, settings.FULL_PRODUCT_NAME!);
  if (!(await fsp.stat(appPath).catch(() => null))?.isDirectory()) {
    throw new Error(`${configuration} build succeeded but the app was not found at ${appPath}.`);
  }
  if (device.simulator) {
    // A simulator that is still booting fails install and launch.
    await smallCommand(
      "xcrun",
      [...simctlPrefix(device.deviceSet), "bootstatus", device.id, "-b"],
      root,
      signal,
      BOOTSTATUS_TIMEOUT_MS
    );
    await smallCommand(
      "xcrun",
      [...simctlPrefix(device.deviceSet), "install", device.id, appPath],
      root,
      signal
    );
    await smallCommand(
      "xcrun",
      [...simctlPrefix(device.deviceSet), "launch", device.id, settings.PRODUCT_BUNDLE_IDENTIFIER!],
      root,
      signal
    );
  } else {
    try {
      await waitForDeviceAction(() => installApp(device.id, appPath), onProgress, signal);
    } catch (error) {
      const text = deviceErrorText(error);
      // Only the runner's own ID tells a leftover runner from the current one.
      const runner = isFreeProfileLimit(text)
        ? await resolveRunnerSigningConfig().catch(() => null)
        : null;
      const friendly = freeProfileLimitMessage(text, {
        subject: `the app ${settings.PRODUCT_BUNDLE_IDENTIFIER}`,
        ownBundleIdPrefix: runner?.appBundleId,
      });
      if (friendly) throw new Error(friendly, { cause: error });
      throw error;
    }
    await waitForDeviceAction(
      () => launchApp(device.id, settings.PRODUCT_BUNDLE_IDENTIFIER!, { terminateExisting: true }),
      onProgress,
      signal
    );
  }
  const context: LaunchContext = {
    runDir,
    deviceId: device.id,
    deviceName: device.name,
    simulator: device.simulator,
    simulatorDeviceSet: device.deviceSet,
    destination: device.destination,
    bundleId: settings.PRODUCT_BUNDLE_IDENTIFIER!,
    executableName: settings.EXECUTABLE_NAME!,
    appPath,
    scheme,
    container,
    teamId: appTeamId ?? null,
    warning: device.simulator
      ? "Simulator timings reflect Mac hardware; validate performance on a physical iPhone."
      : null,
  };
  await fsp.writeFile(
    path.join(runDir, "manifest.json"),
    JSON.stringify(
      {
        ...context,
        configuration,
        launchPreparation: "prelaunched",
        preparedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  return context;
}

/** Terminate a prelaunched app so the next activation starts a new, recently used process. */
export async function terminateForWarmLaunch(
  context: LaunchContext,
  signal?: AbortSignal
): Promise<void> {
  if (context.simulator) {
    await smallCommand(
      "xcrun",
      [
        ...simctlPrefix(context.simulatorDeviceSet),
        "terminate",
        context.deviceId,
        context.bundleId,
      ],
      path.dirname(context.runDir),
      signal
    );
    return;
  }
  const { stdout } = await execFileAsync(
    "xcrun",
    [
      "devicectl",
      "device",
      "info",
      "processes",
      "--device",
      context.deviceId,
      "--search",
      context.executableName,
      "--json-output",
      "-",
    ],
    { timeout: 30_000, maxBuffer: 1024 * 1024, signal }
  );
  const jsonStart = stdout.indexOf("{");
  const payload = JSON.parse(stdout.slice(jsonStart)) as {
    result?: { runningProcesses?: Array<{ executable?: string; processIdentifier?: number }> };
  };
  const suffix = `/${path.basename(context.appPath)}/${context.executableName}`;
  const process = payload.result?.runningProcesses?.find((entry) =>
    entry.executable?.endsWith(suffix)
  );
  if (!process?.processIdentifier) {
    throw new Error(
      `Could not verify that ${context.bundleId} was running before warm-launch capture.`
    );
  }
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
    path.dirname(context.runDir),
    signal
  );
}

// Bounds the cleanup, whose device path alone could otherwise take 90 s.
const TERMINATE_LAUNCHED_APP_TIMEOUT_MS = 15_000;

/**
 * Best-effort stop of the launched app after a failed, stalled or cancelled
 * recording, so it is not left suspended. Errors are ignored. It ignores the
 * tool's abort signal and gives up after 15 s.
 */
export async function terminateLaunchedApp(context: LaunchContext): Promise<void> {
  await terminateForWarmLaunch(
    context,
    AbortSignal.timeout(TERMINATE_LAUNCHED_APP_TIMEOUT_MS)
  ).catch(() => undefined);
}
