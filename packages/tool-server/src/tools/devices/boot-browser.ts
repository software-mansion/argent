import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { bootElectronApp, type ElectronBootResult } from "./boot-electron";

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

function findBrowserExecutable(browser: BrowserName): string | null {
  return browserExecutableCandidates(browser).find((p) => fs.existsSync(p)) ?? null;
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
        browserExecutableCandidates(options.browser).join(", ") || "an empty PATH"
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

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-browser-"));
  return bootElectronApp({
    appPath: executable,
    port: options.port,
    label: "Browser",
    extraArgs: [
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(options.extraArgs ?? []),
      "about:blank",
    ],
    onProcessGone: () => {
      fs.rm(profileDir, { recursive: true, force: true, maxRetries: 3 }, () => {});
    },
  });
}
