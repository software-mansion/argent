import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";

const bootElectronAppMock = vi.fn();
vi.mock("../src/tools/devices/boot-electron", () => ({
  bootElectronApp: (opts: unknown) => bootElectronAppMock(opts),
}));

// Paths reported as installed; every other path is absent.
const installed = new Set<string>();
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: (p: fs.PathLike) => installed.has(String(p)) };
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

  it("looks under Program Files, Program Files (x86) and LocalAppData on Windows", () => {
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
  });

  it("searches every PATH entry for each command name on Linux", () => {
    expect(
      browserExecutableCandidates("chromium", "linux", { PATH: "/usr/bin:/snap/bin" })
    ).toEqual([
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/snap/bin/chromium-browser",
    ]);
  });
});

describe("bootBrowser", () => {
  const chrome = browserExecutableCandidates("chrome")[0]!;
  const edge = browserExecutableCandidates("edge")[0]!;

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
    installed.add(chrome);
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

  it("gives every launch its own profile and deletes it once the process is gone", async () => {
    installed.add(chrome);
    await bootBrowser({ browser: "chrome" });
    await bootBrowser({ browser: "chrome" });

    const [a, b] = bootElectronAppMock.mock.calls.map((c) => c[0]);
    const dirA = profileDirOf(a.extraArgs)!;
    expect(dirA).not.toBe(profileDirOf(b.extraArgs));

    a.onProcessGone();
    await vi.waitFor(() => expect(fs.statSync(dirA, { throwIfNoEntry: false })).toBeUndefined());
  });

  it("fails naming the browsers that are installed when the requested one is not", async () => {
    installed.add(edge);
    const err = await bootBrowser({ browser: "chrome" }).catch((e: unknown) => e);

    expect(bootElectronAppMock).not.toHaveBeenCalled();
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_BROWSER_NOT_FOUND);
    expect((err as Error).message).toContain(`looked in ${chrome}`);
    expect((err as Error).message).toContain("Installed: edge;");
  });

  it("says no supported browser exists when none is installed", async () => {
    const err = await bootBrowser({ browser: "brave" }).catch((e: unknown) => e);
    expect((err as Error).message).toContain(
      "No supported browser (chrome, chromium, edge, brave) was found."
    );
  });
});
