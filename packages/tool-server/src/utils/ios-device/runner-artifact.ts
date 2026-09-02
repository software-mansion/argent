import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, withFailureSignal } from "@argent/registry";
import { withKeyedLock } from "../keyed-lock";
import { resolveSigningHint, type RunnerSigningConfig } from "./runner-signing";

/**
 * Build the on-device runner and cache the build under one stamped dir.
 */

const execFileAsync = promisify(execFile);

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
 * True when a launch log reports an expired provisioning profile. Free-team
 * profiles last about seven days. The fix is the same in-place re-sign the
 * device-registration retry uses.
 *
 * The hex codes are installd's, surfaced as `0x... (text)` in the launch log and
 * verified against MobileDevice.framework's error table (AMDCopyErrorText):
 * 0xe8008011 "This provisioning profile has expired." and 0xe8008015 "A valid
 * provisioning profile for this executable was not found.", which an expired
 * profile also produces once it no longer matches. The wording arm covers
 * both of those and Xcode's host-side "Provisioning profile "X" expired on
 * Y." and "Profile expired on Y.".
 */
export function isProfileExpiredFailure(logText: string): boolean {
  return (
    logText.includes("0xe8008011") ||
    logText.includes("0xe8008015") ||
    /\bprofile\b.{0,120}\bexpired\b/i.test(logText)
  );
}

/**
 * A .mobileprovision is a CMS blob whose plist rides along as plain text, so
 * the expiry reads without shelling out to `security cms`.
 */
const EXPIRY_RE = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/;

/** Re-sign when less than this much of the profile's validity is left. */
const PROFILE_RENEWAL_MARGIN_MS = 60 * 60 * 1000;

/**
 * Expiry of the profile embedded in the cached runner, or null when it cannot
 * be read. Null never blocks a cache hit: a probe that fails must not cost a
 * build.
 */
async function readRunnerExpiryDate(derivedDataPath: string): Promise<Date | null> {
  const file = path.join(
    derivedDataPath,
    "Build",
    "Products",
    "Debug-iphoneos",
    "ArgentRunnerUITests-Runner.app",
    "embedded.mobileprovision"
  );

  const text = await fsp.readFile(file, "latin1").catch(() => null);
  const match = text ? EXPIRY_RE.exec(text) : null;
  const date = match ? new Date(match[1]!) : null;

  return date && Number.isFinite(date.getTime()) ? date : null;
}

/** True when the profile expires within the renewal margin, or already has. */
function profileNeedsRenewal(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() - now.getTime() < PROFILE_RENEWAL_MARGIN_MS;
}

const runnerBuildLocks = new Map<string, Promise<unknown>>();

/** Serialize runner builds. Only one build runs at a time. */
async function withRunnerBuildLock<T>(fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(runnerBuildLocks, "runner-build", fn);
}

/**
 * Ensure the runner artifact matches the current sources, toolchain, and signing config,
 * and that its provisioning profile is not about to expire.
 *
 * @param opts.destinationUdid build against this device so automatic signing registers it.
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
      const expiresAt = await readRunnerExpiryDate(derivedDataPath);
      const needsRenew = expiresAt !== null && profileNeedsRenewal(expiresAt, new Date());

      if (cached && !needsRenew) {
        return {
          xctestrunPath: cached,
          derivedDataPath,
          fromCache: true,
        };
      }
    }

    if (stamped !== cacheKey) {
      // No stamp or a mismatched stamp means rebuild. Do not trust leftover files.
      await fsp.rm(derivedDataPath, {
        recursive: true,
        force: true,
      });
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
