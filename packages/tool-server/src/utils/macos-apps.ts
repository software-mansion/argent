import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { isFlagEnabled } from "@argent/configuration-core";
import {
  FAILURE_CODES,
  FailureError,
  type DeviceInfo,
  type FailureCode,
  type FailureKind,
} from "@argent/registry";
import { macosArtifacts } from "@argent/native-devtools-ios";
import {
  InvalidToolInputError,
  MACOS_APPS_FLAG,
  MACOS_APPS_FLAG_OFF_REASON,
  UnsupportedOperationError,
} from "./capability";
import {
  MACOS_APP_ID_PREFIX,
  isMacosBundleId,
  macosAppIdFromBundleId,
  parseMacosAppBundleId,
} from "./device-info";
import { PS_BIN } from "./vega-process";

const execFileAsync = promisify(execFile);

export function isMacosAppsEnabled(): boolean {
  return isFlagEnabled(MACOS_APPS_FLAG);
}

/**
 * For the Mac branches the capability gate does not cover: `boot-device` with
 * `macosAppPath` has no device id for it to read.
 */
export function assertMacosAppsEnabled(toolId: string, device?: DeviceInfo): void {
  if (isMacosAppsEnabled()) return;
  throw new UnsupportedOperationError(
    toolId,
    device ?? { id: MACOS_APP_ID_PREFIX, platform: "macos", kind: "app" },
    MACOS_APPS_FLAG_OFF_REASON
  );
}

export function macosFailure(
  message: string,
  error_code: FailureCode,
  failure_stage: string,
  error_kind: FailureKind,
  cause?: unknown
): FailureError {
  return new FailureError(
    message,
    { error_code, failure_stage, failure_area: "tool_server", error_kind },
    cause instanceof Error ? { cause } : undefined
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * On a Mac the device is the app, so `launch-app` and `restart-app` take the
 * bundle id of the device and nothing else. Returns the bundle id.
 */
export function assertLaunchTargetsDevice(bundleId: string, device: DeviceInfo): string {
  if (parseMacosAppBundleId(device.id) === bundleId) return bundleId;
  throw new InvalidToolInputError(
    `launch names ${bundleId} but the device is ${device.id}; ` +
      `use device ${macosAppIdFromBundleId(bundleId)}.`,
    {
      error_code: FAILURE_CODES.MACOS_APP_BUNDLE_ID_MISMATCH,
      failure_stage: "macos_app_launch_target",
    }
  );
}

/** `~/.argent/macos`: listening sockets, app logs and the staged library. Private to the user (0700). */
function macosArgentDir(): string {
  return path.join(os.homedir(), ".argent", "macos");
}

export function macosAppLogPath(bundleId: string): string {
  return path.join(macosArgentDir(), "logs", `${bundleId}.log`);
}

const BOOTSTRAP_NAME = "libArgentInjectionBootstrap.dylib";
const LIBRARY_NAME = "libNativeDevtoolsMacos.dylib";

/**
 * Copies the bootstrap and the library to `~/.argent/macos/lib/<hash>/`, or to
 * `<hash>-<teamId>/` for a copy the user signs with that team, and returns the
 * copied bootstrap, the value for `--insert-library`.
 *
 * dyld reads the bootstrap as the app, and the app may not read a
 * privacy-protected folder (`~/Desktop`, `~/Documents`, iCloud Drive), where
 * argent can be installed or built; `~/.argent` is not protected. Both files
 * share a directory because the bootstrap loads the library from its own.
 *
 * The directory is named after the files' contents, so a new release gets a
 * new directory and a running app keeps the files it has mapped. A complete
 * directory is never written again: it is built under a temporary name and
 * renamed into place, and an incomplete one is moved aside. The directories
 * of other builds go once no app maps them ({@link removeUnusedLibraries}).
 */
export function stageMacosLibraries(
  bootstrapPath: string,
  libraryPath: string,
  teamId?: string
): string {
  const bootstrap = fs.readFileSync(bootstrapPath);
  const library = fs.readFileSync(libraryPath);
  const hash = createHash("sha256")
    .update(`${bootstrap.length}:`)
    .update(bootstrap)
    .update(`${library.length}:`)
    .update(library)
    .digest("hex")
    .slice(0, 16);
  const name = teamId ? `${hash}-${teamId}` : hash;
  const libRoot = path.join(macosArgentDir(), "lib");
  const target = path.join(libRoot, name);
  const staged = path.join(target, BOOTSTRAP_NAME);
  const isComplete = () => fs.existsSync(staged) && fs.existsSync(path.join(target, LIBRARY_NAME));

  fs.mkdirSync(libRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(macosArgentDir(), 0o700);
  // The time a tool-server last chose the directory, which the removal reads.
  try {
    const now = new Date();
    fs.utimesSync(target, now, now);
  } catch {
    // Not staged yet.
  }
  void removeUnusedLibraries(libRoot, hash);
  if (isComplete()) return staged;
  if (fs.existsSync(target)) {
    fs.renameSync(target, path.join(libRoot, `.damaged-${name}-${process.pid}-${Date.now()}`));
  }

  const temp = fs.mkdtempSync(path.join(libRoot, `.tmp-${name}-`));
  try {
    fs.writeFileSync(path.join(temp, BOOTSTRAP_NAME), bootstrap, { mode: 0o755 });
    fs.writeFileSync(path.join(temp, LIBRARY_NAME), library, { mode: 0o755 });
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    // Another tool-server renamed the same contents into place first.
    const code = (err as NodeJS.ErrnoException).code;
    if ((code === "ENOTEMPTY" || code === "EEXIST") && isComplete()) return staged;
    throw err;
  }
  return staged;
}

const UNUSED_LIBRARY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the staged directories in `libRoot` of builds other than `keep`
 * (another release, another argent install) that no process maps, as `lsof`
 * reports, and that no tool-server chose for a day: a tool-server that has just
 * chosen one may not have started its app yet. Never fails.
 */
export async function removeUnusedLibraries(libRoot: string, keep: string): Promise<void> {
  try {
    const root = fs.realpathSync(libRoot);
    let open: string;
    try {
      ({ stdout: open } = await execFileAsync("lsof", ["-Fn", "+D", root], {
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (err) {
      // `lsof +D` exits 1 whether or not it lists files. Any other failure keeps everything.
      const { code, stdout } = err as { code?: unknown; stdout?: string };
      if (code !== 1) return;
      open = stdout ?? "";
    }
    const used = new Set(
      open
        .split("\n")
        .filter((line) => line.startsWith(`n${root}/`))
        .map((line) => line.slice(root.length + 2).split("/")[0])
    );
    const cutoff = Date.now() - UNUSED_LIBRARY_MS;
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith(keep) || used.has(name)) continue;
      const dir = path.join(root, name);
      const stat = fs.statSync(dir, { throwIfNoEntry: false });
      if (stat && stat.mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // The directory is gone, or a removal failed: the next start tries again.
  }
}

/** The team of a file's code signature, from `codesign -dv`. */
async function signatureTeam(file: string): Promise<string | undefined> {
  try {
    return parseCodesignDisplay(await execFileAsync("codesign", ["-dv", file], { timeout: 10_000 }))
      .teamId;
  } catch {
    return undefined;
  }
}

/**
 * Stages argent's library for the app and returns the bootstrap for
 * `--insert-library`. Call it once {@link hardenedRuntimeRefusal} has passed.
 *
 * A hardened Debug build without `disable-library-validation` loads only a
 * library signed by its own team. Its copy gets a directory of its own, which
 * the user signs once: signing needs the user's keychain. Until both files
 * carry the team's signature, the launch is refused with the command to run.
 */
export async function stageLibraryFor(
  info: MacosAppInfo,
  shipped: { bootstrap: string; library: string },
  readTeam: (file: string) => Promise<string | undefined> = signatureTeam
): Promise<string> {
  const teamId =
    info.hardenedRuntime && !info.entitlements.disableLibraryValidation ? info.teamId : undefined;
  let bootstrap: string;
  try {
    bootstrap = stageMacosLibraries(shipped.bootstrap, shipped.library, teamId);
  } catch (err) {
    throw macosFailure(
      `Could not copy the argent library to ~/.argent/macos/lib: ${errorMessage(err)}`,
      FAILURE_CODES.MACOS_APP_LIBRARY_STAGE_FAILED,
      "macos_app_stage_library",
      "unknown",
      err
    );
  }
  if (!teamId) return bootstrap;
  const files = [bootstrap, path.join(path.dirname(bootstrap), LIBRARY_NAME)];
  const teams = await Promise.all(files.map((file) => readTeam(file)));
  if (teams.every((team) => team === teamId)) return bootstrap;
  throw macosFailure(
    `${info.bundleId} is a Debug build with the hardened runtime, signed by the team ` +
      `${teamId}, so macOS loads the argent library into it only when the same team signed ` +
      `the library. Either build it without the hardened runtime (ENABLE_HARDENED_RUNTIME = NO ` +
      `in the Debug configuration), or sign argent's library with your own Apple Development ` +
      `identity of team ${teamId}:\n` +
      `codesign --force --sign "<identity of team ${teamId}>" ` +
      `${files.map((file) => `"${file}"`).join(" ")}\n` +
      `then start the app again. Signing uses the keychain, so the user runs this command, ` +
      `not the agent. A Release build with the hardened runtime cannot be driven.`,
    FAILURE_CODES.MACOS_APP_HARDENED_RUNTIME,
    "macos_app_launch",
    "unsupported"
  );
}

/** The longest path `sun_path` holds on macOS (104 bytes with the NUL). */
const MAX_SOCKET_PATH_BYTES = 103;

/**
 * Where the library listens for a reconnect, as the value for
 * `NATIVE_DEVTOOLS_LISTEN_SOCKET` and the path argent connects to.
 *
 * A sandboxed app can only listen inside its container, so it gets the literal
 * `CONTAINER`, which the library expands to its container's `Data/tmp/argent-nd.sock`.
 * A plain app listens in `~/.argent/macos/`, named after the bundle id, or
 * after its hash when the path would not fit. Null when even that is too long:
 * the app then has only the inherited channel.
 */
export function macosListenSocket(
  bundleId: string,
  sandboxed: boolean
): { env: string; path: string } | null {
  if (sandboxed) {
    const containerPath = path.join(
      os.homedir(),
      "Library",
      "Containers",
      bundleId,
      "Data",
      "tmp",
      "argent-nd.sock"
    );
    return fitsSocketPath(containerPath) ? { env: "CONTAINER", path: containerPath } : null;
  }
  const named = path.join(macosArgentDir(), `${bundleId}.sock`);
  if (fitsSocketPath(named)) return { env: named, path: named };
  const hash = createHash("sha256").update(bundleId).digest("hex").slice(0, 16);
  const hashed = path.join(macosArgentDir(), `${hash}.sock`);
  return fitsSocketPath(hashed) ? { env: hashed, path: hashed } : null;
}

function fitsSocketPath(p: string): boolean {
  return Buffer.byteLength(p, "utf8") <= MAX_SOCKET_PATH_BYTES;
}

/** For an app with no listening socket: argent reaches it only through the connection of its start. */
export function noListenSocketNote(bundleId: string): string {
  return (
    `The bundle id ${bundleId} is too long for a listening socket, so argent reaches the app ` +
    `only through the connection of this start. Once that closes (a tool-server restart, ` +
    `stop-simulator-server), quit the app or start it again with boot-device force: true. ` +
    `A shorter bundle id avoids this.`
  );
}

// ── Tracked apps ─────────────────────────────────────────────────────────────

/** One app argent started, as recorded in `~/.argent/macos-apps.json`. */
interface TrackedMacosApp {
  bundleId: string;
  /** The `.app` bundle, resolved through symlinks. */
  appPath: string;
  /** `Contents/MacOS/<CFBundleExecutable>`; also the `argv[0]` the helper gave the app. */
  executable: string;
  name: string;
  pid: number;
  sandboxed: boolean;
  /** The app may only read the files a user chooses: user-selected read-only and not read-write. */
  userSelectedReadOnly: boolean;
  /** The library's listening socket, or null when the app has none. */
  listenSocket: string | null;
  logPath: string;
  /** Extra arguments the app was started with; a relaunch reuses them. */
  args: string[];
  /** Epoch ms. */
  startedAt: number;
}

function trackedAppsFile(): string {
  return path.join(os.homedir(), ".argent", "macos-apps.json");
}

function isTrackedMacosApp(value: unknown): value is TrackedMacosApp {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.bundleId === "string" &&
    isMacosBundleId(v.bundleId) &&
    typeof v.appPath === "string" &&
    typeof v.executable === "string" &&
    typeof v.name === "string" &&
    typeof v.pid === "number" &&
    Number.isInteger(v.pid) &&
    v.pid > 0 &&
    typeof v.sandboxed === "boolean" &&
    typeof v.userSelectedReadOnly === "boolean" &&
    (v.listenSocket === null || typeof v.listenSocket === "string") &&
    typeof v.logPath === "string" &&
    Array.isArray(v.args) &&
    v.args.every((a) => typeof a === "string") &&
    typeof v.startedAt === "number"
  );
}

/** Damaged or foreign entries are skipped, never fatal: the file is a cache of what argent started. */
function readTrackedApps(): TrackedMacosApp[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(trackedAppsFile(), "utf8"));
  } catch {
    return [];
  }
  return Array.isArray(raw) ? raw.filter(isTrackedMacosApp) : [];
}

/** Adds or replaces the record for `app.bundleId`. */
export function recordTrackedMacosApp(app: TrackedMacosApp): void {
  const file = trackedAppsFile();
  const others = readTrackedApps().filter((a) => a.bundleId !== app.bundleId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // tmp+rename so a concurrent reader never sees a torn file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...others, app], null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * The record for `bundleId`, whether or not the app still runs: a relaunch
 * starts it again from `appPath`. Exact match, as the device id spells it.
 */
export function getTrackedMacosApp(bundleId: string): TrackedMacosApp | undefined {
  return readTrackedApps().find((a) => a.bundleId === bundleId);
}

/**
 * Outside a UTF-8 locale `ps` escapes every non-ASCII byte (`ż` prints as
 * `M-EM-<`), so an app under such a path would never match its own record. A
 * tool-server started by launchd or an editor often has no locale at all.
 * macOS always ships en_US.UTF-8.
 */
function psOptions(): { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number } {
  return {
    env: { ...process.env, LC_ALL: "en_US.UTF-8" },
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  };
}

/**
 * True while `pid` is alive AND runs `executable` (its `argv[0]`, which the
 * helper and LaunchServices set to the full executable path). A pid that
 * argent found earlier can belong to another process by now: argent lists,
 * connects to or signals a pid only after this check.
 */
export async function processRunsExecutable(pid: number, executable: string): Promise<boolean> {
  // `ps` below decides; this only skips it for a pid that is surely gone. A
  // process of another user answers EPERM, which still counts as alive here.
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    // `-ww`: never cut a long path to the terminal width.
    const { stdout } = await execFileAsync(
      PS_BIN,
      ["-ww", "-o", "comm=", "-p", String(pid)],
      psOptions()
    );
    return stdout.trim() === executable;
  } catch {
    // `ps` exits 1 for a pid that does not exist.
    return false;
  }
}

/** The record for `bundleId` while its process is alive and still the app. */
export async function runningTrackedApp(bundleId: string): Promise<TrackedMacosApp | undefined> {
  const app = getTrackedMacosApp(bundleId);
  return app && (await processRunsExecutable(app.pid, app.executable)) ? app : undefined;
}

/** Tracked apps whose process is alive. `list-devices` shows these. */
export async function listTrackedMacosApps(): Promise<TrackedMacosApp[]> {
  const apps = readTrackedApps();
  const running = await Promise.all(
    apps.map((app) => processRunsExecutable(app.pid, app.executable))
  );
  return apps.filter((_, i) => running[i]);
}

/**
 * The running copies of the app `bundleId` other than `skipPid`, from one `ps`
 * scan: `same` run `executable` itself (the user opened the app, or Xcode Run
 * started it); `otherBuilds` run an executable of the same name in another
 * bundle with this bundle id (another worktree's build, or Xcode's
 * DerivedData). Only those bundles' Info.plist files are read.
 */
export async function findRunningCopies(
  bundleId: string,
  executable: string,
  skipPid?: number
): Promise<{ same: number[]; otherBuilds: Array<{ pid: number; appPath: string }> }> {
  const found = {
    same: [] as number[],
    otherBuilds: [] as Array<{ pid: number; appPath: string }>,
  };
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(PS_BIN, ["-ww", "-axo", "pid=,comm="], psOptions()));
  } catch {
    return found;
  }
  const suffix = `/Contents/MacOS/${path.basename(executable)}`;
  const bundleIds = new Map<string, string | null>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === skipPid) continue;
    const [pid, command] = [Number(match[1]), match[2]!];
    if (command === executable) {
      found.same.push(pid);
      continue;
    }
    if (!command.endsWith(suffix)) continue;
    let resolved: string;
    try {
      resolved = fs.realpathSync(command);
    } catch {
      continue;
    }
    if (resolved === executable || !resolved.endsWith(suffix)) continue;
    const appPath = resolved.slice(0, -suffix.length);
    if (!bundleIds.has(appPath)) {
      bundleIds.set(
        appPath,
        await plistValue(path.join(appPath, "Contents", "Info.plist"), "CFBundleIdentifier")
      );
    }
    if (bundleIds.get(appPath) === bundleId) found.otherBuilds.push({ pid, appPath });
  }
  return found;
}

async function gitWorktreeOf(dir: string): Promise<{ top: string; common: string } | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      { timeout: 5_000 }
    );
    const [top, common] = stdout.trim().split("\n");
    if (!top || !common) return null;
    return { top: fs.realpathSync(top), common: fs.realpathSync(common) };
  } catch {
    return null;
  }
}

/**
 * The top folder of another git worktree of the project's repository when the
 * build at `appPath` comes from that worktree, else null: the same worktree,
 * another repository, or no git. A flow `launch` starts the build argent
 * recorded last for the bundle id, whoever booted it, so in one worktree a
 * flow could test the build of another. A build in Xcode's DerivedData
 * (`<DerivedData>/<name>-<hash>/Build/Products/<configuration>/<app>.app`)
 * comes from the project its `info.plist` names as `WorkspacePath`.
 */
export async function otherWorktreeOfBuild(
  appPath: string,
  projectRoot: string
): Promise<string | null> {
  const derivedData = /^(.*)\/Build\/Products\/[^/]+\/[^/]+\.app$/.exec(appPath)?.[1];
  const workspace = derivedData
    ? await plistValue(path.join(derivedData, "info.plist"), "WorkspacePath")
    : null;
  const [build, project] = await Promise.all([
    gitWorktreeOf(path.dirname(workspace ?? appPath)),
    gitWorktreeOf(projectRoot),
  ]);
  if (!build || !project) return null;
  if (build.common !== project.common || build.top === project.top) return null;
  return build.top;
}

// ── Bundle inspection ────────────────────────────────────────────────────────

export interface MacosAppInfo {
  /** The `.app` bundle, resolved through symlinks. */
  appPath: string;
  bundleId: string;
  name: string;
  executable: string;
  /** The `runtime` flag of the code signature. */
  hardenedRuntime: boolean;
  sandboxed: boolean;
  /** The app may only read the files a user chooses: user-selected read-only and not read-write. */
  userSelectedReadOnly: boolean;
  /** The signing team; absent for an ad hoc or missing signature. */
  teamId?: string;
  entitlements: {
    getTaskAllow: boolean;
    disableLibraryValidation: boolean;
    allowDyldEnvironmentVariables: boolean;
  };
  /** An Electron app or a Chromium browser, from the frameworks it ships. */
  chromium?: "electron" | "browser";
  /** A Mac Catalyst (UIKit) app, from the platform its executable is built for. */
  catalyst: boolean;
  /** `LSUIElement` or `LSBackgroundOnly`: the app has no Dock icon and no menu bar. */
  uiElement: boolean;
}

// The framework a Chromium browser ships: "Google Chrome Framework", "Microsoft Edge
// Framework", "Brave Browser Framework", "Chromium Framework" and the like.
const CHROMIUM_BROWSER_FRAMEWORK =
  /\b(chrome|chromium|edge|brave|vivaldi|opera)\b(?! embedded).* framework\.framework$/i;

function chromiumKind(appPath: string): MacosAppInfo["chromium"] {
  let frameworks: string[];
  try {
    frameworks = fs.readdirSync(path.join(appPath, "Contents", "Frameworks"));
  } catch {
    return undefined;
  }
  if (frameworks.includes("Electron Framework.framework")) return "electron";
  return frameworks.some((name) => CHROMIUM_BROWSER_FRAMEWORK.test(name)) ? "browser" : undefined;
}

const FAT_MAGIC = 0xcafebabe;
const MH_MAGIC_64 = 0xfeedfacf;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACCATALYST = 6;

/** Whether the platform in the executable's LC_BUILD_VERSION (of its first slice) is Mac Catalyst. */
function isCatalystExecutable(executable: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(executable, "r");
    const read = (length: number, position: number): Buffer => {
      const buffer = Buffer.alloc(length);
      return buffer.subarray(0, fs.readSync(fd!, buffer, 0, length, position));
    };
    let slice = 0;
    let header = read(32, 0);
    if (header.length === 32 && header.readUInt32BE(0) === FAT_MAGIC) {
      slice = header.readUInt32BE(16);
      header = read(32, slice);
    }
    if (header.length < 32 || header.readUInt32LE(0) !== MH_MAGIC_64) return false;
    const commands = read(header.readUInt32LE(20), slice + 32);
    for (let at = 0; at + 12 <= commands.length;) {
      if (commands.readUInt32LE(at) === LC_BUILD_VERSION) {
        return commands.readUInt32LE(at + 8) === PLATFORM_MACCATALYST;
      }
      const size = commands.readUInt32LE(at + 4);
      if (size < 8) break;
      at += size;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function plistValue(plist: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("plutil", ["-extract", key, "raw", "-o", "-", plist], {
      timeout: 10_000,
    });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function hasTrueEntitlement(xml: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<key>${escaped}</key>\\s*<true\\s*/>`).test(xml);
}

/**
 * Reads `codesign -dv [--entitlements - --xml]`: the flags (`flags=0x10000(runtime)`)
 * and `TeamIdentifier=` from stderr, the entitlements as an XML plist from
 * stdout. Pass null for an app `codesign` reports as unsigned.
 */
export function parseCodesignDisplay(
  output: { stdout: string; stderr: string } | null
): Pick<
  MacosAppInfo,
  "hardenedRuntime" | "sandboxed" | "userSelectedReadOnly" | "teamId" | "entitlements"
> {
  const xml = output?.stdout ?? "";
  const stderr = output?.stderr ?? "";
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(stderr)?.[1]?.split(",") ?? [];
  // "TeamIdentifier=not set" for an ad hoc signature.
  const teamId = /^TeamIdentifier=([A-Za-z0-9]+)$/m.exec(stderr)?.[1];
  const entitled = (key: string) => hasTrueEntitlement(xml, `com.apple.security.${key}`);
  return {
    hardenedRuntime: flags.some((f) => f.trim() === "runtime"),
    sandboxed: entitled("app-sandbox"),
    userSelectedReadOnly:
      entitled("files.user-selected.read-only") && !entitled("files.user-selected.read-write"),
    ...(teamId ? { teamId } : {}),
    entitlements: {
      getTaskAllow: entitled("get-task-allow"),
      disableLibraryValidation: entitled("cs.disable-library-validation"),
      allowDyldEnvironmentVariables: entitled("cs.allow-dyld-environment-variables"),
    },
  };
}

/**
 * Reads what a launch needs from the bundle: `Info.plist` (bundle id,
 * executable, name) and the code signature. An unsigned app is neither
 * hardened nor sandboxed.
 */
export async function inspectMacosApp(appPath: string): Promise<MacosAppInfo> {
  const invalid = (message: string, code: FailureCode, kind: FailureKind = "validation") =>
    macosFailure(message, code, "macos_app_inspect_bundle", kind);
  const badBundle = (message: string) => invalid(message, FAILURE_CODES.MACOS_APP_BUNDLE_INVALID);
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(appPath));
  } catch {
    throw invalid(
      `No app bundle at ${appPath}.`,
      FAILURE_CODES.MACOS_APP_PATH_INVALID,
      "not_found"
    );
  }
  const plist = path.join(resolved, "Contents", "Info.plist");
  if (!fs.statSync(resolved).isDirectory() || !fs.existsSync(plist)) {
    throw invalid(
      `${appPath} is not a Mac app bundle: expected a .app directory with Contents/Info.plist.`,
      FAILURE_CODES.MACOS_APP_PATH_INVALID
    );
  }

  const [bundleId, executableName, bundleName, uiElement, backgroundOnly] = await Promise.all([
    plistValue(plist, "CFBundleIdentifier"),
    plistValue(plist, "CFBundleExecutable"),
    plistValue(plist, "CFBundleName"),
    plistValue(plist, "LSUIElement"),
    plistValue(plist, "LSBackgroundOnly"),
  ]);
  if (!bundleId) throw badBundle(`${plist} has no CFBundleIdentifier.`);
  if (!isMacosBundleId(bundleId)) {
    throw badBundle(
      `The bundle id '${bundleId}' of ${appPath} is not supported: use letters, digits, '.' and '-'.`
    );
  }
  if (!executableName || executableName.includes("/")) {
    throw badBundle(`${plist} has no usable CFBundleExecutable.`);
  }
  const executable = path.join(resolved, "Contents", "MacOS", executableName);
  if (!fs.existsSync(executable)) {
    throw badBundle(`The executable ${executable} named by ${plist} does not exist.`);
  }

  let codesign: { stdout: string; stderr: string } | null;
  try {
    codesign = await execFileAsync("codesign", ["-dv", "--entitlements", "-", "--xml", resolved], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    // Not signed at all, or a signature codesign cannot read: neither carries
    // the runtime flag nor entitlements that dyld would honour.
    codesign = null;
  }

  const chromium = chromiumKind(resolved);
  return {
    appPath: resolved,
    bundleId,
    name: bundleName ?? path.basename(resolved, ".app"),
    executable,
    ...parseCodesignDisplay(codesign),
    ...(chromium ? { chromium } : {}),
    catalyst: isCatalystExecutable(executable),
    uiElement: [uiElement, backgroundOnly].some((v) => v !== null && /^(true|yes|1)$/i.test(v)),
  };
}

/**
 * An Electron app or a Chromium browser draws its pages in a web view that the
 * argent library cannot read, so argent drives it as a Chromium device.
 */
export function chromiumRefusal(info: MacosAppInfo): string | null {
  if (info.chromium === "electron") {
    return (
      `${info.bundleId} is an Electron app: argent drives Electron apps through boot-device ` +
      `with electronAppPath, not as a Mac app.`
    );
  }
  if (info.chromium === "browser") {
    return (
      `${info.bundleId} is a Chromium browser: argent drives its web pages when the browser ` +
      `runs with --remote-debugging-port (a Chromium device in list-devices), not as a Mac app.`
    );
  }
  return null;
}

/** Darwin 23.4 is macOS 14.4, the oldest macOS that the argent library supports. */
export function macosVersionRefusal(darwinRelease: string): string | null {
  const [major = 0, minor = 0] = darwinRelease.split(".").map(Number);
  if (major > 23 || (major === 23 && minor >= 4)) return null;
  return `Native Mac apps need macOS 14.4 or newer; this Mac runs an older macOS (Darwin ${darwinRelease}).`;
}

/**
 * With the hardened runtime, macOS loads the argent library only when the app
 * lets dyld read `DYLD_*` variables (`get-task-allow`, or
 * `allow-dyld-environment-variables`) AND accepts the library's signature:
 * `disable-library-validation`, or a library signed by the app's own team
 * (see {@link stageLibraryFor}). Measured on macOS 27.
 *
 * Without the first the app is a release build: notarized apps, other
 * developers' among them, or the Release configuration of the user's own. No
 * project setting opens that one, so the refusal asks for no rebuild.
 *
 * Returns the refusal, or null when argent can go on to stage the library.
 */
export function hardenedRuntimeRefusal(info: MacosAppInfo): string | null {
  if (!info.hardenedRuntime) return null;
  const { getTaskAllow, disableLibraryValidation, allowDyldEnvironmentVariables } =
    info.entitlements;
  if (!getTaskAllow && !allowDyldEnvironmentVariables) {
    return (
      `${info.bundleId} is a release build with the hardened runtime, so macOS does not load ` +
      `the argent library into it, and argent cannot drive it. Notarized apps, including apps ` +
      `from other developers, are built this way. argent drives Debug builds of your own app: ` +
      `if this app is yours, start its Debug build.`
    );
  }
  if (disableLibraryValidation || info.teamId) return null;
  return (
    `${info.bundleId} is a Debug build with the hardened runtime, so macOS does not load the ` +
    `argent library into it. Build it without the hardened runtime (ENABLE_HARDENED_RUNTIME = ` +
    `NO in the Debug configuration), or add the entitlement ` +
    `com.apple.security.cs.disable-library-validation to the Debug build. A Release build ` +
    `with the hardened runtime cannot be driven.`
  );
}

/**
 * The newest `.app` that Spotlight knows for `bundleId`, or null. Several
 * builds of one app are common (Debug and Release, two DerivedData folders);
 * the one with the newest executable is most likely the one just built.
 */
export async function findMacosAppByBundleId(bundleId: string): Promise<string | null> {
  if (!isMacosBundleId(bundleId)) return null;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "mdfind",
      // The bundle id alphabet has no quote, so it cannot leave the string.
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }
    ));
  } catch {
    return null;
  }
  let best: { appPath: string; mtimeMs: number } | null = null;
  for (const line of stdout.split("\n")) {
    const appPath = line.trim();
    if (!appPath.endsWith(".app")) continue;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(path.join(appPath, "Contents", "Info.plist")).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) best = { appPath, mtimeMs };
  }
  return best?.appPath ?? null;
}

/**
 * A sandbox extension token for `filePath` (`argent-macos-helper
 * issue-extension`), for a sandboxed app to consume before it reads or writes
 * a file the agent chose. For a save panel, pass the parent directory.
 */
export async function issueSandboxExtension(
  filePath: string,
  opts: { readOnly?: boolean } = {}
): Promise<string> {
  const args = ["issue-extension", "--path", path.resolve(filePath)];
  if (opts.readOnly) args.push("--read-only");
  try {
    const { stdout } = await execFileAsync(macosArtifacts().helper, args, { timeout: 10_000 });
    const token = stdout.trim();
    if (!token) throw new Error("argent-macos-helper printed no token");
    return token;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw macosFailure(
      `Could not give the sandboxed app access to ${filePath}: ${stderr || errorMessage(err)}`,
      FAILURE_CODES.MACOS_APP_FILE_ACCESS_FAILED,
      "macos_app_issue_extension",
      "subprocess",
      err
    );
  }
}
