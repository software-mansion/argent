import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { browserWebSocketUrl } from "../../chromium-server/cdp-session";
import { CDPClient } from "../../utils/debugger/cdp-client";
import { pidIsAlive } from "../../utils/process-kill";
import { bootElectronApp, killChromiumByPort, type ElectronBootResult } from "./boot-electron";

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
/** Holds the browser's pid, so a later boot can tell a leftover profile from a live one. */
const PID_FILE = "argent-browser.pid";

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

/** Deletes profiles whose browser is gone, e.g. left by a tool-server that exited first. */
function removeStaleProfiles(root: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(root).filter((n) => n.startsWith(PROFILE_PREFIX));
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    let pid: number;
    try {
      pid = Number(fs.readFileSync(path.join(dir, PID_FILE), "utf8"));
    } catch {
      continue; // still booting, or not ours
    }
    if (!pidIsAlive(pid)) {
      fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }, () => {});
    }
  }
}

/**
 * Whether the browser answering on 127.0.0.1:`port` runs on `profileDir`. A
 * browser that loses 127.0.0.1 to one booting at the same moment in another
 * process binds [::1] instead, and our readiness probe reaches the other one.
 */
async function answersOnProfile(port: number, profileDir: string): Promise<boolean> {
  const browser = new CDPClient(await browserWebSocketUrl(port), { sendOrigin: false });
  await browser.connect();
  try {
    const { commandLine } = (await browser.send("SystemInfo.getInfo")) as { commandLine?: string };
    // The random dir name is matched rather than the path, which Windows may quote.
    return commandLine?.includes(path.basename(profileDir)) ?? false;
  } finally {
    await browser.disconnect().catch(() => {});
  }
}

interface BootBrowserOptions {
  browser: BrowserName;
  port?: number;
  extraArgs?: string[];
}

/**
 * Launch an installed Chromium-family browser as a `chromium` device. Each
 * launch gets a fresh profile: Chrome refuses remote debugging on its default
 * profile, and a profile another instance holds hands the launch over to that
 * instance, which never opens our port.
 */
export async function bootBrowser(options: BootBrowserOptions): Promise<ElectronBootResult> {
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

  const extraArgs = options.extraArgs ?? [];
  // Chromium reads every non-flag argument as a start URL, and headless mode
  // exits on more than one, so about:blank is only the default.
  const hasStartUrl = extraArgs.some((a) => !a.startsWith("-"));
  const snap = snapName(executable);
  const root = snap ? path.join(os.homedir(), "snap", snap, "common") : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  removeStaleProfiles(root);
  const profileDir = fs.mkdtempSync(path.join(root, PROFILE_PREFIX));
  const result = await bootElectronApp({
    appPath: executable,
    port: options.port,
    label: "Browser",
    extraArgs: [
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...extraArgs,
      ...(hasStartUrl ? [] : ["about:blank"]),
    ],
    onProcessGone: () => {
      fs.rm(profileDir, { recursive: true, force: true, maxRetries: 3 }, () => {});
    },
  });
  try {
    fs.writeFileSync(path.join(profileDir, PID_FILE), String(result.pid));
  } catch {
    // The browser already exited, and its profile went with it.
  }

  const ours = await answersOnProfile(result.port, profileDir).catch((err: unknown) => {
    killChromiumByPort(result.port);
    throw err;
  });
  if (!ours) {
    // The port stays tracked: the browser holding it is still a device.
    killChromiumByPort(result.port);
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
