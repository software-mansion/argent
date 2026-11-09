import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { browserWebSocketUrl } from "../../chromium-server/cdp-session";
import { CDPClient } from "../../utils/debugger/cdp-client";
import { pidIsAlive } from "../../utils/process-kill";
import { PS_BIN } from "../../utils/vega-process";
import {
  abortedBootError,
  bootElectronApp,
  isChromiumSwitch,
  killChromiumByPortAndWait,
  type ElectronBootResult,
} from "./boot-electron";

export const BROWSER_NAMES = ["chrome", "chromium", "edge", "brave"] as const;
export type BrowserName = (typeof BROWSER_NAMES)[number];

const MAC_APP_NAMES: Record<BrowserName, string> = {
  chrome: "Google Chrome",
  chromium: "Chromium",
  edge: "Microsoft Edge",
  brave: "Brave Browser",
};

const LINUX_COMMANDS: Record<BrowserName, string[]> = {
  chrome: ["google-chrome", "google-chrome-stable"],
  chromium: ["chromium", "chromium-browser"],
  edge: ["microsoft-edge", "microsoft-edge-stable"],
  brave: ["brave-browser", "brave"],
};

const WINDOWS_RELATIVE_PATHS: Record<BrowserName, string> = {
  chrome: "Google\\Chrome\\Application\\chrome.exe",
  chromium: "Chromium\\Application\\chrome.exe",
  edge: "Microsoft\\Edge\\Application\\msedge.exe",
  brave: "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
};

/** Where `browser` is installed by default on `platform`, in lookup order. */
export function browserExecutableCandidates(
  browser: BrowserName,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string[] {
  if (platform === "darwin") {
    const app = MAC_APP_NAMES[browser];
    return ["/Applications", path.join(home, "Applications")].map((dir) =>
      path.join(dir, `${app}.app`, "Contents", "MacOS", app)
    );
  }
  if (platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]];
    return roots
      .filter((root): root is string => Boolean(root))
      .map((root) => path.win32.join(root, WINDOWS_RELATIVE_PATHS[browser]));
  }
  const dirs = (env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => LINUX_COMMANDS[browser].map((cmd) => path.join(dir, cmd)));
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findBrowserExecutable(browser: BrowserName): string | null {
  return browserExecutableCandidates(browser).find(isExecutableFile) ?? null;
}

const PROFILE_PREFIX = "argent-browser-";
/**
 * Holds the booting tool-server's pid until the boot succeeds, then
 * `BROWSER_PID_TAG` and the browser's, so the sweep spares a profile that is
 * still booting.
 */
const PID_FILE = "argent-browser.pid";
const BROWSER_PID_TAG = "browser ";
/**
 * A relaunch (chrome://restart, an update) ends our process and starts a new
 * browser on the profile, which takes the lock only after a moment.
 */
const RELAUNCH_GRACE_MS = 5000;

/** 0 and negative pids name process groups, which a kill(pid, 0) probe always reaches. */
function holderAlive(pid: number): boolean {
  return pid > 0 && pidIsAlive(pid);
}

/** Whether `pid` is a browser on `dir`; a dead browser's pid can pass to an unrelated process. */
function browserOnProfile(pid: number, dir: string): boolean {
  if (!holderAlive(pid)) return false;
  // Windows has no ps of its own; Git Bash's numbers its own pids.
  if (process.platform === "win32") return true;
  const ps = spawnSync(PS_BIN, ["-ww", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2000,
  });
  // A ps that cannot answer (none, or busybox rejecting these flags) proves nothing.
  return ps.error !== undefined || ps.stderr !== "" || ps.stdout.includes(path.basename(dir));
}

/**
 * Whether a browser holds `dir`, by Chromium's own profile lock: on POSIX a
 * `SingletonLock` symlink to `<host>-<pid>`, which a crash leaves behind; on
 * Windows a `lockfile` deleted when its holder exits.
 */
function profileLocked(dir: string): boolean {
  if (process.platform === "win32") return fs.existsSync(path.join(dir, "lockfile"));
  try {
    const owner = fs.readlinkSync(path.join(dir, "SingletonLock"));
    return browserOnProfile(Number(owner.slice(owner.lastIndexOf("-") + 1)), dir);
  } catch {
    return false;
  }
}

/** Whether the pid in `dir`'s pid file is still booting it or running on it. */
function holderOf(dir: string, pidFile: string): boolean {
  return pidFile.startsWith(BROWSER_PID_TAG)
    ? browserOnProfile(Number(pidFile.slice(BROWSER_PID_TAG.length)), dir)
    : holderAlive(Number(pidFile));
}

/**
 * The snap a Linux launcher runs, if any. A snap sees a private /tmp, so a
 * profile there would land where neither we nor our cleanup can reach it.
 */
export function snapName(executable: string): string | null {
  try {
    // /snap/bin/<app> links to the snap launcher, possibly through an alias; the
    // snap is the app name before any dot.
    // realpath first: it throws on a symlink loop, which the walk would follow forever.
    if (path.basename(fs.realpathSync(executable)) === "snap") {
      for (let p = executable; fs.lstatSync(p).isSymbolicLink();) {
        const target = path.resolve(path.dirname(p), fs.readlinkSync(p));
        if (path.basename(target) === "snap") return path.basename(p).split(".")[0]!;
        p = target;
      }
    }
    // Ubuntu's chromium-browser is a script that execs /snap/bin/chromium.
    const head = Buffer.alloc(4096);
    const fd = fs.openSync(executable, "r");
    let text: string;
    try {
      text = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)).toString("latin1");
    } finally {
      fs.closeSync(fd);
    }
    return text.startsWith("#!") ? (/\/snap\/bin\/([\w-]+)/.exec(text)?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

/** Every root a profile can be in: the temp dir, and each snap's own dir. */
function profileRoots(): string[] {
  const snaps = path.join(os.homedir(), "snap");
  let names: string[] = [];
  try {
    names = fs.readdirSync(snaps);
  } catch {
    // no snaps
  }
  return [os.tmpdir(), ...names.map((n) => path.join(snaps, n, "common"))];
}

/** Deletes profiles nothing holds, e.g. left by a tool-server that exited first. */
function removeStaleProfiles(): void {
  const dirs = profileRoots().flatMap((root) => {
    try {
      return fs
        .readdirSync(root)
        .filter((n) => n.startsWith(PROFILE_PREFIX))
        .map((n) => path.join(root, n));
    } catch {
      return [];
    }
  });
  for (const dir of dirs) {
    let pidFile: string;
    let mtimeMs: number;
    try {
      pidFile = fs.readFileSync(path.join(dir, PID_FILE), "utf8");
      ({ mtimeMs } = fs.statSync(dir));
    } catch {
      continue; // not ours, or already gone
    }
    // A browser exiting deletes its lock, so a fresh mtime may be a relaunch.
    const settled = Date.now() - mtimeMs >= RELAUNCH_GRACE_MS;
    if (settled && !holderOf(dir, pidFile) && !profileLocked(dir)) {
      fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }, () => {});
    }
  }
}

/**
 * Bounds the identity check. A browser can stop answering right after its
 * first CDP reply: Edge on macOS blocks ~10 s in a Spotlight call.
 */
const IDENTITY_CHECK_TIMEOUT_MS = 20_000;

/**
 * Whether the browser answering on 127.0.0.1:`port` runs on `profileDir`. A
 * browser that loses 127.0.0.1 to one booting at the same moment in another
 * process binds [::1] instead, and our readiness probe reaches the other one.
 */
async function answersOnProfile(
  port: number,
  profileDir: string,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = new AbortController();
  let browser: CDPClient | undefined;
  const check = (async () => {
    browser = new CDPClient(await browserWebSocketUrl(port, deadline.signal), {
      sendOrigin: false,
    });
    await browser.connect();
    const { commandLine } = (await browser.send(
      "SystemInfo.getInfo",
      undefined,
      IDENTITY_CHECK_TIMEOUT_MS
    )) as { commandLine?: string };
    // The random dir name is matched rather than the path, which Windows may quote.
    return commandLine?.includes(path.basename(profileDir)) ?? false;
  })();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    onAbort = () => {
      deadline.abort();
      reject(abortedBootError("Browser"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      deadline.abort();
      reject(
        new FailureError(
          `Browser boot: the browser on port ${port} stopped answering CDP for ` +
            `${IDENTITY_CHECK_TIMEOUT_MS} ms right after it started.`,
          {
            error_code: FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE,
            failure_stage: "browser_identity_check",
            failure_area: "tool_server",
            error_kind: "network",
            failure_command: "cdp",
            network_failure: "timeout",
          }
        )
      );
    }, IDENTITY_CHECK_TIMEOUT_MS);
  });
  try {
    // Raced rather than awaited: a wedged peer can hold a closing socket for 30 s.
    return await Promise.race([check, timedOut]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort!);
    check.catch(() => {});
    await browser?.disconnect().catch(() => {});
  }
}

interface BootBrowserOptions {
  browser: BrowserName;
  port?: number;
  extraArgs?: string[];
  signal?: AbortSignal;
}

/**
 * Launch an installed Chromium-family browser as a `chromium` device. Each
 * launch gets a fresh profile: Chrome refuses remote debugging on its default
 * profile, and a profile another instance holds hands the launch over to that
 * instance, which never opens our port.
 */
export async function bootBrowser(options: BootBrowserOptions): Promise<ElectronBootResult> {
  // Chromium takes the last --user-data-dir, so one here would replace the throwaway profile.
  const userDataDir = options.extraArgs?.find((a) => isChromiumSwitch(a, "user-data-dir"));
  if (userDataDir) {
    throw new FailureError(
      `Browser boot: \`electronArgs\` cannot set ${userDataDir}: a browser boot always runs ` +
        `on its own fresh profile. Drop the flag.`,
      {
        error_code: FAILURE_CODES.CHROMIUM_PARAM_INVALID,
        failure_stage: "browser_user_data_dir",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  const executable = findBrowserExecutable(options.browser);
  if (!executable) {
    const installed = BROWSER_NAMES.filter((b) => findBrowserExecutable(b));
    throw new FailureError(
      `Browser boot: ${options.browser} is not installed (looked in ${
        browserExecutableCandidates(options.browser).join(", ") ||
        (process.platform === "win32"
          ? "nothing: PROGRAMFILES, PROGRAMFILES(X86) and LOCALAPPDATA are unset"
          : "nothing: PATH is empty")
      }). ` +
        (installed.length
          ? `Installed: ${installed.join(", ")}; pass one of those as \`browser\`.`
          : "No supported browser (chrome, chromium, edge, brave) was found."),
      {
        error_code: FAILURE_CODES.CHROMIUM_BROWSER_NOT_FOUND,
        failure_stage: "browser_executable_missing",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
      }
    );
  }

  // Chromium reads every non-flag argument, an empty one too, as a start URL,
  // and headless mode exits on more than one, so about:blank is only the default.
  const extraArgs = (options.extraArgs ?? []).filter((a) => a !== "");
  const hasStartUrl = extraArgs.some((a) => !a.startsWith("-"));
  const snap = snapName(executable);
  const root = snap ? path.join(os.homedir(), "snap", snap, "common") : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  removeStaleProfiles();
  const profileDir = fs.mkdtempSync(path.join(root, PROFILE_PREFIX));
  try {
    fs.writeFileSync(path.join(profileDir, PID_FILE), String(process.pid));
  } catch (err) {
    // The sweep skips a profile with no pid file.
    fs.rmSync(profileDir, { recursive: true, force: true });
    throw err;
  }
  const result = await bootElectronApp({
    appPath: executable,
    port: options.port,
    kind: "browser",
    signal: options.signal,
    extraArgs: [
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...extraArgs,
      ...(hasStartUrl ? [] : ["about:blank"]),
    ],
    onProcessGone: () => {
      setTimeout(() => {
        if (!profileLocked(profileDir)) {
          fs.rm(profileDir, { recursive: true, force: true, maxRetries: 3 }, () => {});
        }
      }, RELAUNCH_GRACE_MS).unref();
    },
  });
  try {
    fs.writeFileSync(path.join(profileDir, PID_FILE), `${BROWSER_PID_TAG}${result.pid}`);
  } catch {
    // The tool-server's pid it already holds keeps the profile until that exits.
  }

  const ours = await answersOnProfile(result.port, profileDir, options.signal).catch(
    async (err: unknown) => {
      await killChromiumByPortAndWait(result.port);
      throw err;
    }
  );
  if (!ours) {
    // The port stays tracked: the browser holding it is still a device.
    await killChromiumByPortAndWait(result.port);
    throw new FailureError(
      `Browser boot: another browser took port ${result.port} on 127.0.0.1 while this one ` +
        `started. ` +
        (options.port === undefined
          ? "Retry."
          : "Pass another `electronPort`, or omit it to get a free port."),
      {
        error_code: FAILURE_CODES.CHROMIUM_ELECTRON_PORT_IN_USE,
        failure_stage: "browser_port_taken",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  return result;
}
