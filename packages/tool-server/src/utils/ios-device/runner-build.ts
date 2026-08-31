import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, withFailureSignal } from "@argent/registry";
import { withKeyedLock } from "../keyed-lock";
import { announceDetectedSigningTeam, detectSigningTeams } from "./team-detect";
import {
  pidIsAlive,
  pollPidsUntilGone,
  scheduleGroupSigkill,
  signalGroupThenPid,
} from "../process-kill";
import { PS_BIN } from "../vega-process";

/**
 * Build and launch the on-device XCUITest runner.
 */

const execFileAsync = promisify(execFile);

/**
 * Automatic signing under a single Apple team.
 * Bundle ids are derived from the team id.
 */
export interface RunnerSigningConfig {
  teamId: string;
  appBundleId: string;
  testBundleId: string;
}

function signingTeamError(message: string): Error {
  return withFailureSignal(new Error(message), {
    error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
    failure_stage: "ios_device_signing_team",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

function signingConfigForTeam(teamId: string): RunnerSigningConfig {
  // The leading "t" keeps the derived segment from starting with a digit.
  const appBundleId = `com.argent.runner.t${teamId.toLowerCase()}`;

  return {
    teamId,
    appBundleId,
    testBundleId: `${appBundleId}.uitests`,
  };
}

/**
 * Resolve signing: `ARGENT_IOS_TEAM_ID` when set, otherwise the team detected
 * from this Mac's keychain (memoized; several teams auto-pick the newest).
 * Throws only when neither yields a team, and that error prompts an Xcode
 * sign-in: with no certificate in the keychain, naming a team id could not
 * make the build signable anyway.
 */
export async function resolveRunnerSigningConfig(): Promise<RunnerSigningConfig> {
  const envTeamId = process.env.ARGENT_IOS_TEAM_ID?.trim();

  if (envTeamId) {
    return signingConfigForTeam(envTeamId);
  }

  const teams = await detectSigningTeams();

  if (teams.length === 0) {
    throw signingTeamError(
      "No Apple Development signing certificate was found in this Mac's keychain, " +
        "so the on-device runner cannot be signed. Open Xcode > Settings > Accounts " +
        "and sign in with your Apple ID; then, still in that pane, choose Manage " +
        "Certificates and click + > Apple Development. Retry once the certificate " +
        "exists; argent detects the team automatically."
    );
  }

  announceDetectedSigningTeam(teams);

  return signingConfigForTeam(teams[0]!.teamId);
}

const PROJECT_SUFFIX = "ios-device-runner/ArgentRunner/ArgentRunner.xcodeproj";

/**
 * Locate the runner Xcode project.
 */
export function resolveRunnerProjectPath(): string {
  // Packaged tool-server copies the project next to the bundle.
  // Outside the bundle, set ARGENT_IOS_RUNNER_PROJECT.
  const override = process.env.ARGENT_IOS_RUNNER_PROJECT;

  if (override) {
    return override;
  }

  const candidate = path.resolve(__dirname, PROJECT_SUFFIX);

  if (fs.existsSync(candidate)) {
    return candidate;
  }

  throw withFailureSignal(
    new Error(
      `Could not locate the ios-device-runner Xcode project (looked at ` +
        `${candidate}). Set ARGENT_IOS_RUNNER_PROJECT to the ` +
        `ArgentRunner.xcodeproj path.`
    ),
    {
      error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
      failure_stage: "ios_device_runner_project_resolve",
      failure_area: "tool_server",
      error_kind: "not_found",
    }
  );
}

const SOURCE_EXTENSIONS = new Set([
  ".swift",
  ".m",
  ".h",
  ".pbxproj",
  ".plist",
  ".entitlements",
  ".xctestplan",
  ".xcscheme",
]);

/** Hash runner sources for the cache key. */
async function fingerprintRunnerSources(projectPath: string): Promise<string> {
  const root = path.dirname(projectPath);
  const hash = createHash("sha256");

  // Hashing is order-sensitive. Sort files for a stable digest.
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Local Xcode noise. Not part of the source fingerprint.
        if (["xcuserdata", "DerivedData"].includes(entry.name)) {
          continue;
        }

        await walk(full);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        const content = await fsp.readFile(full);

        // Skip mtime. Pack and npm install restamp files and would bust the cache.
        hash.update(`${path.relative(root, full)}|${content.length}\n`);
        hash.update(content);
      }
    }
  };

  await walk(root);

  return hash.digest("hex");
}

async function xcodeVersionFingerprint(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("xcodebuild", ["-version"], { timeout: 20_000 });
    return stdout.trim().replace(/\n/g, " ");
  } catch {
    return "unknown-xcode";
  }
}

export interface RunnerArtifact {
  xctestrunPath: string;
  derivedDataPath: string;
  fromCache: boolean;
}

function derivedDir(): string {
  return path.join(os.homedir(), ".argent", "ios-device-runner", "derived");
}

function logsRoot(): string {
  return path.join(os.homedir(), ".argent", "ios-device-runner", "logs");
}

function resultsRoot(): string {
  return path.join(os.homedir(), ".argent", "ios-device-runner", "results");
}

/**
 * Stamp written after a successful build. Cache hits require a matching stamp.
 */
const CACHE_KEY_FILE = ".argent-cache-key";

/**
 * Find the base device .xctestrun under a derived-data dir.
 */
function findBaseXctestrun(derivedDataPath: string): string | null {
  const productsDir = path.join(derivedDataPath, "Build", "Products");

  if (!fs.existsSync(productsDir)) {
    return null;
  }

  const candidates = fs.readdirSync(productsDir).filter((name) => {
    return name.endsWith(".xctestrun") && name.includes("iphoneos");
  });

  if (candidates.length === 0) {
    return null;
  }

  return path.join(productsDir, candidates.sort()[0]!);
}

/** The xcodebuild lines worth reading out of a failed build. */
export function xcodebuildFailureSummary(output: string): string {
  // Prefer unique `error:` lines. xcodebuild repeats each error per target.
  // Fall back to the tail when no error line exists.
  const lines = output.split("\n");
  const errors = [...new Set(lines.filter((line) => /(^|\s)error: /.test(line)))];

  if (errors.length > 0) {
    return errors
      .slice(0, 8)
      .map((line) => line.trim())
      .join("\n");
  }

  return lines.slice(-15).join("\n").trim();
}

/** Map xcodebuild output to a signing-recovery hint, or null. */
export function resolveSigningHint(output: string): string | null {
  const lower = output.toLowerCase();

  // Check this before the provisioning arm. This message also mentions
  // "provisioning profile" and the Xcode-account hint would be wrong.
  if (lower.includes("team has no devices")) {
    return (
      "This team has no registered devices yet. Keep the phone connected and retry: " +
      "building against the connected device registers it with the team."
    );
  }

  if (
    lower.includes("failed registering bundle identifier") ||
    // Bare "is not available" also appears in destination and OS failures.
    // Require identifier or registered context as well.
    (lower.includes("is not available") &&
      (lower.includes("identifier") || lower.includes("registered")))
  ) {
    // The derived bundle id is unique per team. This is a free-team app-id cap.
    return (
      "Registering the runner bundle id failed. On a free Personal Team, Apple limits " +
      "new app ids; wait a few days and retry, or sign under a paid team."
    );
  }

  // Check this before the provisioning arm too: errSecInternalComponent is a
  // codesign-stage verdict (the signing key's keychain partition list blocks
  // non-Xcode callers), so provisioning already succeeded and any
  // "provisioning profile" mention further up the log is context, not the
  // failure. The two arms above never co-occur with it.
  if (lower.includes("errsecinternalcomponent")) {
    return (
      "The signing key's access control needs stamping. Run: " +
      "security set-key-partition-list -S apple-tool:,apple:,codesign: " +
      "-s ~/Library/Keychains/login.keychain-db (it asks for your login password), " +
      "then retry."
    );
  }

  if (lower.includes("no profiles for") || lower.includes("provisioning profile")) {
    return (
      "Provisioning failed. Check that this team's Apple ID is signed into Xcode " +
      "(Xcode > Settings > Accounts), then retry."
    );
  }

  return null;
}

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
// A full xcodebuild log; the failure summary needs the whole output to find error lines.
const BUILD_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Static xcodebuild arguments for a runner build.
 * Excludes the per-run destination and derived-data path.
 */
export function runnerBuildStaticArgs(projectPath: string, config: RunnerSigningConfig): string[] {
  return [
    "build-for-testing",
    "-project",
    projectPath,
    "-scheme",
    "ArgentRunner",
    "-parallel-testing-enabled",
    "NO",
    "-maximum-concurrent-test-device-destinations",
    "1",
    "-allowProvisioningUpdates",
    "-allowProvisioningDeviceRegistration",
    "COMPILER_INDEX_STORE_ENABLE=NO",
    "ENABLE_CODE_COVERAGE=NO",
    "ONLY_ACTIVE_ARCH=YES",
    "ENABLE_PREVIEWS=NO",
    "ENABLE_DEBUG_DYLIB=NO",
    `ARGENT_RUNNER_APP_BUNDLE_ID=${config.appBundleId}`,
    `ARGENT_RUNNER_TEST_BUNDLE_ID=${config.testBundleId}`,
    "CODE_SIGN_STYLE=Automatic",
    `DEVELOPMENT_TEAM=${config.teamId}`,
  ];
}

/**
 * Cache key over sources, toolchain, and static build args.
 */
export function computeRunnerCacheKey(
  sourcesHash: string,
  xcodeVersion: string,
  staticArgs: readonly string[]
): string {
  return createHash("sha256")
    .update([sourcesHash, xcodeVersion, ...staticArgs].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * True when install or launch failed because the profile does not cover the device.
 */
export function isProfileMissingDeviceFailure(logText: string): boolean {
  return (
    logText.includes("0xe8008012") ||
    /doesn't include the currently selected device/i.test(logText) ||
    /provisioning profile cannot be installed on this device/i.test(logText) ||
    /team has no devices/i.test(logText)
  );
}

/**
 * Rebuild the runner against a concrete device. Automatic signing then includes that device.
 */
export async function rebuildRunnerArtifactForDevice(
  udid: string,
  config: RunnerSigningConfig
): Promise<RunnerArtifact> {
  return ensureRunnerArtifact(config, { destinationUdid: udid, force: true });
}

const runnerBuildLocks = new Map<string, Promise<unknown>>();

/** Serialize runner builds. Only one build runs at a time. */
async function withRunnerBuildLock<T>(fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(runnerBuildLocks, "runner-build", fn);
}

/**
 * Ensure the runner artifact matches the current sources, toolchain, and signing config.
 *
 * @param opts.force skip the cache and rebuild.
 * @param opts.build test seam. Defaults to the real xcodebuild.
 */
export async function ensureRunnerArtifact(
  config: RunnerSigningConfig,
  opts: {
    destinationUdid?: string;
    force?: boolean;
    build?: typeof buildRunnerArtifact;
  } = {}
): Promise<RunnerArtifact> {
  const projectPath = resolveRunnerProjectPath();
  const [sourcesHash, xcodeVersion] = await Promise.all([
    fingerprintRunnerSources(projectPath),
    xcodeVersionFingerprint(),
  ]);
  const staticArgs = runnerBuildStaticArgs(projectPath, config);
  const cacheKey = computeRunnerCacheKey(sourcesHash, xcodeVersion, staticArgs);
  const derivedDataPath = derivedDir();
  const build = opts.build ?? buildRunnerArtifact;

  return withRunnerBuildLock(async (): Promise<RunnerArtifact> => {
    const stampPath = path.join(derivedDataPath, CACHE_KEY_FILE);
    const stamped = await fsp.readFile(stampPath, "utf8").catch(() => null);

    if (!opts.force && stamped === cacheKey) {
      const cached = findBaseXctestrun(derivedDataPath);

      if (cached) {
        return {
          xctestrunPath: cached,
          derivedDataPath,
          fromCache: true,
        };
      }
    }

    if (stamped !== cacheKey) {
      // No stamp or a mismatched stamp means rebuild. Do not trust leftover files.
      await fsp.rm(derivedDataPath, { recursive: true, force: true });
    }

    const built = await build(derivedDataPath, staticArgs, opts.destinationUdid);
    await fsp.writeFile(stampPath, cacheKey);

    return built;
  });
}

/**
 * Build the runner artifact.
 */
async function buildRunnerArtifact(
  derivedDataPath: string,
  staticArgs: readonly string[],
  destinationUdid: string | undefined
): Promise<RunnerArtifact> {
  await fsp.mkdir(derivedDataPath, { recursive: true });

  const args = [
    ...staticArgs,
    "-destination",
    // A concrete UDID lets automatic signing register that device on the profile.
    destinationUdid ? `platform=iOS,id=${destinationUdid}` : "generic/platform=iOS",
    "-derivedDataPath",
    derivedDataPath,
  ];

  try {
    await execFileAsync("xcodebuild", args, {
      timeout: BUILD_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: BUILD_MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout ?? "", e.stderr ?? "", e.message ?? ""].join("\n");
    const hint = resolveSigningHint(output);

    throw new Error(
      `Building the iOS device runner failed.${hint ? ` ${hint}` : ""}\n\n` +
        `xcodebuild reported:\n${xcodebuildFailureSummary(output)}`,
      { cause: error }
    );
  }

  const built = findBaseXctestrun(derivedDataPath);

  if (!built) {
    throw new Error(
      `xcodebuild reported success but no iphoneos .xctestrun was found under ${derivedDataPath}/Build/Products.`
    );
  }

  return {
    xctestrunPath: built,
    derivedDataPath,
    fromCache: false,
  };
}

/**
 * Thrown when an `.xctestrun` does not parse as a plist.
 */
export class XctestrunFormatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "XctestrunFormatError";
  }
}

/**
 * Lint a cached .xctestrun as a plist.
 */
export async function assertXctestrunParses(xctestrunPath: string): Promise<void> {
  try {
    await execFileAsync("plutil", ["-lint", xctestrunPath], { timeout: 20_000 });
  } catch (error) {
    throw new XctestrunFormatError(
      `xctestrun at ${xctestrunPath} could not be parsed as a plist: ` +
        `${(error as Error).message}. Delete ~/.argent/ios-device-runner and retry to ` +
        `force a rebuild.`,
      { cause: error }
    );
  }
}

export interface LaunchedRunner {
  child: ChildProcess;
  logPath: string;
  /** This device's one crash bundle. Overwritten on every launch. */
  resultBundlePath: string;
}

/**
 * Launch the runner on the device with `xcodebuild test-without-building`.
 */
export async function launchRunner(opts: {
  udid: string;
  xctestrunPath: string;
  derivedDataPath: string;
  port: number;
}): Promise<LaunchedRunner> {
  const logDir = logsRoot();
  const resultsDir = resultsRoot();

  await Promise.all([
    fsp.mkdir(logDir, { recursive: true }),
    fsp.mkdir(resultsDir, { recursive: true }),
  ]);

  const deviceTag = opts.udid.slice(0, 8);
  // One log and one crash bundle per device. Each launch overwrites them.
  const logPath = path.join(logDir, `runner-${deviceTag}.log`);
  const resultBundlePath = path.join(resultsDir, `argent-${deviceTag}.xcresult`);

  // xcodebuild refuses to write onto an existing result bundle.
  await fsp.rm(resultBundlePath, { recursive: true, force: true });

  const logFd = fs.openSync(logPath, "w");

  const child = spawn(
    "xcodebuild",
    [
      "test-without-building",
      "-only-testing",
      "ArgentRunnerUITests/ArgentRunnerSession/testServeCommands",
      "-parallel-testing-enabled",
      "NO",
      "-test-timeouts-enabled",
      "NO",
      "-collect-test-diagnostics",
      "never",
      "-maximum-concurrent-test-device-destinations",
      "1",
      "-destination-timeout",
      "20",
      "-resultBundlePath",
      resultBundlePath,
      "-xctestrun",
      opts.xctestrunPath,
      "-derivedDataPath",
      opts.derivedDataPath,
      "-destination",
      `platform=iOS,id=${opts.udid}`,
    ],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      // xcodebuild forwards TEST_RUNNER_* into the test process with the prefix stripped.
      env: { ...process.env, TEST_RUNNER_ARGENT_RUNNER_PORT: String(opts.port) },
    }
  );

  // Detached and unref'd. The runner outlives this call.
  child.unref();
  fs.closeSync(logFd);

  try {
    // Spawn failure must reject here.
    await once(child, "spawn");
  } catch (error) {
    throw new FailureError(
      "xcodebuild could not be started. Check that Xcode is installed and on PATH.",
      {
        error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
        failure_stage: "ios_device_runner_spawn",
        failure_area: "tool_server",
        error_kind: "subprocess",
      },
      { cause: error as Error }
    );
  }

  // A late "error" event must never become an uncaught exception.
  child.on("error", () => {});

  return {
    child,
    logPath,
    resultBundlePath,
  };
}

/**
 * Kill orphaned runner xcodebuild processes for a device.
 *
 * @param opts.listProcesses snapshot of `ps -ax -o pid=,ppid=,command=`. Defaults to running it.
 */
export async function killStaleRunnersForDevice(
  udid: string,
  opts: {
    listProcesses?: () => Promise<string>;
    timeoutMs?: number;
    pollIntervalMs?: number;
    isAlive?: (pid: number) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<number> {
  const listProcesses = opts.listProcesses ?? listProcessTable;
  const isAlive = opts.isAlive ?? pidIsAlive;
  const kill = opts.kill ?? process.kill.bind(process);

  let stdout: string;

  try {
    stdout = await listProcesses();
  } catch {
    // A missing process table is not a reason to abort.
    return 0;
  }

  const signaled: number[] = [];

  for (const line of stdout.split("\n")) {
    // Match only our processes: test-without-building, this UDID, and the cache root.
    if (
      !line.includes("test-without-building") ||
      !line.includes(`platform=iOS,id=${udid}`) ||
      !line.includes(path.join(".argent", "ios-device-runner"))
    ) {
      continue;
    }

    const [pidField, ppidField] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidField ?? "", 10);
    const ppid = Number.parseInt(ppidField ?? "", 10);

    // An unparseable line is spared. When ownership is unknown, not killing is safer.
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid === process.pid) {
      continue;
    }

    // A live parent means a peer tool-server owns this runner. Leave it alone.
    if (ppid !== 1 && isAlive(ppid)) {
      continue;
    }

    // SIGTERM did not land. Do not wait on this pid.
    if (!signalGroupThenPid(kill, pid, "SIGTERM")) {
      continue;
    }

    signaled.push(pid);
  }

  if (signaled.length > 0) {
    await waitForPidsToExit(signaled, opts);
  }

  return signaled.length;
}

/**
 * Process-table snapshot argv. `PS_BIN` keeps `ps` findable when the tool-server is GUI-launched.
 */
export const PROCESS_TABLE_ARGV = [PS_BIN, "-ax", "-o", "pid=,ppid=,command="] as const;

// A busy Mac's full process table with command lines.
const PROCESS_TABLE_MAX_BYTES = 16 * 1024 * 1024;

/** Real process-table snapshot behind `killStaleRunnersForDevice`'s seam. */
async function listProcessTable(): Promise<string> {
  const [bin, ...args] = PROCESS_TABLE_ARGV;

  const { stdout } = await execFileAsync(bin, args, {
    maxBuffer: PROCESS_TABLE_MAX_BYTES,
  });

  return stdout;
}

/** SIGTERM-to-SIGKILL escalation delay. Mirrors killRunnerProcess's 5s. */
const STALE_EXIT_TIMEOUT_MS = 5_000;
const STALE_EXIT_POLL_INTERVAL_MS = 100;

/**
 * Wait for signaled pids to exit, then SIGKILL holdouts.
 */
export async function waitForPidsToExit(
  pids: readonly number[],
  opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    isAlive?: (pid: number) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<number[]> {
  const kill = opts.kill ?? process.kill.bind(process);

  const remaining = await pollPidsUntilGone(pids, {
    timeoutMs: opts.timeoutMs ?? STALE_EXIT_TIMEOUT_MS,
    pollIntervalMs: opts.pollIntervalMs ?? STALE_EXIT_POLL_INTERVAL_MS,
    isAlive: opts.isAlive,
    sleep: opts.sleep,
  });

  for (const pid of remaining) {
    // Swallowed failure: the pid exited between the last poll and SIGKILL.
    signalGroupThenPid(kill, pid, "SIGKILL");
  }

  return remaining;
}

/** Kill a runner's whole process group (xcodebuild spawns helpers). */
export function killRunnerProcess(child: ChildProcess): void {
  const pid = child.pid;

  if (!pid) {
    return;
  }

  signalGroupThenPid(process.kill.bind(process), pid, "SIGTERM");
  // Unconditional after the grace period. This path accepts the recycled-pgid window.
  scheduleGroupSigkill(pid, 5_000, { gateOnGroupLiveness: false });
}
