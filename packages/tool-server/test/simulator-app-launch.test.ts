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

const APP = "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app";
const EXECUTABLE = `${APP}/Contents/MacOS/Simulator`;

let home: string;
let originalHome: string | undefined;
let coreSimulatorBuild: string;
let appRunning: boolean;
let launch: Mock<() => Promise<unknown>>;

const psCalls = () => mockExecFile.mock.calls.filter(([file]) => file === "ps").length;
const verdicts = () =>
  JSON.parse(fs.readFileSync(path.join(home, ".argent", "simulator-app-launch.json"), "utf8"));

// Runs a launch to completion, stepping past the post-launch watch.
async function run(): Promise<boolean> {
  const result = launchSimulatorApp(APP, launch);
  await vi.advanceTimersByTimeAsync(5_000);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sim-app-launch-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  coreSimulatorBuild = "1166";
  appRunning = false;
  launch = vi.fn(async (): Promise<unknown> => undefined);
  mockExecFile.mockReset().mockImplementation((...args: unknown[]) => {
    const [file, argv] = args as [string, string[]];
    const callback = args[args.length - 1] as (err: Error | null, out?: unknown) => void;
    let stdout = "";
    if (file === "plutil") {
      stdout = argv.at(-1)!.startsWith(APP) ? "1042.1\n" : `${coreSimulatorBuild}\n`;
    } else if (file === "ps") {
      stdout = `/sbin/launchd\n${appRunning ? `${EXECUTABLE}\n` : ""}`;
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
    await expect(run()).resolves.toBe(true);
    expect(verdicts()).toEqual({ [`${APP} 1042.1 / CoreSimulator 1166`]: "crashes" });

    await expect(run()).resolves.toBe(false);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("keeps launching an app that stays up, without watching it again", async () => {
    appRunning = true;
    await expect(run()).resolves.toBe(true);
    expect(verdicts()).toEqual({ [`${APP} 1042.1 / CoreSimulator 1166`]: "runs" });
    const watched = psCalls();

    await expect(run()).resolves.toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(psCalls()).toBe(watched);
  });

  it("records a crash at the end of the watch window", async () => {
    appRunning = true;
    const result = launchSimulatorApp(APP, launch);
    await vi.advanceTimersByTimeAsync(1_900);
    appRunning = false;
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toBe(true);
    expect(verdicts()).toEqual({ [`${APP} 1042.1 / CoreSimulator 1166`]: "crashes" });
  });

  it("launches a crashing app once for parallel callers", async () => {
    const results = Promise.all([launchSimulatorApp(APP, launch), launchSimulatorApp(APP, launch)]);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(results).resolves.toEqual([true, false]);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("retries after the installed CoreSimulator changes", async () => {
    await run();
    coreSimulatorBuild = "1200";
    appRunning = true;

    await expect(run()).resolves.toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
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
