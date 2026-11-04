import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";

const bootElectronAppMock = vi.fn();
vi.mock("../src/tools/devices/boot-electron", () => ({
  bootElectronApp: (opts: unknown) => bootElectronAppMock(opts),
}));

// Paths present on the fake host and what each one is. Only the temp dir (the
// profiles) reaches the real filesystem, so a browser installed on the machine
// running the tests stays invisible.
const installed = new Map<string, "exec" | "dir" | "noexec">();
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
  const absent = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  return {
    ...actual,
    statSync: ((p: fs.PathLike, opts?: fs.StatSyncOptions) => {
      const kind = installed.get(String(p));
      if (kind) return { isFile: () => kind !== "dir", isDirectory: () => kind === "dir" };
      return String(p).startsWith(tmpdir()) ? actual.statSync(p, opts) : absent();
    }) as typeof fs.statSync,
    accessSync: (p: fs.PathLike, mode?: number) => {
      const kind = installed.get(String(p));
      if (kind === "noexec") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      if (kind) return;
      return String(p).startsWith(tmpdir()) ? actual.accessSync(p, mode) : absent();
    },
  };
});

import { bootBrowser, browserExecutableCandidates } from "../src/tools/devices/boot-browser";

describe("browserExecutableCandidates", () => {
  it("looks in /Applications then ~/Applications on macOS", () => {
    expect(browserExecutableCandidates("chrome", "darwin", {}, "/Users/u")).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]);
    expect(browserExecutableCandidates("brave", "darwin", {}, "/Users/u")[0]).toBe(
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    );
  });

  it("looks under Program Files, Program Files (x86) and LocalAppData on Windows, skipping unset roots", () => {
    const env = {
      "PROGRAMFILES": "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      "LOCALAPPDATA": "C:\\Users\\u\\AppData\\Local",
    };
    expect(browserExecutableCandidates("edge", "win32", env)).toEqual([
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
    ]);
    expect(
      browserExecutableCandidates("chrome", "win32", {
        "PROGRAMFILES": "C:\\Program Files",
        "PROGRAMFILES(X86)": "",
      })
    ).toEqual(["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]);
  });

  it("searches every non-empty PATH entry for each command name on Linux", () => {
    const linux = (browser: Parameters<typeof browserExecutableCandidates>[0]) =>
      browserExecutableCandidates(browser, "linux", { PATH: "/usr/bin::/snap/bin:" });
    expect(linux("chromium")).toEqual([
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/snap/bin/chromium-browser",
    ]);
    expect(linux("chrome").slice(0, 2)).toEqual([
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ]);
    expect(linux("edge").slice(0, 2)).toEqual([
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
    ]);
    expect(linux("brave").slice(0, 2)).toEqual(["/usr/bin/brave-browser", "/usr/bin/brave"]);
  });
});

describe("bootBrowser", () => {
  const [chrome, chromeFallback] = browserExecutableCandidates("chrome");
  const edge = browserExecutableCandidates("edge")[0]!;
  const brave = browserExecutableCandidates("brave")[0]!;

  beforeEach(() => {
    installed.clear();
    bootElectronAppMock.mockReset();
    bootElectronAppMock.mockResolvedValue({ platform: "chromium" });
  });
  afterEach(() => {
    for (const call of bootElectronAppMock.mock.calls) {
      const dir = profileDirOf(call[0].extraArgs);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function profileDirOf(args: string[]): string | undefined {
    return args.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
  }

  it("launches the installed binary on a fresh profile, caller flags before the start page", async () => {
    installed.set(chrome!, "exec");
    await bootBrowser({ browser: "chrome", port: 9333, extraArgs: ["--headless=new"] });

    const opts = bootElectronAppMock.mock.calls[0]![0];
    expect(opts.appPath).toBe(chrome);
    expect(opts.port).toBe(9333);
    expect(opts.label).toBe("Browser");
    const dir = profileDirOf(opts.extraArgs)!;
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(opts.extraArgs).toEqual([
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--headless=new",
      "about:blank",
    ]);
  });

  it("opens the caller's start URL instead of about:blank", async () => {
    installed.set(chrome!, "exec");
    await bootBrowser({
      browser: "chrome",
      extraArgs: ["--headless=new", "http://localhost:3000"],
    });

    const args: string[] = bootElectronAppMock.mock.calls[0]![0].extraArgs;
    expect(args.slice(-2)).toEqual(["--headless=new", "http://localhost:3000"]);
    expect(args).not.toContain("about:blank");
  });

  it("falls back to a later install location", async () => {
    installed.set(chromeFallback!, "exec");
    await bootBrowser({ browser: "chrome" });
    expect(bootElectronAppMock.mock.calls[0]![0].appPath).toBe(chromeFallback);
  });

  it("skips a directory or non-executable file in an earlier location", async () => {
    installed.set(chrome!, "dir");
    installed.set(chromeFallback!, "exec");
    await bootBrowser({ browser: "chrome" });
    expect(bootElectronAppMock.mock.calls[0]![0].appPath).toBe(chromeFallback);

    if (process.platform === "win32") return; // no execute bit there
    bootElectronAppMock.mockClear();
    installed.set(chrome!, "noexec");
    await bootBrowser({ browser: "chrome" });
    expect(bootElectronAppMock.mock.calls[0]![0].appPath).toBe(chromeFallback);
  });

  it("gives every launch its own profile and deletes it once the process is gone", async () => {
    installed.set(chrome!, "exec");
    await bootBrowser({ browser: "chrome" });
    await bootBrowser({ browser: "chrome" });

    const [a, b] = bootElectronAppMock.mock.calls.map((c) => c[0]);
    const dirA = profileDirOf(a.extraArgs)!;
    expect(dirA).not.toBe(profileDirOf(b.extraArgs));

    a.onProcessGone();
    await vi.waitFor(() => expect(fs.existsSync(dirA)).toBe(false));
  });

  it("fails naming the browsers that are installed when the requested one is not", async () => {
    installed.set(edge, "exec");
    const err = await bootBrowser({ browser: "brave" }).catch((e: unknown) => e);

    expect(bootElectronAppMock).not.toHaveBeenCalled();
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_BROWSER_NOT_FOUND);
    expect((err as Error).message).toContain(`looked in ${brave}`);
    expect((err as Error).message).not.toContain(chrome!);
    expect((err as Error).message).toContain("Installed: edge;");
  });

  it("says no supported browser exists when none is installed", async () => {
    const err = await bootBrowser({ browser: "brave" }).catch((e: unknown) => e);
    expect((err as Error).message).toContain(
      "No supported browser (chrome, chromium, edge, brave) was found."
    );
  });

  describe("with nowhere to look", () => {
    const platform = process.platform;
    const env = { ...process.env };
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: platform });
      process.env = env;
    });

    it("names the empty PATH on Linux", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.env = { ...env, PATH: "" };
      const err = await bootBrowser({ browser: "chrome" }).catch((e: unknown) => e);
      expect((err as Error).message).toContain("(looked in nothing: PATH is empty)");
    });

    it("names the unset install roots on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env = {};
      const err = await bootBrowser({ browser: "chrome" }).catch((e: unknown) => e);
      expect((err as Error).message).toContain(
        "(looked in nothing: PROGRAMFILES, PROGRAMFILES(X86) and LOCALAPPDATA are unset)"
      );
    });
  });
});
