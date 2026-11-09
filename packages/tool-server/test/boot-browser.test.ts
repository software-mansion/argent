import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";

const bootElectronAppMock = vi.fn();
const killMock = vi.fn();
vi.mock("../src/tools/devices/boot-electron", () => ({
  bootElectronApp: (opts: unknown) => bootElectronAppMock(opts),
  killChromiumByPort: (port: number) => killMock(port),
}));

// SystemInfo.getInfo on the browser that answers the booted port.
const WS_URL = "ws://127.0.0.1/devtools/browser/x";
const wsUrlMock = vi.fn();
const cdpConnect = vi.fn();
const cdpSend = vi.fn();
const cdpDisconnect = vi.fn();
vi.mock("../src/chromium-server/cdp-session", () => ({
  browserWebSocketUrl: (port: number, signal?: AbortSignal) => wsUrlMock(port, signal),
}));
vi.mock("../src/utils/debugger/cdp-client", () => ({
  CDPClient: class {
    connect = () => cdpConnect();
    disconnect = () => cdpDisconnect();
    send = (method: string, params?: unknown, timeout?: number) => cdpSend(method, params, timeout);
  },
}));

// The ps the sweep asks, when a test swaps in a broken one.
const psBin = vi.hoisted(() => ({ path: "" }));
vi.mock("../src/utils/vega-process", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/vega-process")>(
    "../src/utils/vega-process"
  );
  return {
    ...actual,
    get PS_BIN() {
      return psBin.path || actual.PS_BIN;
    },
  };
});

const fakeHome = vi.hoisted(() => ({ dir: "" }));
const failPidWrite = vi.hoisted(() => ({ on: false, made: [] as string[] }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => fakeHome.dir || actual.homedir() };
});

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
    mkdtempSync: ((prefix: string, opts?: fs.EncodingOption) => {
      const dir = actual.mkdtempSync(prefix, opts);
      failPidWrite.made.push(String(dir));
      return dir;
    }) as typeof fs.mkdtempSync,
    writeFileSync: ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (failPidWrite.on && String(file).endsWith("argent-browser.pid")) {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }
      return (actual.writeFileSync as (...a: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync,
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

import * as os from "node:os";
import * as path from "node:path";
import {
  bootBrowser,
  browserExecutableCandidates,
  snapName,
} from "../src/tools/devices/boot-browser";

describe("browserExecutableCandidates", () => {
  it("looks in /Applications then ~/Applications on macOS", () => {
    expect(browserExecutableCandidates("chrome", "darwin", {}, "/Users/u")).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]);
    expect(browserExecutableCandidates("brave", "darwin", {}, "/Users/u")[0]).toBe(
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    );
    expect(browserExecutableCandidates("chromium", "darwin", {}, "/Users/u")[0]).toBe(
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
    expect(browserExecutableCandidates("edge", "darwin", {}, "/Users/u")[0]).toBe(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
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
    const local = { LOCALAPPDATA: "C:\\L" };
    expect(browserExecutableCandidates("chromium", "win32", local)).toEqual([
      "C:\\L\\Chromium\\Application\\chrome.exe",
    ]);
    expect(browserExecutableCandidates("brave", "win32", local)).toEqual([
      "C:\\L\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ]);
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
    bootElectronAppMock.mockResolvedValue({ platform: "chromium", port: 9333, pid: process.pid });
    killMock.mockReset();
    cdpSend.mockReset();
    cdpSend.mockImplementation(async () => ({
      commandLine: `chrome ${bootElectronAppMock.mock.lastCall![0].extraArgs.join(" ")}`,
    }));
    cdpDisconnect.mockReset();
    cdpDisconnect.mockImplementation(async () => {});
    cdpConnect.mockReset();
    cdpConnect.mockImplementation(async () => {});
    wsUrlMock.mockReset();
    wsUrlMock.mockImplementation(async () => WS_URL);
  });
  afterEach(() => {
    for (const child of holders.splice(0)) child.kill("SIGKILL");
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

  it("drops an empty argument, which Chromium would open as a second start page", async () => {
    installed.set(chrome!, "exec");
    await bootBrowser({ browser: "chrome", extraArgs: ["--headless=new", ""] });
    expect(bootElectronAppMock.mock.calls[0]![0].extraArgs.slice(-2)).toEqual([
      "--headless=new",
      "about:blank",
    ]);
  });

  it("falls back to a later install location", async () => {
    installed.set(chromeFallback!, "exec");
    await bootBrowser({ browser: "chrome" });
    expect(bootElectronAppMock.mock.calls[0]![0].appPath).toBe(chromeFallback);
  });

  it("prefers the first install location when the browser is in several", async () => {
    installed.set(chrome!, "exec");
    installed.set(chromeFallback!, "exec");
    await bootBrowser({ browser: "chrome" });
    expect(bootElectronAppMock.mock.calls[0]![0].appPath).toBe(chrome);
  });

  it("skips a directory or non-executable file in an earlier location", async () => {
    installed.set(chrome!, "dir");
    installed.set(chromeFallback!, "exec");
    await bootBrowser({ browser: "chrome" });
    expect(bootElectronAppMock.mock.calls[0]![0].appPath).toBe(chromeFallback);

    if (process.platform === "win32") return; // no execute bit there
    installed.set(chrome!, "noexec");
    await bootBrowser({ browser: "chrome" });
    expect(bootElectronAppMock.mock.calls[1]![0].appPath).toBe(chromeFallback);
  });

  // Chromium's POSIX profile lock: a symlink to `<host>-<pid>` of the browser holding it.
  const lockFor = (dir: string, pid: number) =>
    fs.symlinkSync(`some-host-${pid}`, path.join(dir, "SingletonLock"));
  const DEAD_PID = 2147483646;
  // A live process whose command line names `dir`, as a browser on it does.
  const holders: ChildProcess[] = [];
  const browserOn = (dir: string) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", dir]);
    holders.push(child);
    return child.pid!;
  };

  it("gives every launch its own profile and deletes it once the process is gone", async () => {
    installed.set(chrome!, "exec");
    await bootBrowser({ browser: "chrome" });
    await bootBrowser({ browser: "chrome" });

    const [a, b] = bootElectronAppMock.mock.calls.map((c) => c[0]);
    const dirA = profileDirOf(a.extraArgs)!;
    expect(dirA).not.toBe(profileDirOf(b.extraArgs));

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      a.onProcessGone();
      vi.advanceTimersByTime(4999);
      // fs.rm completes off the event loop; give an early one time to land.
      for (const end = Date.now() + 200; Date.now() < end;) {
        await new Promise((r) => setImmediate(r));
      }
      expect(fs.existsSync(dirA)).toBe(true);
      vi.advanceTimersByTime(1);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(fs.existsSync(dirA)).toBe(false));
  });

  it("keeps a profile that a relaunched browser holds once the process is gone", async () => {
    installed.set(chrome!, "exec");
    await bootBrowser({ browser: "chrome" });
    await bootBrowser({ browser: "chrome" });
    const [relaunched, crashed] = bootElectronAppMock.mock.calls.map((c) => c[0]);
    const relaunchedDir = profileDirOf(relaunched.extraArgs)!;
    const crashedDir = profileDirOf(crashed.extraArgs)!;
    lockFor(relaunchedDir, browserOn(relaunchedDir));
    lockFor(crashedDir, DEAD_PID);

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      relaunched.onProcessGone();
      crashed.onProcessGone();
      vi.advanceTimersByTime(5000);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(fs.existsSync(crashedDir)).toBe(false));
    expect(fs.existsSync(relaunchedDir)).toBe(true);
  });

  it("records the booting tool-server's pid before launching, then the browser's", async () => {
    installed.set(chrome!, "exec");
    bootElectronAppMock.mockImplementation(async (opts: { extraArgs: string[] }) => {
      const dir = profileDirOf(opts.extraArgs)!;
      expect(fs.readFileSync(path.join(dir, "argent-browser.pid"), "utf8")).toBe(
        String(process.pid)
      );
      return { platform: "chromium", port: 9333, pid: 4242 };
    });
    await bootBrowser({ browser: "chrome" });
    expect(bootElectronAppMock).toHaveBeenCalledTimes(1);
    const dir = profileDirOf(bootElectronAppMock.mock.calls[0]![0].extraArgs)!;
    expect(fs.readFileSync(path.join(dir, "argent-browser.pid"), "utf8")).toBe("browser 4242");
  });

  describe("sweeping leftover profiles", () => {
    const platform = process.platform;
    const made: string[] = [];
    const tag = `${process.pid}-${Date.now()}`;
    const make = (name: string, pid?: number | string, root = os.tmpdir()) => {
      const dir = path.join(root, `${name}-${tag}`);
      fs.mkdirSync(dir, { recursive: true });
      if (pid !== undefined) fs.writeFileSync(path.join(dir, "argent-browser.pid"), String(pid));
      made.push(dir);
      return dir;
    };
    // Older than the relaunch grace, which spares a profile its browser just left.
    const settle = () => {
      const past = new Date(Date.now() - 60_000);
      for (const d of made) fs.utimesSync(d, past, past);
    };
    beforeEach(() => {
      fakeHome.dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweephome-"));
    });
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: platform });
      for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
      fs.rmSync(fakeHome.dir, { recursive: true, force: true });
      fakeHome.dir = "";
    });

    it("deletes only profiles that neither their tool-server nor a browser holds", async () => {
      const dead = make("argent-browser-dead", DEAD_PID);
      const crashed = make("argent-browser-crashed", DEAD_PID);
      lockFor(crashed, DEAD_PID);
      const live = make("argent-browser-live", process.pid);
      const locked = make("argent-browser-locked", DEAD_PID);
      lockFor(locked, browserOn(locked));
      const browser = make("argent-browser-browser");
      fs.writeFileSync(path.join(browser, "argent-browser.pid"), `browser ${browserOn(browser)}`);
      // A dead browser's pid that an unrelated process (this one) took over.
      const reusedLock = make("argent-browser-reusedlock", DEAD_PID);
      lockFor(reusedLock, process.pid);
      const reusedPid = make("argent-browser-reusedpid", `browser ${process.pid}`);
      const noPidFile = make("argent-browser-nopid");
      const foreign = make("other-dead", DEAD_PID);
      // pid 0 and negative pids would probe a process group, which always answers.
      const emptyPid = make("argent-browser-emptypid", "");
      const groupPid = make("argent-browser-grouppid", "-1");
      const hostOnlyLock = make("argent-browser-hostonly", DEAD_PID);
      fs.symlinkSync("some-host-", path.join(hostOnlyLock, "SingletonLock"));
      const otherSnap = make(
        "argent-browser-snap",
        DEAD_PID,
        path.join(fakeHome.dir, "snap", "brave", "common")
      );

      settle();
      const justLeft = make("argent-browser-justleft", DEAD_PID);

      installed.set(chrome!, "exec");
      await bootBrowser({ browser: "chrome" });
      const gone = [
        dead,
        crashed,
        emptyPid,
        groupPid,
        hostOnlyLock,
        otherSnap,
        reusedLock,
        reusedPid,
      ];
      await vi.waitFor(() => expect(gone.filter((d) => fs.existsSync(d))).toEqual([]));
      const kept = [live, locked, browser, noPidFile, foreign, justLeft];
      expect(kept.filter((d) => fs.existsSync(d))).toEqual(kept);
    });

    it("treats a Windows lockfile as held", async () => {
      const locked = make("argent-browser-winlocked", DEAD_PID);
      fs.writeFileSync(path.join(locked, "lockfile"), "");
      const dead = make("argent-browser-windead", DEAD_PID);
      const deadBrowser = make("argent-browser-windeadbrowser", `browser ${DEAD_PID}`);
      settle();
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env["LOCALAPPDATA"] = "C:\\L";
      installed.set(browserExecutableCandidates("chrome", "win32")[0]!, "exec");
      try {
        await bootBrowser({ browser: "chrome" });
      } finally {
        delete process.env["LOCALAPPDATA"];
      }
      await vi.waitFor(() =>
        expect([dead, deadBrowser].filter((d) => fs.existsSync(d))).toEqual([])
      );
      expect(fs.existsSync(locked)).toBe(true);
    });

    describe("when ps cannot answer", () => {
      afterEach(() => {
        psBin.path = "";
      });
      const brokenPs = () => {
        // busybox ps rejects -ww and -p: usage on stderr, exit 1, nothing on stdout.
        const script = path.join(fakeHome.dir, "busybox-ps");
        fs.writeFileSync(
          script,
          "#!/bin/sh\necho 'BusyBox v1.36 usage: ps [-o COL]' >&2\nexit 1\n"
        );
        fs.chmodSync(script, 0o755);
        return script;
      };
      for (const [name, ps] of [
        ["rejects the flags", brokenPs],
        ["is missing", () => path.join(fakeHome.dir, "no-such-ps")],
        [
          "hangs",
          () => {
            const script = path.join(fakeHome.dir, "hung-ps");
            fs.writeFileSync(script, "#!/bin/sh\nexec sleep 10\n");
            fs.chmodSync(script, 0o755);
            return script;
          },
        ],
      ] as const) {
        it(`keeps a live browser's profile when ps ${name}`, async () => {
          const browser = make("argent-browser-psbrowser");
          fs.writeFileSync(
            path.join(browser, "argent-browser.pid"),
            `browser ${browserOn(browser)}`
          );
          const locked = make("argent-browser-pslocked", DEAD_PID);
          lockFor(locked, browserOn(locked));
          const dead = make("argent-browser-psdead", `browser ${DEAD_PID}`);
          settle();
          psBin.path = ps();
          installed.set(chrome!, "exec");
          await bootBrowser({ browser: "chrome" });
          await vi.waitFor(() => expect(fs.existsSync(dead)).toBe(false));
          expect([browser, locked].filter((d) => fs.existsSync(d))).toEqual([browser, locked]);
        });
      }
    });
  });

  it("deletes its fresh profile when the pid file cannot be written", async () => {
    installed.set(chrome!, "exec");
    failPidWrite.made.length = 0;
    failPidWrite.on = true;
    try {
      await expect(bootBrowser({ browser: "chrome" })).rejects.toThrow("ENOSPC");
    } finally {
      failPidWrite.on = false;
    }
    expect(failPidWrite.made).toHaveLength(1);
    expect(fs.existsSync(failPidWrite.made[0]!)).toBe(false);
    expect(bootElectronAppMock).not.toHaveBeenCalled();
  });

  it("closes its identity-check connection whether or not the browser is ours", async () => {
    installed.set(chrome!, "exec");
    await bootBrowser({ browser: "chrome" });
    expect(cdpDisconnect).toHaveBeenCalledTimes(1);
    cdpSend.mockResolvedValue({ commandLine: "chrome --user-data-dir=/elsewhere" });
    await bootBrowser({ browser: "chrome" }).catch(() => {});
    expect(cdpDisconnect).toHaveBeenCalledTimes(2);
  });

  it("kills its browser and fails when another argent browser answers the port", async () => {
    installed.set(chrome!, "exec");
    const other = path.join(os.tmpdir(), "argent-browser-OTHER1");
    cdpSend.mockResolvedValue({ commandLine: `chrome --user-data-dir=${other}` });
    const err = await bootBrowser({ browser: "chrome", port: 9333 }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_PORT_IN_USE);
    expect((err as Error).message).toBe(
      "Browser boot: another browser took port 9333 on 127.0.0.1 while this one started. " +
        "Pass another `electronPort`, or omit it to get a free port."
    );
    expect(killMock).toHaveBeenCalledWith(9333);
  });

  it("says to retry when the lost port was picked for the caller", async () => {
    installed.set(chrome!, "exec");
    cdpSend.mockResolvedValue({ commandLine: "chrome --user-data-dir=/elsewhere" });
    const err = await bootBrowser({ browser: "chrome" }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/while this one started\. Retry\.$/);
  });

  it("treats a browser that reports no command line as not ours", async () => {
    installed.set(chrome!, "exec");
    cdpSend.mockResolvedValue({});
    const err = await bootBrowser({ browser: "chrome" }).catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_PORT_IN_USE);
    expect(killMock).toHaveBeenCalledWith(9333);
  });

  it("waits out a browser that stops answering right after it starts", async () => {
    installed.set(chrome!, "exec");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let signal: AbortSignal | undefined;
      wsUrlMock.mockImplementation(async (_port: number, s?: AbortSignal) => {
        signal = s;
        await new Promise((r) => setTimeout(r, 10_000));
        return WS_URL;
      });
      const boot = bootBrowser({ browser: "chrome" });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(boot).resolves.toMatchObject({ port: 9333 });
      // Without a signal of its own the request gives up after 5 s.
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the browser the whole identity deadline to answer SystemInfo.getInfo", async () => {
    installed.set(chrome!, "exec");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Like CDPClient.send, which gives up after its timeout (10 s by default).
      cdpSend.mockImplementation(
        (_method: string, _params: unknown, timeout = 10_000) =>
          new Promise((resolve, reject) => {
            setTimeout(() => reject(new Error(`timed out after ${timeout} ms`)), timeout);
            setTimeout(
              () =>
                resolve({
                  commandLine: `chrome ${bootElectronAppMock.mock.lastCall![0].extraArgs.join(" ")}`,
                }),
              15_000
            );
          })
      );
      const boot = bootBrowser({ browser: "chrome" });
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(boot).resolves.toMatchObject({ port: 9333 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails and kills its browser when it stays silent for the whole identity deadline", async () => {
    installed.set(chrome!, "exec");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // A wedged peer: the connect settles neither on its own nor on disconnect.
      cdpConnect.mockImplementation(() => new Promise(() => {}));
      let signal: AbortSignal | undefined;
      wsUrlMock.mockImplementation(async (_port: number, s?: AbortSignal) => {
        signal = s;
        return WS_URL;
      });
      const boot = bootBrowser({ browser: "chrome" }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(killMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const err = await boot;
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE,
        failure_stage: "browser_identity_check",
      });
      expect((err as Error).message).toBe(
        "Browser boot: the browser on port 9333 stopped answering CDP for 20000 ms right after it started."
      );
      expect(killMock).toHaveBeenCalledWith(9333);
      expect(signal!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills its browser when the identity check itself fails", async () => {
    installed.set(chrome!, "exec");
    cdpSend.mockRejectedValue(new Error("socket hang up"));
    await expect(bootBrowser({ browser: "chrome" })).rejects.toThrow("socket hang up");
    expect(killMock).toHaveBeenCalledWith(9333);
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

describe("snapName", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapname-"));
    fs.writeFileSync(path.join(dir, "snap"), "\x7fELF");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, content: string) => {
    fs.writeFileSync(path.join(dir, name), content);
    return path.join(dir, name);
  };
  const link = (name: string) => {
    fs.symlinkSync(path.join(dir, "snap"), path.join(dir, name));
    return path.join(dir, name);
  };

  it("names the snap a /snap/bin symlink runs", () => {
    expect(snapName(link("chromium"))).toBe("chromium");
    expect(snapName(link("chromium.chromedriver"))).toBe("chromium");
  });

  it("names the snap behind an alias, not the alias", () => {
    link("brave");
    fs.symlinkSync("brave", path.join(dir, "brave-browser"));
    expect(snapName(path.join(dir, "brave-browser"))).toBe("brave");
  });

  it("names the snap a wrapper script execs", () => {
    expect(snapName(file("chromium-browser", '#!/bin/sh\nexec /snap/bin/chromium "$@"\n'))).toBe(
      "chromium"
    );
  });

  it("is null for a script or binary that is not a snap", () => {
    expect(snapName(file("google-chrome", '#!/bin/bash\nexec -a "$0" "$HERE/chrome" "$@"\n'))).toBe(
      null
    );
    expect(snapName(file("chrome", "\x7fELF /snap/bin/chromium"))).toBe(null);
    expect(snapName(path.join(dir, "missing"))).toBe(null);
    fs.symlinkSync("loop-b", path.join(dir, "loop-a"));
    fs.symlinkSync("loop-a", path.join(dir, "loop-b"));
    expect(snapName(path.join(dir, "loop-a"))).toBe(null);
  });
});

describe("bootBrowser with a snap browser", () => {
  const platform = process.platform;
  const env = { ...process.env };
  let bin: string;
  beforeEach(() => {
    fakeHome.dir = fs.mkdtempSync(path.join(os.tmpdir(), "snaphome-"));
    bin = path.join(fakeHome.dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "snap"), "\x7fELF", { mode: 0o755 });
    fs.symlinkSync(path.join(bin, "snap"), path.join(bin, "chromium"));
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env = { ...env, PATH: bin };
    bootElectronAppMock.mockReset();
    bootElectronAppMock.mockResolvedValue({ platform: "chromium", port: 9333, pid: process.pid });
    cdpSend.mockImplementation(async () => ({
      commandLine: `chromium ${bootElectronAppMock.mock.lastCall![0].extraArgs.join(" ")}`,
    }));
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    process.env = env;
    fs.rmSync(fakeHome.dir, { recursive: true, force: true });
    fakeHome.dir = "";
  });

  it("keeps the profile in the snap's own dir, which the snap and we both see", async () => {
    await bootBrowser({ browser: "chromium" });
    const args: string[] = bootElectronAppMock.mock.calls[0]![0].extraArgs;
    const dir = args[0]!.slice("--user-data-dir=".length);
    expect(path.dirname(dir)).toBe(path.join(fakeHome.dir, "snap", "chromium", "common"));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });
});
