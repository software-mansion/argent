import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => mockExecFile(...args) };
});

import { launchSimulatorApp } from "../src/utils/simulator-app-launch";
import { PS_BIN } from "../src/utils/vega-process";

const APP = "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app";
const EXECUTABLE = `${APP}/Contents/MacOS/Simulator`;
const CORE_SIMULATOR_INFO_PLIST =
  "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/Info.plist";
// Always running beside the app on a real host, and also named like it.
const CORE_SIMULATOR_SERVICE =
  "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/XPCServices/com.apple.CoreSimulator.CoreSimulatorService.xpc/Contents/MacOS/com.apple.CoreSimulator.CoreSimulatorService";

let home: string;
let originalHome: string | undefined;
let coreSimulatorBuild: string;
let appBuild: string;
// Whether the app process is up now, and whether `launch` leaves it up.
let appRunning: boolean;
let launchedAppStays: boolean;
let psExecutable: string;
// Other processes in the list, beside launchd and CoreSimulatorService.
let psOthers: string[];
// Processes of other users logged in to the Mac.
let psOtherUsers: string[];
let psFails: boolean;
let launch: Mock<() => Promise<unknown>>;

const callsTo = (bin: string) => mockExecFile.mock.calls.filter(([file]) => file === bin);
const psCalls = () => callsTo(PS_BIN).length;
const verdicts = () =>
  JSON.parse(fs.readFileSync(path.join(home, ".argent", "simulator-app-launch.json"), "utf8"));

// Runs a launch to completion, stepping past the post-launch watch.
async function run(app = APP): Promise<boolean> {
  const result = launchSimulatorApp(app, launch);
  await vi.advanceTimersByTimeAsync(10_000);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sim-app-launch-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  coreSimulatorBuild = "1166";
  appBuild = "1042.1";
  appRunning = false;
  launchedAppStays = false;
  psExecutable = EXECUTABLE;
  psOthers = [];
  psOtherUsers = [];
  psFails = false;
  launch = vi.fn(async (): Promise<void> => {
    appRunning = launchedAppStays;
  });
  mockExecFile.mockReset().mockImplementation((...args: unknown[]) => {
    const [file, argv] = args as [string, string[]];
    const callback = args[args.length - 1] as (err: Error | null, out?: unknown) => void;
    let stdout = "";
    if (file === "plutil") {
      if (argv[1] !== "CFBundleVersion") {
        callback(new Error(`no ${argv[1]}`));
        return {};
      }
      const plist = argv.at(-1)!;
      if (plist === CORE_SIMULATOR_INFO_PLIST) stdout = `${coreSimulatorBuild}\n`;
      else if (plist.endsWith("/Simulator.app/Contents/Info.plist")) stdout = `${appBuild}\n`;
      else {
        callback(new Error(`no ${plist}`));
        return {};
      }
    } else if (file === PS_BIN) {
      if (psFails) {
        callback(new Error("ps failed"));
        return {};
      }
      // Without -x, ps leaves out processes with no terminal, as LaunchServices
      // starts apps; without -a, those of other users.
      const [flags, format] = argv as [string, string];
      const app = appRunning && flags.includes("x") ? [psExecutable] : [];
      const otherUsers = flags.includes("a") ? psOtherUsers : [];
      stdout =
        format === "comm="
          ? ["/sbin/launchd", CORE_SIMULATOR_SERVICE, ...psOthers, ...otherUsers, ...app, ""].join(
              "\n"
            )
          : "";
    }
    callback(null, { stdout, stderr: "" });
    return {};
  });
});

afterEach(() => {
  vi.useRealTimers();
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("launchSimulatorApp", () => {
  it("stops launching an app that dies right after launch", async () => {
    await expect(run()).resolves.toBe(false);
    expect(verdicts()).toEqual({ [`${APP} 1042.1 / CoreSimulator 1166`]: "crashes" });

    await expect(run()).resolves.toBe(false);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("keeps launching an app that stays up, without watching it again", async () => {
    launchedAppStays = true;
    await expect(run()).resolves.toBe(true);
    expect(verdicts()).toEqual({ [`${APP} 1042.1 / CoreSimulator 1166`]: "runs" });
    const watched = psCalls();

    await expect(run()).resolves.toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(psCalls()).toBe(watched);
  });

  it("records a crash at the end of the watch window", async () => {
    launchedAppStays = true;
    const result = launchSimulatorApp(APP, launch);
    await vi.advanceTimersByTimeAsync(4_900);
    appRunning = false;
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBe(false);
    expect(verdicts()).toEqual({ [`${APP} 1042.1 / CoreSimulator 1166`]: "crashes" });
  });

  it("returns as soon as the launched app is gone", async () => {
    let settled = false;
    const result = launchSimulatorApp(APP, launch).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    await expect(result).resolves.toBe(false);
  });

  it("stops watching once the watch window has passed", async () => {
    launchedAppStays = true;
    const result = launchSimulatorApp(APP, launch);
    await vi.advanceTimersByTimeAsync(5_100);
    appRunning = false;

    await expect(result).resolves.toBe(true);
    expect(verdicts()).toEqual({ [`${APP} 1042.1 / CoreSimulator 1166`]: "runs" });
  });

  it("launches a crashing app once for parallel callers", async () => {
    const results = Promise.all([launchSimulatorApp(APP, launch), launchSimulatorApp(APP, launch)]);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(results).resolves.toEqual([false, false]);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("retries after the installed CoreSimulator changes", async () => {
    await run();
    coreSimulatorBuild = "1200";
    launchedAppStays = true;

    await expect(run()).resolves.toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(verdicts()).toEqual({
      [`${APP} 1042.1 / CoreSimulator 1166`]: "crashes",
      [`${APP} 1042.1 / CoreSimulator 1200`]: "runs",
    });
  });

  it("retries after the Simulator.app build changes", async () => {
    await run();
    appBuild = "1050";
    launchedAppStays = true;

    await expect(run()).resolves.toBe(true);
    expect(verdicts()).toEqual({
      [`${APP} 1042.1 / CoreSimulator 1166`]: "crashes",
      [`${APP} 1050 / CoreSimulator 1166`]: "runs",
    });
  });

  it("keeps a separate record per Simulator.app", async () => {
    const other = "/Applications/Xcode-26.app/Contents/Developer/Applications/Simulator.app";
    await run();
    launchedAppStays = true;
    psExecutable = `${other}/Contents/MacOS/Simulator`;

    await expect(run(other)).resolves.toBe(true);
    expect(verdicts()).toEqual({
      [`${APP} 1042.1 / CoreSimulator 1166`]: "crashes",
      [`${other} 1042.1 / CoreSimulator 1166`]: "runs",
    });
  });

  it("does not mistake another Simulator.app for the launched one", async () => {
    psOthers = [
      "/Applications/Xcode-26.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator",
      `/Volumes/Backup${EXECUTABLE}`,
    ];

    await run();
    expect(verdicts()).toEqual({ [`${APP} 1042.1 / CoreSimulator 1166`]: "crashes" });
  });

  it("does not take another user's instance for the launched one", async () => {
    psOtherUsers = [EXECUTABLE];

    await expect(run()).resolves.toBe(false);
    expect(verdicts()).toEqual({ [`${APP} 1042.1 / CoreSimulator 1166`]: "crashes" });
  });

  it("does not judge an instance that was already running", async () => {
    appRunning = true;
    launchedAppStays = true;

    await expect(run()).resolves.toBe(true);
    expect(fs.existsSync(path.join(home, ".argent", "simulator-app-launch.json"))).toBe(false);

    appRunning = false;
    launchedAppStays = false;
    await run();
    expect(verdicts()).toEqual({ [`${APP} 1042.1 / CoreSimulator 1166`]: "crashes" });
  });

  it("matches the running app whatever case ps prints its path in", async () => {
    launchedAppStays = true;
    psExecutable = EXECUTABLE.toLowerCase();

    await run();
    expect(verdicts()).toEqual({ [`${APP} 1042.1 / CoreSimulator 1166`]: "runs" });
  });

  it("matches the running app whatever Unicode form ps prints its path in", async () => {
    const app =
      "/Users/me/Zażółć/Xcode.app/Contents/Developer/Applications/Simulator.app".normalize("NFC");
    launchedAppStays = true;
    psExecutable = `${app}/Contents/MacOS/Simulator`.normalize("NFD");

    await run(app);
    expect(verdicts()).toEqual({ [`${app} 1042.1 / CoreSimulator 1166`]: "runs" });
  });

  it("runs ps in a UTF-8 locale, so it prints non-ASCII paths unescaped", async () => {
    await run();

    for (const call of callsTo(PS_BIN)) {
      expect(call[2]).toMatchObject({ env: expect.objectContaining({ LC_ALL: "en_US.UTF-8" }) });
    }
  });

  it("bounds the plutil and ps calls with a timeout", async () => {
    await run();

    const calls = [...callsTo("plutil"), ...callsTo(PS_BIN)];
    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) expect(call[2]).toMatchObject({ timeout: 5_000 });
  });

  it("records nothing when the process list cannot be read", async () => {
    psFails = true;

    await expect(run()).resolves.toBe(true);
    expect(fs.existsSync(path.join(home, ".argent", "simulator-app-launch.json"))).toBe(false);
  });

  it("does not judge an instance it could not check for before the launch", async () => {
    appRunning = true;
    launchedAppStays = true;
    psFails = true;
    launch.mockImplementation(async () => {
      psFails = false;
    });

    await expect(run()).resolves.toBe(true);
    expect(fs.existsSync(path.join(home, ".argent", "simulator-app-launch.json"))).toBe(false);
  });

  it("records nothing when the process list cannot be read during the watch", async () => {
    launch.mockImplementation(async () => {
      psFails = true;
    });

    await expect(run()).resolves.toBe(true);
    expect(fs.existsSync(path.join(home, ".argent", "simulator-app-launch.json"))).toBe(false);
  });

  it("swaps the record in with a rename, leaving no temporary file", async () => {
    const rename = vi.spyOn(fs, "renameSync");
    const file = path.join(home, ".argent", "simulator-app-launch.json");

    await run();
    expect(rename).toHaveBeenCalledWith(`${file}.${process.pid}.tmp`, file);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["simulator-app-launch.json"]);
    rename.mockRestore();
  });

  it("still reports the launch when the record cannot be written", async () => {
    fs.writeFileSync(path.join(home, ".argent"), "not a directory");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(run()).resolves.toBe(true);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("could not record"));
    stderr.mockRestore();
  });

  it("removes the temporary file when the record cannot be replaced", async () => {
    const file = path.join(home, ".argent", "simulator-app-launch.json");
    fs.mkdirSync(file, { recursive: true });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(run()).resolves.toBe(true);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("could not record"));
    expect(fs.readdirSync(path.dirname(file))).toEqual(["simulator-app-launch.json"]);
    stderr.mockRestore();
  });

  it("treats an unreadable record as empty", async () => {
    fs.mkdirSync(path.join(home, ".argent"));
    fs.writeFileSync(path.join(home, ".argent", "simulator-app-launch.json"), "null");

    await expect(run()).resolves.toBe(false);
    expect(verdicts()).toEqual({ [`${APP} 1042.1 / CoreSimulator 1166`]: "crashes" });
  });

  it("launches without a record when the builds cannot be read", async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      (args[args.length - 1] as (err: Error) => void)(new Error("plutil failed"));
      return {};
    });

    await expect(run()).resolves.toBe(true);
    await expect(run()).resolves.toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(home, ".argent", "simulator-app-launch.json"))).toBe(false);
  });

  it("propagates a failed launch without recording a verdict", async () => {
    launch.mockRejectedValue(new Error("LaunchServices error"));

    await expect(launchSimulatorApp(APP, launch)).rejects.toThrow("LaunchServices error");
    expect(fs.existsSync(path.join(home, ".argent", "simulator-app-launch.json"))).toBe(false);
  });
});
